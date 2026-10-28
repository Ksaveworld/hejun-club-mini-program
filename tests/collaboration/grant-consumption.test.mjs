import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync,mkdtempSync,writeFileSync,rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {randomUUID,createHash} from 'node:crypto';
import {request} from 'node:http';
import {PGlite} from '@electric-sql/pglite';
import {createPostgresCore} from '../../server/postgres-core.mjs';
import {createPostgresContent,initializePostgresPostVersions} from '../../server/postgres-content.mjs';
import {createPostgresApplication} from '../../server/postgres-app.mjs';
import {initializeGrantDatabase} from '../../server/collaboration/grant-migration.mjs';
import {effectiveEntitlements} from '../../server/collaboration/entitlements.mjs';

const appId='wx0000000000000000';
async function fixture(t,{postVersions=false}={}){
  const pg=new PGlite({parsers:{20:v=>BigInt(v)}});await pg.waitReady;
  const schema='club_migration_consume',dir=mkdtempSync(join(tmpdir(),'grant-consumption-'));
  t.after(async()=>{await pg.close();rmSync(dir,{recursive:true,force:true});});
  await pg.exec(`CREATE SCHEMA ${schema};SET search_path TO ${schema};`+readFileSync(new URL('../../server/migrations/postgres/001-baseline.sql',import.meta.url),'utf8'));
  let tail=Promise.resolve();
  const pool={connect:async()=>{const prev=tail;let release;tail=new Promise(resolve=>{release=resolve});await prev;
    return {query:(sql,args)=>args===undefined?pg.exec(sql).then(rows=>rows.at(-1)??{rows:[]}):pg.query(sql,args),release};}};
  await initializeGrantDatabase(pool,{schema});
  if(postVersions)await initializePostgresPostVersions(pool,{schema});
  let now=new Date().toISOString();
  const entitlementResolver=async(c,userId)=>effectiveEntitlements(c,userId,now);
  const core=createPostgresCore(pool,{schema,appId,entitlementResolver});
  const content=createPostgresContent(pool,{schema,documentsDirectory:dir,postVersions,entitlementResolver});
  const adapter={configured:true,appId,exchangeCode:async code=>({appId,openId:code})};
  const session=await core.login({code:'synthetic-consumer-a',consent:true},adapter),user=await core.authenticate(session.accessToken);
  const otherSession=await core.login({code:'synthetic-consumer-b',consent:true},adapter),other=await core.authenticate(otherSession.accessToken);
  const admin={id:'synthetic-admin',username:'synthetic-admin',role:'admin'};
  await pg.query("INSERT INTO users(id,username,password_hash,role,created_at,referral_code,consent_version) VALUES($1,$2,'synthetic','admin',$3,'SYNTHADMIN','fixture')",[admin.id,admin.username,now]);
  async function grant(level='star',{startsAt=new Date(Date.parse(now)-1000).toISOString(),expiresAt=new Date(Date.parse(now)+86400000).toISOString(),target=user}={}){
    const id=randomUUID();await pg.query(`INSERT INTO collab_grants(id,user_id,level,starts_at,expires_at,reason,approval_reference,actor_id,status,idempotency_key,request_hash,created_at)
      VALUES($1,$2,$3,$4,$5,'synthetic','SYNTHETIC-APPROVED',$6,'active',$7,'synthetic',$8)`,[id,target.id,level,startsAt,expiresAt,admin.id,randomUUID(),now]);return id;
  }
  async function seed(table,planIds=[],{status='published',preview=false}={}){
    const id=randomUUID(),access=planIds.length?{visibility:'plans',planIds,...(preview?{previewPages:10}:{})}:{visibility:'public',planIds:[]};
    await pg.query(`INSERT INTO ${table}(id,title,summary,body,category,access_json,status,revision,created_by,updated_by,created_at,updated_at,published_at,idempotency_key,creation_hash${table==='service_resources'?',action_json':''})
      VALUES($1,'SYNTHETIC title','SYNTHETIC summary','SYNTHETIC restricted body',$2,$3,$4,1,$5,$5,$6,$6,$6,$7,'synthetic'${table==='service_resources'?',\'{"type":"phone","phoneNumber":"13800000000"}\'':''})`,
      [id,table==='articles'?'knowledge':'directory',JSON.stringify(access),status,admin.id,now,randomUUID()]);return id;
  }
  async function paid(level='basic',{expiresAt=new Date(Date.parse(now)+3*365*86400000).toISOString()}={}){
    const id=randomUUID(),startsAt=new Date(Date.parse(now)-86400000).toISOString();
    await pg.query(`INSERT INTO orders(id,user_id,plan_id,amount_cents,status,profile_json,created_at,idempotency_key,request_hash)
      VALUES($1,$2,$3,36500,'paid','{}',$4,$5,'synthetic')`,[id,user.id,level,startsAt,randomUUID()]);
    await pg.query('INSERT INTO memberships VALUES($1,$2,$3,$4,$5)',[user.id,id,level,startsAt,expiresAt]);return id;
  }
  async function attachReport(id){
    const full=Buffer.from('%PDF-SYNTHETIC-full-protected-content'),preview=Buffer.from('%PDF-SYNTHETIC-preview-only');
    const save=bytes=>{const sha=createHash('sha256').update(bytes).digest('hex');writeFileSync(join(dir,sha+'.pdf'),bytes);return sha;};
    await pg.query('INSERT INTO article_documents VALUES($1,$2,$3,$4,12,$5)',[id,save(full),'synthetic.pdf',full.length,now]);
    await pg.query('INSERT INTO report_previews VALUES($1,$2,$3,10)',[id,save(preview),preview.length]);return {full,preview};
  }
  return {pg,pool,schema,dir,core,content,session,user,other,otherSession,admin,entitlementResolver,grant,seed,paid,attachReport,getNow:()=>now,setNow:value=>{now=value}};
}

