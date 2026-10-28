import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {randomUUID} from 'node:crypto';
import {PGlite} from '@electric-sql/pglite';
import {createPostgresCore} from '../../server/postgres-core.mjs';
import {createPostgresForms} from '../../server/postgres-forms.mjs';
import {createPostgresApplication} from '../../server/postgres-app.mjs';
import {request} from 'node:http';
import {digest} from '../../server/domain.mjs';

const appId='wx47d5e3e20fd77f65',schema='club_migration_core';
const legal={id:'isolated-approved',status:'approved',requireHongKongConsent:false,documents:['privacy','terms'].map(id=>({id,version:'fixture',sha256:'a'.repeat(64)}))};
const consent={accepted:true,releaseId:legal.id};
const adapter={configured:true,appId,exchangeCode:async code=>({appId,openId:code})};
const body=()=>({planId:'basic',consent:true,legalConsent:consent,form:{name:'隔离会员',phone:'13800000000',city:'上海'}});
async function fixture(t){
  const pg=new PGlite({parsers:{20:v=>BigInt(v)}});await pg.waitReady;
  await pg.exec(`CREATE SCHEMA ${schema}; SET search_path TO ${schema};`+readFileSync(new URL('../../server/migrations/postgres/001-baseline.sql',import.meta.url),'utf8'));
  const fail={audit:false};let tail=Promise.resolve();
  // A PGlite engine has one connection. Serialize complete transactions, never
  // interleave BEGIN/COMMIT; this is not evidence of real server lock contention.
  const pool={connect:async()=>{const previous=tail;let release;tail=new Promise(ok=>{release=ok;});await previous;return {query:(sql,args)=>{if(fail.audit&&sql.startsWith('INSERT INTO audit_log'))throw Error('audit failure');return pg.query(sql,args);},release};}};
  const core=createPostgresCore(pool,{schema,appId,legal}),forms=createPostgresForms(pool,{schema});
  t.after(()=>pg.close());return {pg,core,forms,fail};
}
async function login(core,code){const session=await core.login({code,consent:true,legalConsent:consent},adapter);return {session,user:await core.authenticate(session.accessToken)};}

test('PG account/order/payment transaction preserves ownership, retries, membership and failure rollback',async t=>{
  const {core,pg,fail}=await fixture(t),{user}=await login(core,'fixture_one'),other=await login(core,'fixture_two');
  assert.equal((await login(core,'fixture_one')).user.id,user.id);
  const key=randomUUID(),order=await core.createOrder(user,body(),key);
  assert.equal((await core.createOrder(user,body(),key)).id,order.id);
  await assert.rejects(core.createOrder(user,{...body(),planId:'star'},key),/其他内容/);
  await assert.rejects(core.order(other.user,order.id),/找不到/);
  await assert.rejects(core.preparePayment(user,order.id),/确认订单/);
  await core.acceptPayment(user,order.id,{...consent,detailsConfirmed:true});
  assert.equal((await core.preparePayment(user,order.id)).order.amount_cents,36500);
  const expected={appId,merchantId:'1234567890'},remote={appid:appId,mchid:expected.merchantId,out_trade_no:order.id.slice(2),transaction_id:'fixture_transaction',trade_state:'SUCCESS',amount:{currency:'CNY',total:36500},payer:{openid:'fixture_one'},success_time:new Date().toISOString()};
  await assert.rejects(core.applyPayment({...remote,amount:{currency:'CNY',total:1}},expected),/金额/);
  fail.audit=true;await assert.rejects(core.applyPayment(remote,expected),/audit failure/);fail.audit=false;
  assert.equal((await core.me(user)).membership,null);assert.equal((await core.order(user,order.id)).status,'pending');
  assert.equal((await core.applyPayment(remote,expected)).outcome,'activated');
  assert.equal((await core.applyPayment(remote,expected)).duplicate,true);
  assert.equal((await pg.query('SELECT count(*) n FROM memberships')).rows[0].n,1n);
  assert.equal((await core.order(user,order.id)).actualPaidCents,36500);
  assert.ok((await core.me(user)).membership.active);
});

test('PG legacy proof consumption rolls back and cancelled order cannot be prepaid',async t=>{
  const {core,pg,fail}=await fixture(t),{user}=await login(core,'old_identity');
  // Simulate an imported official-account-only user with no mini-program identity.
  await pg.query('DELETE FROM wechat_identities WHERE user_id=$1',[user.id]);
  const proof='X'.repeat(32),code=user.id+'.'+proof;
  await pg.query('INSERT INTO settings VALUES($1,$2)',['native_account_transfer:'+user.id,JSON.stringify({hash:digest(proof),appId,expiresAt:'2099-01-01'})]);
  fail.audit=true;
  await assert.rejects(core.login({code:'new_identity',consent:true,legalConsent:consent,transferCode:code},adapter),/audit failure/);fail.audit=false;
  const linked=await core.login({code:'new_identity',consent:true,legalConsent:consent,transferCode:code},adapter);assert.equal(linked.user.id,user.id);
  await assert.rejects(core.login({code:'new_identity',consent:true,legalConsent:consent,transferCode:code},adapter),/已过期/);
  const order=await core.createOrder(user,body(),randomUUID());await core.cancelOrder(user,order.id);
  await assert.rejects(core.preparePayment(user,order.id),/不能付款/);
  assert.equal((await core.order(user,order.id)).status,'cancelled');
});

