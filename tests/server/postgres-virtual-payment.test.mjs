import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {randomUUID,createHmac} from 'node:crypto';
import {request} from 'node:http';
import {PGlite} from '@electric-sql/pglite';
import {createPostgresCore} from '../../server/postgres-core.mjs';
import {createPostgresApplication} from '../../server/postgres-app.mjs';
import {initializeFreshDatabase,verifyFreshDatabase} from '../../server/postgres-fresh.mjs';
import {createPostgresPaymentRuntime} from '../../server/postgres-runtime.mjs';
import {createPostgresVirtualPayment,initializeVirtualPaymentSchema,verifyVirtualPaymentSchema,virtualPaymentTable} from '../../server/postgres-virtual-payment.mjs';
import {createWechatVirtualPay} from '../../server/wechat-virtual-pay.mjs';
import {createWechatAdapter} from '../../server/wechat.mjs';
import {initializeGrantDatabase} from '../../server/collaboration/grant-migration.mjs';
import {grantPaymentConflict} from '../../server/collaboration/grant-host.mjs';

const appId='wx47d5e3e20fd77f65',schema='club_migration_virtual_test';
const legal={id:'virtual-approved-fixture',status:'approved',requireHongKongConsent:false,
  documents:['privacy','terms'].map(id=>({id,version:'fixture',sha256:'a'.repeat(64)}))};
const consent={accepted:true,releaseId:legal.id};
const response=(data,status=200)=>new Response(JSON.stringify(data),{status});
const tick=()=>new Promise(resolve=>setImmediate(resolve));
async function bounded(promise,label,timeoutMs=5000){
  let timer;
  try{return await Promise.race([promise,new Promise((_,reject)=>{timer=setTimeout(()=>reject(Error('Timed out: '+label)),timeoutMs);})]);}
  finally{clearTimeout(timer);}
}
const config=()=>({enabled:true,status:'approved',appId,offerId:'isolated-offer',env:1,
  appKeys:{0:'isolated-live-key',1:'isolated-sandbox-key'},
  products:{basic:{productId:'isolated-basic',goodsPriceCents:36500},star:{productId:'isolated-star',goodsPriceCents:365000}}});