test('consumer me and managed members expose a whitelist with exact display expiry, keeping paid membership and renewal semantics',async t=>{
  const f=await fixture(t),paidId=await f.paid('basic'),grantId=await f.grant('star');
  const me=await f.core.me(f.user);
  assert.equal(me.membership.orderId,paidId);assert.equal(me.membership.planId,'basic');
  assert.equal(me.displayMembership.planId,'star');assert.ok(me.displayMembership.expiresAt<me.membership.expiresAt);
  assert.equal(me.displayMembership.orderId,undefined);assert.equal(me.effectiveEntitlements.paid,undefined);
  assert.deepEqual(me.effectiveEntitlements.planIds,['basic','star']);assert.equal(me.renewals.canRenew,false);
  assert.deepEqual(me.effectiveEntitlements.sources.find(s=>s.source==='grant').id,grantId);
  const members=await f.core.managedMembers(f.admin);assert.deepEqual(members.find(u=>u.id===f.user.id).displayMembership,me.displayMembership);
  const projected=createPostgresCore(f.pool,{schema:f.schema,appId,entitlementResolver:async(c,id,now)=>{
    const value=await f.entitlementResolver(c,id,now);return {...value,internalSecret:'DO-NOT-EXPOSE',paid:{secret:'DO-NOT-EXPOSE'},sources:value.sources.map(s=>({...s,approval:'DO-NOT-EXPOSE'}))};
  }});
  assert.doesNotMatch(JSON.stringify(await projected.me(f.user)),/DO-NOT-EXPOSE/);
  await f.pg.query("UPDATE collab_grants SET status='revoked' WHERE id=$1",[grantId]);
  const after=await f.core.me(f.user);assert.equal(after.displayMembership.planId,'basic');assert.equal(after.membership.orderId,paidId);
});

test('article and service consumption use exact basic/star union, retain public visibility, and deny draft or expired access',async t=>{
  const f=await fixture(t);
  const basic=await f.seed('articles',['basic']),star=await f.seed('articles',['star']),open=await f.seed('articles'),draft=await f.seed('articles',[],{status:'draft'});
  const basicService=await f.seed('service_resources',['basic']),starService=await f.seed('service_resources',['star']);
  const grant=await f.grant('basic');
  assert.equal((await f.content.article(f.user,basic)).fullAccess,true);
  await assert.rejects(f.content.article(f.user,star),/不可阅读/);
  assert.deepEqual(new Set((await f.content.articles(f.user)).articles.map(a=>a.id)),new Set([basic,open]));
  assert.equal((await f.content.resource(f.user,basicService)).action.type,'phone');
  await assert.rejects(f.content.resource(f.user,starService),/不可使用/);
  assert.deepEqual((await f.content.resources(f.user)).resources.map(r=>r.id),[basicService]);
  assert.equal((await f.content.article(null,open)).fullAccess,true);await assert.rejects(f.content.article(f.user,draft),/不可阅读/);
  await f.pg.query("UPDATE collab_grants SET status='revoked' WHERE id=$1",[grant]);await f.grant('star');
  assert.equal((await f.content.article(f.user,star)).fullAccess,true);await assert.rejects(f.content.article(f.user,basic),/不可阅读/);
  await assert.rejects(f.content.resource(f.user,basicService),/不可使用/);
  f.setNow(new Date(Date.parse(f.getNow())+86400000).toISOString());
  await assert.rejects(f.content.article(f.user,star),/不可阅读/);assert.equal((await f.content.resources(f.user)).resources.length,0);
});