test('PG-only HTTP login to order to confirmed membership works without a SQLite database',async t=>{
  const {core,forms}=await fixture(t);let trade;
  const payment={configured:true,appId,merchantId:'1234567890',prepay:async(order,openId)=>{trade={appid:appId,mchid:'1234567890',out_trade_no:order.id.slice(2),transaction_id:'http_transaction',trade_state:'SUCCESS',amount:{currency:'CNY',total:order.amount_cents},payer:{openid:openId},success_time:new Date().toISOString()};return {package:'prepay_id=fixture'};},query:async()=>trade};
  const server=createPostgresApplication({core,forms,wechat:adapter,payment,hosts:['127.0.0.1']});
  await new Promise(ok=>server.listen(0,'127.0.0.1',ok));t.after(()=>new Promise(ok=>{server.closeAllConnections();server.close(ok);}));
  const call=(path,body,token)=>new Promise((resolve,reject)=>{const req=request({hostname:'127.0.0.1',port:server.address().port,path:'/api'+path,method:body===undefined?'GET':'POST',headers:{Host:'127.0.0.1','Content-Type':'application/json','X-Club-Request':'1','Idempotency-Key':randomUUID(),...(token?{Authorization:'Bearer '+token}:{})}},res=>{const parts=[];res.on('data',c=>parts.push(c));res.on('end',()=>resolve({status:res.statusCode,data:JSON.parse(Buffer.concat(parts))}));});req.on('error',reject);req.end(body===undefined?undefined:JSON.stringify(body));});
  const logged=await call('/native/auth/wechat',{code:'http_identity',consent:true,legalConsent:consent});assert.equal(logged.status,200,JSON.stringify(logged));const token=logged.data.accessToken;
  const created=await call('/orders',body(),token);assert.equal(created.status,201,JSON.stringify(created));const id=created.data.order.id;
  assert.equal((await call('/orders/'+id+'/legal-consent',{...consent,detailsConfirmed:true},token)).status,200);
  assert.equal((await call('/orders/'+id+'/payment',{},token)).status,200);
  assert.equal((await call('/me',undefined,token)).data.membership,null);
  assert.equal((await call('/orders/'+id+'/payment-status',undefined,token)).data.order.status,'paid');
  assert.equal((await call('/me',undefined,token)).data.membership.active,true);
  assert.equal((await call('/health')).data.storage,'postgres');
});

test('PG administrator review preserves registration-only status and audit reads omit arbitrary private payloads',async t=>{
  const {core,pg,fail}=await fixture(t),{user}=await login(core,'application_member'),staff=await login(core,'review_admin');
  await pg.query("UPDATE users SET role='admin' WHERE id=$1",[staff.user.id]);const actor={...staff.user,role:'admin'};
  const application={...body(),planId:'organization',form:{...body().form,company:'隔离机构',organizationType:'机构会员'}},order=await core.createOrder(user,application,randomUUID());
  await assert.rejects(core.reviewOrder({...user,role:'admin'},order.id,{decision:'approve',note:'核验'}),/管理员/);
  fail.audit=true;await assert.rejects(core.reviewOrder(actor,order.id,{decision:'reject',note:'资料不足'}),/audit failure/);fail.audit=false;
  assert.equal((await core.order(user,order.id)).status,'review');
  const reviewed=await core.reviewOrder(actor,order.id,{decision:'approve',note:'保存核验'});assert.equal(reviewed.status,'review');assert.equal(reviewed.registrationOnly,true);
  assert.equal((await core.me(user)).membership,null);await assert.rejects(core.preparePayment(user,order.id),/不能付款/);
  assert.equal((await core.managedOrders(actor))[0].reviewNote,'保存核验');assert.equal((await core.managedMembers(actor)).length,1);
  await pg.query('INSERT INTO audit_log(actor_id,action,target_id,detail,created_at) VALUES($1,$2,$3,$4,$5)',[actor.id,'application.approve',order.id,JSON.stringify({note:'可展示',transactionId:'must-remain-private',futureSecret:'never-return'}),'2026']);
  const records=await core.managedAudit(actor,new URLSearchParams({group:'application',target:order.id}));assert.equal(records.records[0].note,'可展示');assert.doesNotMatch(JSON.stringify(records),/must-remain-private|never-return/);
  await assert.rejects(core.managedAudit(actor,new URLSearchParams('before=1&before=2')),/参数不正确/);
  await core.reviewOrder(actor,order.id,{decision:'reject',note:'不符合'});await assert.rejects(core.reviewOrder(actor,order.id,{decision:'approve',note:'重复'}),/已处理/);
  await pg.query("UPDATE users SET role='member' WHERE id=$1",[actor.id]);await assert.rejects(core.managedOrders(actor),/管理员/);
});