async function fixture(t,{migrate=true,grantConflicts=false}={}){
  const pg=new PGlite({parsers:{20:v=>BigInt(v)}});let server;
  t.after(async()=>{
    if(server){server.stopMaintenance?.();server.closeAllConnections();await bounded(new Promise(resolve=>server.close(resolve)),'HTTP cleanup');}
    await pg.close();
  });
  await pg.waitReady;
  let tail=Promise.resolve();
  const pool={connect:async()=>{const previous=tail;let release;tail=new Promise(resolve=>{release=resolve;});await previous;
    return {query:async(sql,args)=>!args&&sql.includes(';')?(await pg.exec(sql)).at(-1):pg.query(sql,args),release};}};
  await initializeFreshDatabase(pool,{schema});if(migrate)await initializeVirtualPaymentSchema(pool,{schema});
  if(grantConflicts)await initializeGrantDatabase(pool,{schema});
  await pg.exec(`SET search_path TO ${schema}`);
  let offset=0,responder,codeGate,tokenResponder;const clock=()=>Date.now()+offset,upstream=[],trades=new Map(),rewards={};
  const virtualConfig=config();
  const fetchImpl=async(url,options)=>{
    const parsed=new URL(url);upstream.push({url:parsed,options});
    assert.equal(parsed.origin,'https://api.weixin.qq.com');
    if(parsed.pathname==='/sns/jscode2session'){
      assert.equal(parsed.searchParams.get('appid'),appId);const code=parsed.searchParams.get('js_code');
      if(codeGate&&code.startsWith('pay-'))await codeGate();
      return response({openid:'openid_'+code.replace(/^pay-/,''),session_key:'ISOLATED_SESSION_KEY',unionid:'must-not-persist'});
    }
    const body=JSON.parse(options.body);
    if(parsed.pathname==='/cgi-bin/stable_token'){
      assert.deepEqual(body,{grant_type:'client_credential',appid:appId,secret:'ISOLATED_APP_SECRET',force_refresh:false});
      assert.equal(parsed.search,'');if(tokenResponder)return tokenResponder();return response({access_token:'isolated_access_token',expires_in:7200});
    }
    if(parsed.pathname==='/xpay/query_order'){
      assert.equal(parsed.searchParams.get('pay_sig'),createHmac('sha256','isolated-sandbox-key').update(parsed.pathname+'&'+options.body).digest('hex'));
      assert.equal(body.env,1);
      if(responder)return responder(parsed,body);
      const remote=trades.get(body.order_id);assert.ok(remote,'test must explicitly provide the platform order');
      return response({errcode:0,order:{...remote}});
    }
    assert.equal(parsed.pathname,'/xpay/notify_provide_goods');assert.equal(parsed.searchParams.has('pay_sig'),false);
    assert.deepEqual([...parsed.searchParams.keys()],['access_token']);assert.equal(parsed.searchParams.get('access_token'),'isolated_access_token');
    assert.deepEqual(Object.keys(body).sort(),['env','order_id']);assert.equal(body.env,1);
    if(responder)return responder(parsed,body);
    const remote=trades.get(body.order_id);remote.status=4;return new Response('',{status:200});
  };
  const wechat=createWechatAdapter({appId,appSecret:'ISOLATED_APP_SECRET',fetchImpl,clock});
  const provider=createWechatVirtualPay(virtualConfig,{fetchImpl,getAccessToken:input=>wechat.getAccessToken(input),clock});
  const core=createPostgresCore(pool,{schema,appId,legal,rewards});
  const make=()=>createPostgresVirtualPayment(pool,{schema,appId,legal,provider,wechat,core,rewards,clock,...(grantConflicts?{grantPaymentConflict}:{})});
  let service=make();
  server=createPostgresApplication({core,wechat,virtualPayment:service,paymentChannel:'virtual',autoRecover:false,hosts:['127.0.0.1'],mode:'fresh'});
  await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));
  const call=(path,body,token,target=server)=>new Promise((resolve,reject)=>{
    const req=request({hostname:'127.0.0.1',port:target.address().port,path:'/api'+path,method:body===undefined?'GET':'POST',
      headers:{Host:'127.0.0.1','Content-Type':'application/json','X-Club-Request':'1',...(token?{Authorization:'Bearer '+token}:{})}},res=>{
      const chunks=[];res.on('data',value=>chunks.push(value));res.on('error',reject);
      res.on('end',()=>{try{resolve({status:res.statusCode,data:JSON.parse(Buffer.concat(chunks).toString())});}catch(error){reject(error);}});
    });req.setTimeout(10000,()=>req.destroy(Error('HTTP test request timed out')));req.on('error',reject);req.end(body===undefined?undefined:JSON.stringify(body));
  });
  const account=async(name,{accept=true}={})=>{
    const session=await core.login({code:name,consent:true,legalConsent:consent},wechat),user=await core.authenticate(session.accessToken);
    const order=await core.createOrder(user,{planId:'basic',consent:true,legalConsent:consent,form:{name:'隔离测试',phone:'13800000000',city:'上海'}},randomUUID());
    if(accept)await core.acceptPayment(user,order.id,{...consent,detailsConfirmed:true});
    const remote={order_id:order.id.slice(2),env_type:2,status:1,order_type:0,order_fee:36500,paid_fee:0,left_fee:0,
      paid_time:0,provide_time:0,wx_order_id:'wechat_'+order.id.slice(2),biz_meta:'opaque',token:'must-not-return-provider-token'};
    trades.set(remote.order_id,remote);return {name,user,order,token:session.accessToken,remote};
  };
  const paid=e=>Object.assign(e.remote,{status:2,paid_fee:36500,left_fee:36500,paid_time:Math.floor(Date.now()/1000)});
  const count=async table=>Number((await pg.query(`SELECT count(*) AS n FROM ${table}`)).rows[0].n);
  return {pg,pool,core,wechat,provider,service,make,server,call,account,paid,count,upstream,trades,rewards,virtualConfig,fetchImpl,
    advance:ms=>{offset+=ms;},respond:fn=>{responder=fn;},gate:fn=>{codeGate=fn;},tokenResponse:fn=>{tokenResponder=fn;}};
}