test('real local HTTP report/PDF/Range rechecks grant, revocation, paid fallback, expiry, account and publication state',async t=>{
  const f=await fixture(t),report=await f.seed('articles',['star'],{preview:true}),files=await f.attachReport(report),grant=await f.grant('star');
  const server=createPostgresApplication({core:f.core,content:f.content,hosts:['127.0.0.1']});
  await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));
  t.after(()=>new Promise(resolve=>{server.closeAllConnections();server.close(resolve);}));
  const get=(path,headers={})=>new Promise((resolve,reject)=>{
    const req=request({hostname:'127.0.0.1',port:server.address().port,path:'/api'+path,headers:{Host:'127.0.0.1',...headers}},res=>{
      const parts=[];res.on('data',b=>parts.push(b));res.on('end',()=>resolve({status:res.statusCode,bytes:Buffer.concat(parts)}));});req.on('error',reject);req.end();
  });
  const auth={Authorization:'Bearer '+f.session.accessToken},url='/articles/'+report;
  assert.equal(JSON.parse((await get('/me',auth)).bytes).displayMembership.planId,'star');
  assert.deepEqual((await get(url+'/document',auth)).bytes,files.full);
  const range=await get(url+'/document',{...auth,Range:'bytes=0-4'});assert.equal(range.status,206);assert.equal(range.bytes.toString(),'%PDF-');
  assert.equal((await get(url+'/document')).status,404);assert.deepEqual((await get(url+'/preview')).bytes,files.preview);
  assert.equal((await get(url+'/document',{Authorization:'Bearer '+f.otherSession.accessToken})).status,404);
  assert.equal((await get(url+'/document',{Authorization:'Bearer invalid'})).status,401);
  await f.pg.query("UPDATE collab_grants SET status='revoked' WHERE id=$1",[grant]);
  assert.equal((await get(url+'/document',auth)).status,404);assert.equal((await f.content.article(f.user,report)).body,'');
  assert.deepEqual((await get(url+'/preview',auth)).bytes,files.preview);
  await f.paid('star');assert.deepEqual((await get(url+'/document',auth)).bytes,files.full);
  await f.pg.query('UPDATE memberships SET expires_at=$1 WHERE user_id=$2',[f.getNow(),f.user.id]);
  assert.equal((await get(url+'/document',auth)).status,404);
  await f.pg.query("UPDATE articles SET status='draft' WHERE id=$1",[report]);
  assert.equal((await get(url+'/preview',auth)).status,404);
});

test('basic grant enables own submission/editing, expiry removes edit permission but preserves history',async t=>{
  const f=await fixture(t,{postVersions:true});await f.grant('basic');
  const post=await f.content.publish(f.user,{title:'SYNTHETIC title',body:'SYNTHETIC original'},randomUUID());
  assert.equal(post.canEdit,true);
  const edited=await f.content.editPost(f.user,post.id,{title:'SYNTHETIC revised',body:'SYNTHETIC changed',revision:1},randomUUID());assert.equal(edited.revision,2);
  f.setNow(new Date(Date.parse(f.getNow())+86400000).toISOString());
  assert.equal((await f.content.posts(f.user,true))[0].canEdit,false);
  assert.equal((await f.content.posts(f.user,true))[0].versions.length,2);
  await assert.rejects(f.content.publish(f.user,{title:'SYNTHETIC late',body:'SYNTHETIC late'},randomUUID()),/有效期/);
  await assert.rejects(f.content.editPost(f.user,post.id,{title:'SYNTHETIC late',body:'SYNTHETIC late',revision:2},randomUUID()),/有效期/);
  assert.deepEqual(await f.content.posts(f.other,true),[]);
});