test('prepay token failure returns no new cashier parameters or issued state, and the same pending order can retry',async t=>{
  const f=await fixture(t),a=await f.account('token_retry'),route='/orders/'+a.order.id+'/payment';
  f.tokenResponse(()=>response({errcode:40164,errmsg:'ISOLATED_APP_SECRET isolated_access_token https://private.example/'}));
  const failed=await f.call(route,{code:'pay-token_retry'},a.token);assert.equal(failed.status,503);assert.equal(failed.data.payment,undefined);
  for(const secret of ['ISOLATED_APP_SECRET','isolated_access_token','https://private.example'])assert.equal(JSON.stringify(failed).includes(secret),false);
  assert.equal(await f.count(virtualPaymentTable),0);assert.equal(await f.count('memberships'),0);assert.equal(await f.count('payment_receipts'),0);
  assert.equal((await f.pg.query("SELECT 1 FROM settings WHERE key LIKE 'virtual_payment_attempt:%'")).rows.length,0);
  assert.equal((await f.pg.query("SELECT 1 FROM audit_log WHERE action='payment.virtual_prepared'")).rows.length,0);
  assert.equal(f.upstream.filter(r=>r.url.pathname.startsWith('/xpay/')||r.url.searchParams.get('js_code')==='pay-token_retry').length,0);
  assert.equal((await f.core.order(a.user,a.order.id)).status,'pending');f.tokenResponse(undefined);
  const retried=await f.call(route,{code:'pay-token_retry'},a.token);assert.equal(retried.status,200);assert.equal(retried.data.payment.mode,'short_series_goods');assert.equal(await f.count(virtualPaymentTable),1);
});

test('missing availability cannot issue parameters, but a failing new-prepay check never blocks issued-order sync and recovery',async t=>{
  const f=await fixture(t),a=await f.account('existing_token');
  const service=provider=>createPostgresVirtualPayment(f.pool,{schema,appId,legal,provider,wechat:f.wechat,core:f.core,clock:()=>Date.now()});
  const unchecked=service({...f.provider,checkAvailability:undefined});await assert.rejects(unchecked.prepare(a.user,a.order.id,{code:'pay-existing_token'}),error=>error.status===503&&error.code==='VIRTUAL_TOKEN_UNAVAILABLE');assert.equal(await f.count(virtualPaymentTable),0);
  await f.service.prepare(a.user,a.order.id,{code:'pay-existing_token'});f.paid(a);
  const unavailable=service({...f.provider,checkAvailability:async()=>{throw Error('isolated_access_token URL');}});
  await assert.rejects(unavailable.checkAvailability(),error=>error.code==='VIRTUAL_TOKEN_UNAVAILABLE'&&!error.message.includes('isolated_access_token'));
  f.respond(url=>url.pathname==='/xpay/query_order'?response({errcode:0,order:{...a.remote}}):response({errcode:-1}));
  await unavailable.sync(a.user,a.order.id);assert.equal(await f.count('memberships'),1);assert.equal(await f.count('payment_receipts'),1);
  assert.equal((await f.pg.query(`SELECT delivery_state FROM ${virtualPaymentTable}`)).rows[0].delivery_state,'pending');
  f.respond(undefined);await f.pg.query(`UPDATE ${virtualPaymentTable} SET next_check_at='2000-01-01T00:00:00.000Z'`);
  assert.equal((await unavailable.recover()).checked,1);assert.equal((await f.pg.query(`SELECT delivery_state FROM ${virtualPaymentTable}`)).rows[0].delivery_state,'confirmed');assert.equal(await f.count('payment_receipts'),1);
});

test('explicit migration is additive, idempotent, hash checked; missing or unapproved virtual config stays disabled',async t=>{
  const f=await fixture(t,{migrate:false});assert.equal((await verifyFreshDatabase(f.pool,{schema})).initialized,true);
  await assert.rejects(verifyVirtualPaymentSchema(f.pool,{schema}),/尚未显式升级/);
  const base={schema,appId,legal};
  for(const virtualPayment of [undefined,{enabled:false},{enabled:true,status:'draft'}]){
    const runtime=await createPostgresPaymentRuntime({connect:()=>{throw Error('must not read DB');}},{...base,virtualPayment},f.wechat,f.core,{fetchImpl:f.fetchImpl});
    assert.equal(runtime.virtualPayment.configured,false);assert.equal(runtime.paymentChannel,'virtual');
  }
  const approved={...base,virtualPayment:f.virtualConfig};
  await assert.rejects(createPostgresPaymentRuntime(f.pool,approved,f.wechat,f.core,{fetchImpl:f.fetchImpl}),/尚未显式升级/);
  assert.deepEqual(await initializeVirtualPaymentSchema(f.pool,{schema}),{initialized:true,reused:false});
  assert.deepEqual(await initializeVirtualPaymentSchema(f.pool,{schema}),{initialized:true,reused:true});
  assert.equal((await verifyFreshDatabase(f.pool,{schema})).initialized,true);
  assert.equal((await createPostgresPaymentRuntime(f.pool,approved,f.wechat,f.core,{fetchImpl:f.fetchImpl})).virtualPayment.configured,true);
  const wrong=structuredClone(approved);wrong.virtualPayment.products.basic.goodsPriceCents=1;
  await assert.rejects(createPostgresPaymentRuntime(f.pool,wrong,f.wechat,f.core,{fetchImpl:f.fetchImpl}));
  await f.pg.query("UPDATE settings SET value='tampered' WHERE key='virtual-payment-schema-v1'");
  await assert.rejects(verifyFreshDatabase(f.pool,{schema}),/迁移记录不一致/);
  assert.equal(f.upstream.length,0);
});