test('injected consumption excludes operational accounts and stale roles; absent resolver retains legacy paid behavior',async t=>{
  const f=await fixture(t),report=await f.seed('articles',['star']);await f.grant('star');
  const legacyCore=createPostgresCore(f.pool,{schema:f.schema,appId}),legacyContent=createPostgresContent(f.pool,{schema:f.schema,documentsDirectory:f.dir});
  assert.equal((await legacyCore.me(f.user)).membership,null);assert.equal((await legacyCore.me(f.user)).effectiveEntitlements,undefined);
  await assert.rejects(legacyContent.article(f.user,report),/不可阅读/);
  await f.pg.query("CREATE TABLE collab_accounts(user_id TEXT PRIMARY KEY REFERENCES users(id))");
  await f.pg.query('INSERT INTO collab_accounts VALUES($1)',[f.user.id]);
  await assert.rejects(f.core.me(f.user),/消费会员/);await assert.rejects(f.core.authenticate(f.session.accessToken),/消费会员/);
  await assert.rejects(f.content.article(f.user,report),/不可阅读/);
  assert.ok(!(await f.core.managedMembers(f.admin)).some(u=>u.id===f.user.id));
  await f.pg.query('DELETE FROM collab_accounts WHERE user_id=$1',[f.user.id]);await f.pg.query("UPDATE users SET role='admin' WHERE id=$1",[f.user.id]);
  await assert.rejects(f.core.me(f.user),/消费会员/);await assert.rejects(f.content.article(f.user,report),/不可阅读/);
});

test('real payment receipt is retained for grant conflict without paid membership, referral lock or reward effects',async t=>{
  const f=await fixture(t);let rewards=0,checks=0;
  const core=createPostgresCore(f.pool,{schema:f.schema,appId,entitlementResolver:f.entitlementResolver,
    rewards:{recordPaidOrderInTransaction:async()=>{rewards++}},grantPaymentConflict:async(c,userId,interval)=>{
      checks++;assert.equal(userId,f.user.id);assert.ok(interval.startsAt<interval.expiresAt);
      return (await c.query("SELECT id FROM collab_grants WHERE user_id=$1 AND status='active' AND starts_at<$3 AND expires_at>$2",[userId,interval.startsAt,interval.expiresAt])).rows.length>0;
    }});
  const orderInput={planId:'basic',consent:true,form:{name:'SYNTHETIC',phone:'13800000000',city:'上海'}},orderKey=randomUUID();
  const order=await core.createOrder(f.user,orderInput,orderKey);
  assert.equal(order.paymentReconciliationRequired,false);
  assert.equal((await core.preparePayment(f.user,order.id)).order.amount_cents,36500);
  assert.equal(await core.prepayStillOpen(f.user,order.id),true);
  await f.grant('star');const paidAt=new Date().toISOString();
  const remote={appid:appId,mchid:'1234567890',out_trade_no:order.id.slice(2),transaction_id:'synthetic_conflicting_payment',trade_state:'SUCCESS',amount:{currency:'CNY',total:36500},payer:{openid:'synthetic-consumer-a'},success_time:paidAt};
  const expected={appId,merchantId:'1234567890'};
  assert.equal((await core.applyPayment(remote,expected)).outcome,'needs_reconciliation');
  assert.equal((await core.applyPayment(remote,expected)).duplicate,true);assert.equal(checks,1);assert.equal(rewards,0);
  assert.equal((await f.pg.query('SELECT * FROM memberships')).rows.length,0);
  assert.equal((await f.pg.query('SELECT * FROM payment_receipts')).rows[0].outcome,'needs_reconciliation');
  const reconciled=await core.order(f.user,order.id);
  assert.equal(reconciled.status,'pending');assert.equal(reconciled.paymentReconciliationRequired,true);
  assert.equal(reconciled.amountCents,36500);assert.equal(reconciled.actualPaidCents,null);
  assert.equal(reconciled.cancellation,null);
  let closeCalls=0;
  await assert.rejects(core.cancelOrder(f.user,order.id,{configured:true,close:async()=>{closeCalls++}}),/付款待核对/);
  assert.equal(closeCalls,0);assert.equal((await core.order(f.user,order.id)).status,'pending');
  await assert.rejects(core.preparePayment(f.user,order.id),/付款待核对/);
  assert.equal(await core.prepayStillOpen(f.user,order.id),false);
  assert.equal((await core.createOrder(f.user,orderInput,orderKey)).id,order.id);
  assert.equal((await core.createOrder(f.user,orderInput,orderKey)).paymentReconciliationRequired,true);
  await assert.rejects(core.createOrder(f.user,orderInput,randomUUID()),/付款待核对/);
  // A historical/locally cancelled original order must not let another key or
  // already-existing pending order on this user evade account-wide protection.
  await f.pg.query("UPDATE orders SET status='cancelled' WHERE id=$1",[order.id]);
  const historical=await core.cancelOrder(f.user,order.id);
  assert.equal(historical.status,'cancelled');assert.equal(historical.paymentReconciliationRequired,true);
  await assert.rejects(core.createOrder(f.user,orderInput,randomUUID()),/付款待核对/);
  const anotherId='HJ'+randomUUID().replaceAll('-','').toUpperCase();
  await f.pg.query(`INSERT INTO orders(id,user_id,plan_id,amount_cents,status,profile_json,created_at,idempotency_key,request_hash)
    VALUES($1,$2,'basic',36500,'pending','{}',$3,$4,'synthetic-existing-order')`,[anotherId,f.user.id,new Date().toISOString(),randomUUID()]);
  await f.pg.query('INSERT INTO settings VALUES($1,$2)',['wechat_payment_attempt:'+anotherId,'initiated']);
  assert.equal((await core.order(f.user,anotherId)).paymentReconciliationRequired,false);
  await assert.rejects(core.preparePayment(f.user,anotherId),/付款待核对/);
  assert.equal(await core.prepayStillOpen(f.user,anotherId),false);
  const otherOrder=await core.createOrder(f.other,orderInput,randomUUID());
  assert.equal((await core.preparePayment(f.other,otherOrder.id)).order.amount_cents,36500);
  assert.equal(await core.prepayStillOpen(f.other,otherOrder.id),true);
  assert.equal((await f.pg.query('SELECT count(*) AS n FROM payment_receipts')).rows[0].n,1n);
  assert.equal((await f.pg.query('SELECT referral_locked_at FROM users WHERE id=$1',[f.user.id])).rows[0].referral_locked_at,null);
  assert.equal((await core.me(f.user)).displayMembership.planId,'star');
});