test('HTTP prepare requires owner, current payment consent, fresh matching OpenID and no client price/config fields',async t=>{
  const f=await fixture(t),a=await f.account('owner'),b=await f.account('other'),c=await f.account('no_consent',{accept:false});
  const route='/orders/'+a.order.id+'/payment';
  assert.equal((await f.call(route,{code:'pay-owner'},b.token)).status,404);
  assert.equal((await f.call(route,{code:'pay-other'},a.token)).status,403);
  for(const input of [{},{code:'pay-owner',amount:1},{code:'pay-owner',env:0},{code:'pay-owner',sessionKey:'fake'}])
    assert.equal((await f.call(route,input,a.token)).status,400);
  assert.equal((await f.call('/orders/'+c.order.id+'/payment',{code:'pay-no_consent'},c.token)).status,409);
  assert.equal(await f.count(virtualPaymentTable),0);assert.equal(await f.count('memberships'),0);
  const result=await f.call(route,{code:'pay-owner'},a.token);assert.equal(result.status,200,JSON.stringify(result));
  assert.equal(result.data.paymentChannel,'virtual');assert.equal(result.data.payment.mode,'short_series_goods');
  assert.equal(JSON.parse(result.data.payment.signData).goodsPrice,36500);
  assert.equal(await f.count('memberships'),0);assert.equal(await f.count('payment_receipts'),0);
  const persisted=(await f.pg.query(`SELECT snapshot_json FROM ${virtualPaymentTable}`)).rows[0].snapshot_json;
  for(const secret of ['ISOLATED_SESSION_KEY','ISOLATED_APP_SECRET','isolated_access_token','sessionKey','unionid']){
    assert.equal(JSON.stringify(result).includes(secret),false);assert.equal(persisted.includes(secret),false);
  }
  assert.equal((await f.call(route,{code:'pay-owner'},a.token)).status,409);assert.equal(await f.count(virtualPaymentTable),1);
  await assert.rejects(f.core.preparePayment(a.user,a.order.id),/虚拟支付尝试/);
});

test('disabled payment channel preserves issued pending orders; authoritative close permits cancellation after recovery',async t=>{
  const f=await fixture(t),a=await f.account('cancel');
  assert.equal((await f.call('/orders/'+a.order.id+'/payment',{code:'pay-cancel'},a.token)).status,200);
  assert.equal((await f.core.order(a.user,a.order.id)).status,'pending');
  await assert.rejects(f.core.cancelOrder(a.user,a.order.id),/保留订单/);
  const disabled=createPostgresApplication({core:f.core,wechat:f.wechat,paymentChannel:'virtual',payment:{configured:false},hosts:['127.0.0.1']});
  await new Promise(resolve=>disabled.listen(0,'127.0.0.1',resolve));
  t.after(()=>{disabled.stopMaintenance?.();disabled.closeAllConnections();return bounded(new Promise(resolve=>disabled.close(resolve)),'disabled HTTP cleanup');});
  for(const path of ['/health','/plans','/me']){
    const result=await f.call(path,undefined,a.token,disabled);
    assert.equal(result.status,200);assert.equal(result.data.paymentReady,false);assert.equal(result.data.paymentChannel,'virtual');
  }
  const status=await f.call('/orders/'+a.order.id+'/payment-status',undefined,a.token,disabled);
  assert.equal(status.data.enabled,false);assert.equal(status.data.order.status,'pending');
  const upstreamCount=f.upstream.length;
  assert.equal((await f.call('/orders/'+a.order.id+'/payment',{code:'pay-cancel'},a.token,disabled)).status,503);
  assert.equal((await f.call('/orders/'+a.order.id+'/cancel',{},a.token,disabled)).status,409);
  assert.equal(f.upstream.length,upstreamCount);assert.equal((await f.core.order(a.user,a.order.id)).status,'pending');
  a.remote.status=6;
  assert.equal((await f.call('/orders/'+a.order.id+'/cancel',{},a.token)).data.order.status,'cancelled');
  assert.equal(await f.count('memberships'),0);
  assert.equal((await f.pg.query('SELECT value FROM settings WHERE key=$1',['virtual_application_cancelled:'+a.order.id])).rows.length,0);
  assert.equal((await f.pg.query(`SELECT state FROM ${virtualPaymentTable}`)).rows[0].state,'closed');
});

test('authoritative unpaid cancellation retains the attempt; late real payment is reconciled once without membership or rewards',async t=>{
  const f=await fixture(t);let rewards=0;f.rewards.recordPaidOrderInTransaction=async()=>{rewards++;};
  for(const status of [0,1]){
    const name='cancel_unpaid_'+status,a=await f.account(name);await f.service.prepare(a.user,a.order.id,{code:'pay-'+name});
    a.remote.status=status;
    for(let retry=0;retry<2;retry++)assert.equal((await f.call('/orders/'+a.order.id+'/cancel',{},a.token)).data.order.status,'cancelled');
    assert.equal((await f.pg.query('SELECT value FROM settings WHERE key=$1',['virtual_application_cancelled:'+a.order.id])).rows[0].value,'local');
    assert.equal((await f.pg.query(`SELECT state FROM ${virtualPaymentTable} WHERE order_id=$1`,[a.order.id])).rows[0].state,'issued');
    const audits=(await f.pg.query("SELECT detail FROM audit_log WHERE action='order.cancelled' AND target_id=$1",[a.order.id])).rows;
    assert.equal(audits.length,1);assert.equal(JSON.parse(audits[0].detail).localOnly,true);
    f.paid(a);
    for(let retry=0;retry<2;retry++)assert.equal((await f.call('/orders/'+a.order.id+'/payment-status',undefined,a.token)).data.order.status,'cancelled');
    const receipts=(await f.pg.query('SELECT outcome FROM payment_receipts WHERE order_id=$1',[a.order.id])).rows;
    assert.deepEqual(receipts,[{outcome:'needs_reconciliation'}]);
    const attempt=(await f.pg.query(`SELECT state,delivery_state FROM ${virtualPaymentTable} WHERE order_id=$1`,[a.order.id])).rows[0];
    assert.deepEqual(attempt,{state:'reconciliation',delivery_state:'blocked'});
  }
  assert.equal(await f.count('memberships'),0);assert.equal(rewards,0);
  assert.equal(f.upstream.filter(row=>row.url.pathname==='/xpay/notify_provide_goods').length,0);
});

test('unknown or failed authoritative queries cannot cancel an issued order or erase its recovery marker',async t=>{
  const f=await fixture(t),a=await f.account('cancel_unknown');await f.service.prepare(a.user,a.order.id,{code:'pay-cancel_unknown'});
  for(const [status,httpStatus] of [[11,502],[9,409]]){
    a.remote.status=status;assert.equal((await f.call('/orders/'+a.order.id+'/cancel',{},a.token)).status,httpStatus);
    assert.equal((await f.core.order(a.user,a.order.id)).status,'pending');
  }
  f.respond(()=>response({errcode:-1,errmsg:'isolated_access_token'}));
  const failed=await f.call('/orders/'+a.order.id+'/cancel',{},a.token);assert.equal(failed.status,502);assert.equal(JSON.stringify(failed).includes('isolated_access_token'),false);
  assert.equal((await f.core.order(a.user,a.order.id)).status,'pending');
  assert.equal((await f.pg.query('SELECT value FROM settings WHERE key=$1',['virtual_payment_attempt:'+a.order.id])).rows[0].value,'issued');
  assert.equal((await f.pg.query('SELECT value FROM settings WHERE key=$1',['virtual_application_cancelled:'+a.order.id])).rows.length,0);
  assert.equal(await f.count('memberships'),0);assert.equal(await f.count('payment_receipts'),0);
});