test('payment received while provider close is in flight prevents final local cancellation',async t=>{
  const f=await fixture(t);
  const core=createPostgresCore(f.pool,{schema:f.schema,appId,grantPaymentConflict:async()=>true});
  const order=await core.createOrder(f.user,{planId:'basic',consent:true,form:{name:'SYNTHETIC',phone:'13800000000',city:'上海'}},randomUUID());
  await core.preparePayment(f.user,order.id);
  let closeCalls=0;
  const expected={appId,merchantId:'1234567890'};
  const remote={appid:appId,mchid:expected.merchantId,out_trade_no:order.id.slice(2),transaction_id:'synthetic_payment_during_close',trade_state:'SUCCESS',amount:{currency:'CNY',total:36500},payer:{openid:'synthetic-consumer-a'},success_time:new Date().toISOString()};
  await assert.rejects(core.cancelOrder(f.user,order.id,{...expected,configured:true,close:async()=>{
    closeCalls++;
    assert.equal((await core.applyPayment(remote,expected)).outcome,'needs_reconciliation');
  }}),/付款待核对/);
  assert.equal(closeCalls,1);
  const current=await core.order(f.user,order.id);
  assert.equal(current.status,'pending');assert.equal(current.paymentReconciliationRequired,true);
  assert.equal(current.actualPaidCents,null);
  assert.equal((await core.applyPayment(remote,expected)).duplicate,true);
  assert.equal((await f.pg.query('SELECT count(*) AS n FROM payment_receipts')).rows[0].n,1n);
  assert.equal((await f.pg.query('SELECT count(*) AS n FROM memberships')).rows[0].n,0n);
  assert.equal((await f.pg.query("SELECT count(*) AS n FROM audit_log WHERE action='order.cancelled' AND target_id=$1",[order.id])).rows[0].n,0n);
});