test('authority query activates once and persistent delivery survives provider failure, process recreation and duplicate status polling',async t=>{
  const f=await fixture(t),a=await f.account('restore');await f.service.prepare(a.user,a.order.id,{code:'pay-restore'});f.paid(a);
  f.respond((url)=>url.pathname==='/xpay/query_order'?response({errcode:0,order:{...a.remote}}):response({errcode:-1,errmsg:'ISOLATED_SESSION_KEY'}));
  const results=await Promise.all([f.call('/orders/'+a.order.id+'/payment-status',undefined,a.token),f.call('/orders/'+a.order.id+'/payment-status',undefined,a.token)]);
  assert.ok(results.every(result=>result.status===200&&result.data.order.status==='paid'));
  assert.equal(await f.count('memberships'),1);assert.equal(await f.count('payment_receipts'),1);
  let row=(await f.pg.query(`SELECT * FROM ${virtualPaymentTable}`)).rows[0];assert.equal(row.delivery_state,'pending');assert.equal(row.state,'paid');
  const restored=f.make();f.advance(31000);f.respond(undefined);
  assert.equal((await restored.recover()).checked,1);
  row=(await f.pg.query(`SELECT * FROM ${virtualPaymentTable}`)).rows[0];assert.equal(row.delivery_state,'confirmed');assert.equal(row.state,'delivered');
  await restored.sync(a.user,a.order.id);assert.equal(await f.count('payment_receipts'),1);
  assert.equal(Number((await f.pg.query("SELECT count(*) n FROM audit_log WHERE action='payment.activated'")).rows[0].n),1);
  assert.equal(Number((await f.pg.query("SELECT count(*) n FROM audit_log WHERE action='payment.virtual_delivered'")).rows[0].n),1);
});

test('a committed basic or star grant sends late virtual payment to durable reconciliation even after grant revocation',async t=>{
  const f=await fixture(t,{grantConflicts:true});let rewardCalls=0;
  f.rewards.recordPaidOrderInTransaction=async()=>{rewardCalls++;};
  const actorId=randomUUID(),now=new Date().toISOString();
  await f.pg.query("INSERT INTO users(id,username,password_hash,role,created_at,referral_code,consent_version) VALUES($1,'synthetic-grant-admin','synthetic','admin',$2,'SYNTHGRANT','fixture')",[actorId,now]);
  for(const level of ['basic','star']){
    const name='grant_first_'+level,a=await f.account(name);await f.service.prepare(a.user,a.order.id,{code:'pay-'+name});
    const grantId=randomUUID(),start=new Date(Date.parse(a.order.createdAt)-1000).toISOString(),end=new Date(Date.parse(a.order.createdAt)+86400000).toISOString();
    // A committed grant is deliberately inserted after cashier issuance and
    // before the authoritative paid result; no fake paid membership is seeded.
    await f.pg.query(`INSERT INTO collab_grants(id,user_id,level,starts_at,expires_at,reason,approval_reference,actor_id,status,idempotency_key,request_hash,created_at)
      VALUES($1,$2,$3,$4,$5,'synthetic conflict','SYNTHETIC-APPROVED',$6,'active',$7,'synthetic',$8)`,
      [grantId,a.user.id,level,start,end,actorId,randomUUID(),now]);
    f.paid(a);
    const first=await f.call('/orders/'+a.order.id+'/payment-status',undefined,a.token);
    assert.equal(first.status,200);assert.equal(first.data.order.status,'pending');
    const receipt=(await f.pg.query('SELECT * FROM payment_receipts WHERE order_id=$1',[a.order.id])).rows;
    assert.equal(receipt.length,1);assert.equal(receipt[0].outcome,'needs_reconciliation');
    assert.equal(receipt[0].transaction_id,`virtual:${appId}:1:${a.remote.wx_order_id}`);
    const saved=(await f.pg.query(`SELECT state,delivery_state,receipt_hash,receipt_json FROM ${virtualPaymentTable} WHERE order_id=$1`,[a.order.id])).rows[0];
    assert.equal(saved.state,'reconciliation');assert.equal(saved.delivery_state,'blocked');
    assert.equal(saved.receipt_hash,receipt[0].payload_hash);
    assert.equal(JSON.parse(saved.receipt_json).wxOrderId,a.remote.wx_order_id);
    assert.equal(JSON.parse(saved.receipt_json).amountCents,36500);
    await f.service.sync(a.user,a.order.id);await f.make().sync(a.user,a.order.id);
    assert.deepEqual((await f.pg.query('SELECT * FROM payment_receipts WHERE order_id=$1',[a.order.id])).rows,receipt);
    await f.pg.query("UPDATE collab_grants SET status='revoked',revoked_at=$1,revoked_by=$2,revoke_reason='synthetic revoke' WHERE id=$3",[new Date().toISOString(),actorId,grantId]);
    await f.make().sync(a.user,a.order.id);await f.service.sync(a.user,a.order.id);
    assert.deepEqual((await f.pg.query('SELECT * FROM payment_receipts WHERE order_id=$1',[a.order.id])).rows,receipt);
    assert.equal((await f.core.order(a.user,a.order.id)).status,'pending');
    assert.equal((await f.pg.query(`SELECT state,delivery_state FROM ${virtualPaymentTable} WHERE order_id=$1`,[a.order.id])).rows[0].state,'reconciliation');
    assert.equal(Number((await f.pg.query("SELECT count(*) n FROM audit_log WHERE action='payment.needs_reconciliation' AND target_id=$1",[a.order.id])).rows[0].n),1);
  }
  assert.equal(await f.count('memberships'),0);assert.equal(await f.count('payment_receipts'),2);assert.equal(rewardCalls,0);
  assert.equal(f.upstream.filter(row=>row.url.pathname==='/xpay/notify_provide_goods').length,0);
});

test('wrong authoritative amount/env/status and corrupted persisted attempts never open membership',async t=>{
  const f=await fixture(t),a=await f.account('tamper');await f.service.prepare(a.user,a.order.id,{code:'pay-tamper'});f.paid(a);
  for(const patch of [{order_fee:1},{paid_fee:1},{env_type:0},{order_id:'F'.repeat(32)},{status:11}]){
    const remote={...a.remote,...patch};f.respond(()=>response({errcode:0,order:remote}));
    const result=await f.call('/orders/'+a.order.id+'/payment-status',undefined,a.token);assert.equal(result.status,502);
    assert.equal(await f.count('memberships'),0);assert.equal(await f.count('payment_receipts'),0);
  }
  f.respond(()=>response({errcode:-1,errmsg:'isolated_access_token'}));
  const failed=await f.call('/orders/'+a.order.id+'/payment-status',undefined,a.token);assert.equal(failed.status,502);
  assert.equal(JSON.stringify(failed).includes('isolated_access_token'),false);
  f.respond(undefined);
  const saved=(await f.pg.query(`SELECT snapshot_json FROM ${virtualPaymentTable}`)).rows[0].snapshot_json,changed=JSON.parse(saved);changed.productId='forged-product';
  await f.pg.query(`UPDATE ${virtualPaymentTable} SET snapshot_json=$1`,[JSON.stringify(changed)]);
  assert.equal((await f.call('/orders/'+a.order.id+'/payment-status',undefined,a.token)).status,409);
  assert.equal(await f.count('memberships'),0);assert.equal(await f.count('payment_receipts'),0);
});

test('empty delivery acknowledgement is not confirmation; a lost response is recovered only by an authoritative delivered state',async t=>{
  const f=await fixture(t),a=await f.account('delivery_ack');await f.service.prepare(a.user,a.order.id,{code:'pay-delivery_ack'});f.paid(a);
  f.respond(url=>url.pathname==='/xpay/query_order'?response({errcode:0,order:{...a.remote}}):new Response('',{status:200}));
  await f.service.sync(a.user,a.order.id);
  assert.equal((await f.pg.query(`SELECT delivery_state FROM ${virtualPaymentTable}`)).rows[0].delivery_state,'pending');
  assert.equal(await f.count('memberships'),1);assert.equal(await f.count('payment_receipts'),1);
  f.respond(url=>{
    if(url.pathname==='/xpay/query_order')return response({errcode:0,order:{...a.remote}});
    a.remote.status=4;throw Error('Response lost after upstream delivery: isolated_access_token');
  });
  f.advance(31000);await f.make().recover();
  assert.equal((await f.pg.query(`SELECT delivery_state FROM ${virtualPaymentTable}`)).rows[0].delivery_state,'confirmed');
  assert.equal(await f.count('memberships'),1);assert.equal(await f.count('payment_receipts'),1);
});

test('cancel committing during code exchange wins before any parameters issue; paid query during later cancel preserves the payment',async t=>{
  const f=await fixture(t),a=await f.account('race');let entered,release;
  const started=new Promise(resolve=>{entered=resolve;}),hold=new Promise(resolve=>{release=resolve;});
  f.gate(async()=>{entered();await hold;});
  const pending=f.call('/orders/'+a.order.id+'/payment',{code:'pay-race'},a.token);
  try{
    await bounded(Promise.race([started,pending.then(()=>{throw Error('Payment request ended before code exchange');})]),'payment code exchange entered');
    assert.equal((await f.call('/orders/'+a.order.id+'/cancel',{},a.token)).data.order.status,'cancelled');
  }finally{release();await bounded(pending,'payment code exchange cleanup');}
  release();const result=await pending;assert.equal(result.status,409);assert.equal(result.data.payment,undefined);
  assert.equal(await f.count(virtualPaymentTable),0);assert.equal(await f.count('memberships'),0);
  f.gate(undefined);const b=await f.account('late');await f.service.prepare(b.user,b.order.id,{code:'pay-late'});f.paid(b);
  assert.equal((await f.call('/orders/'+b.order.id+'/cancel',{},b.token)).status,409);
  assert.equal((await f.core.order(b.user,b.order.id)).status,'paid');assert.equal(await f.count('memberships'),1);
});

test('payment plus optional reward hook rollback atomically and the same authority query recovers after failure',async t=>{
  const f=await fixture(t),a=await f.account('atomic');await f.service.prepare(a.user,a.order.id,{code:'pay-atomic'});f.paid(a);
  f.rewards.recordPaidOrderInTransaction=async c=>{
    assert.equal(Number((await c.query('SELECT count(*) n FROM payment_receipts')).rows[0].n),1);throw Error('isolated accounting unavailable');
  };
  assert.equal((await f.call('/orders/'+a.order.id+'/payment-status',undefined,a.token)).status,500);
  assert.equal(await f.count('memberships'),0);assert.equal(await f.count('payment_receipts'),0);
  assert.equal((await f.core.order(a.user,a.order.id)).status,'pending');
  f.rewards.recordPaidOrderInTransaction=async()=>({configured:false});
  assert.equal((await f.call('/orders/'+a.order.id+'/payment-status',undefined,a.token)).data.order.status,'paid');
  assert.equal(await f.count('memberships'),1);assert.equal(await f.count('payment_receipts'),1);
});

test('expired delivery lease can be recovered by a new process and a delayed old response cannot overwrite confirmation',async t=>{
  const f=await fixture(t),a=await f.account('lease');await f.service.prepare(a.user,a.order.id,{code:'pay-lease'});f.paid(a);
  let entered,release,notifications=0;
  const started=new Promise(resolve=>{entered=resolve;}),hold=new Promise(resolve=>{release=resolve;});
  f.respond(async url=>{
    if(url.pathname==='/xpay/query_order')return response({errcode:0,order:{...a.remote}});
    if(++notifications===1){entered();await hold;return response({errcode:-1});}
    a.remote.status=4;return response({});
  });
  const old=f.service.sync(a.user,a.order.id);
  try{
    await bounded(Promise.race([started,old.then(()=>{throw Error('Sync ended before delivery lease');})]),'delivery lease entered');
    assert.equal((await f.pg.query(`SELECT delivery_state FROM ${virtualPaymentTable}`)).rows[0].delivery_state,'processing');
    f.advance(31000);await bounded(f.make().recover(),'new process delivery recovery');
  }finally{release();await bounded(old,'old delivery cleanup');}
  assert.equal((await f.pg.query(`SELECT delivery_state FROM ${virtualPaymentTable}`)).rows[0].delivery_state,'confirmed');
  assert.equal(await f.count('memberships'),1);assert.equal(await f.count('payment_receipts'),1);
});

test('stable access token caches per app and coalesces fetches; ordinary login still strips the payment session key',async()=>{
  let time=Date.now(),requests=0;
  const wechat=createWechatAdapter({appId,appSecret:'fixture-secret',clock:()=>time,fetchImpl:async(url,options)=>{
    requests++;if(url.pathname==='/sns/jscode2session')return response({openid:'fixture-openid',session_key:'fixture-session',unionid:'private-union'});
    assert.equal(url.pathname,'/cgi-bin/stable_token');assert.equal(url.search,'');
    assert.equal(JSON.parse(options.body).force_refresh,false);return response({access_token:'fixture-token',expires_in:7200});
  }});
  assert.deepEqual(await wechat.exchangeCode('login'),{appId,openId:'fixture-openid'});
  assert.deepEqual(await wechat.exchangePaymentCode('payment'),{appId,openId:'fixture-openid',sessionKey:'fixture-session'});
  assert.deepEqual(await Promise.all([1,2,3].map(()=>wechat.getAccessToken({appId}))),Array(3).fill({appId,accessToken:'fixture-token'}));
  assert.equal(requests,3);time+=6901000;await wechat.getAccessToken({appId});assert.equal(requests,4);
  await assert.rejects(wechat.getAccessToken({appId:'other'}));assert.equal(requests,4);
  const failed=createWechatAdapter({appId,appSecret:'fixture-secret',fetchImpl:async()=>{throw Error('fixture-secret full URL');}});
  await assert.rejects(failed.getAccessToken({appId}),error=>error.code==='WECHAT_TOKEN_UNAVAILABLE'&&!error.message.includes('fixture-secret'));
});
