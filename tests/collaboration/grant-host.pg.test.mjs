import test from 'node:test';
import assert from 'node:assert/strict';
import {randomBytes,randomUUID} from 'node:crypto';
import {readFileSync} from 'node:fs';
import {createServer,request} from 'node:http';
import pg from 'pg';
import {digest} from '../../server/domain.mjs';
import {postgresTypes} from '../../server/postgres.mjs';
import {createPostgresCore} from '../../server/postgres-core.mjs';
import {initializeGrantDatabase} from '../../server/collaboration/grant-migration.mjs';
import {prepareGrantHost} from '../../server/collaboration/grant-host.mjs';
import {createGrantIdentityVerifier} from '../../server/collaboration/grant-identity.mjs';

const connectionString=process.env.GRANT_TEST_DATABASE_URL;
const skip=connectionString?false:'UNVERIFIED: explicit local grant_test PostgreSQL URL is required';
if(connectionString){
  const url=new URL(connectionString);
  assert.ok(['postgres:','postgresql:'].includes(url.protocol));
  assert.ok(['127.0.0.1','localhost'].includes(url.hostname),'Only local PostgreSQL is allowed');
  assert.equal(url.pathname,'/grant_test','Only isolated grant_test is allowed');
  assert.equal(url.search,'');assert.equal(url.hash,'');
}
const appId='wx0000000000000000',origin='https://grant-admin.synthetic.test';
const input={userId:'synthetic-consumer',level:'star',reason:'SYNTHETIC host integration',approvalReference:'SYNTHETIC-per-person-approval'};
function deferred(){let resolve;const promise=new Promise(r=>{resolve=r});return {promise,resolve};}
async function bounded(promise,label){let timer;try{return await Promise.race([promise,new Promise((_,reject)=>{timer=setTimeout(()=>reject(Error('Timed out: '+label)),5000)})]);}finally{clearTimeout(timer);}}
async function poll(check,label){const until=Date.now()+4000;while(Date.now()<until){if(await check())return;await new Promise(r=>setTimeout(r,10));}assert.fail('Expected real lock contention: '+label);}

async function fixture(t){
  const pool=new pg.Pool({connectionString,max:8,types:postgresTypes,ssl:false,connectionTimeoutMillis:5000,statement_timeout:8000,idle_in_transaction_session_timeout:12000});
  const schema='club_migration_grant_host_'+randomBytes(6).toString('hex');assert.match(schema,/^club_migration_grant_host_[a-f0-9]{12}$/);
  let created=false;
  t.after(async()=>{try{if(created)await pool.query(`DROP SCHEMA "${schema}" CASCADE`);}finally{await pool.end();}});
  assert.equal((await pool.query('SELECT current_database() AS name')).rows[0].name,'grant_test');
  await pool.query(`CREATE SCHEMA "${schema}"`);created=true;
  async function query(sql,args){const c=await pool.connect();try{await c.query('BEGIN');await c.query(`SET LOCAL search_path TO "${schema}"`);const result=await c.query(sql,args);await c.query('COMMIT');return result;}catch(error){await c.query('ROLLBACK');throw error;}finally{c.release();}}
  await query(readFileSync(new URL('../../server/migrations/postgres/001-baseline.sql',import.meta.url),'utf8'));
  const createdAt=new Date().toISOString();
  await query(`INSERT INTO users(id,username,password_hash,role,created_at,referral_code,consent_version)
    VALUES('synthetic-admin','synthetic-admin','synthetic','admin',$1,'ADMIN0','fixture'),
    ('synthetic-consumer','synthetic-consumer','synthetic','member',$1,'USER00','fixture')`,[createdAt]);
  await query('INSERT INTO wechat_identities VALUES($1,$2,$3,$4)',[appId,'synthetic-openid','synthetic-consumer',createdAt]);
  await query('INSERT INTO sessions VALUES($1,$2,$3)',[digest('pg-admin:'+'a'.repeat(64)),'synthetic-admin','2099-01-01T00:00:00.000Z']);
  await initializeGrantDatabase(pool,{schema});
  let pause=null,rewardCalls=0;
  const attempts=[];
  const tracked={connect:async()=>{
    const c=await pool.connect(),pid=(await c.query('SELECT pg_backend_pid() AS pid')).rows[0].pid;
    return {query:async(sql,args)=>{
      attempts.push({pid,sql});const value=await c.query(sql,args);
      if(pause&&pause.match.test(sql)){const gate=pause;pause=null;gate.entered.resolve(pid);await bounded(gate.release.promise,'release operation with users lock');}
      return value;
    },release:error=>c.release(error)};
  }};
  const host=await prepareGrantHost(tracked,{schema,adminOrigin:origin,writesEnabled:true,confirmationSecret:'SYNTHETIC-HOST-SECRET-32-BYTES-ONLY',
    policy:{approved:true,startRule:'confirmation-time',timeZone:'Asia/Shanghai',yearRule:'calendar-anniversary-clamp',overlap:'block-active',version:'SYNTHETIC-HOST-v1'},
    identityVerifier:createGrantIdentityVerifier({resolveEvidence:async(_c,{userId})=>({verified:true,userId,appId,openId:'synthetic-openid',reference:'SYNTHETIC-identity-check',revision:'1'})}),
    approvalResolver:async(_c,r)=>({approved:true,userId:r.userId,level:r.level,reference:r.approvalReference,revision:'1'})});
  assert.ok(host?.http&&host.grants&&host.entitlementResolver&&host.grantPaymentConflict);
  const core=createPostgresCore(tracked,{schema,appId,entitlementResolver:host.entitlementResolver,grantPaymentConflict:host.grantPaymentConflict,
    rewards:{recordPaidOrderInTransaction:async()=>{rewardCalls++;}}});
  const user=(await query("SELECT * FROM users WHERE id='synthetic-consumer'")).rows[0];
  const order=await core.createOrder(user,{planId:'basic',consent:true,form:{name:'SYNTHETIC',phone:'13800000000',city:'上海'}},randomUUID());
  const remote={appid:appId,mchid:'1234567890',out_trade_no:order.id.slice(2),transaction_id:'synthetic-'+randomUUID(),trade_state:'SUCCESS',amount:{currency:'CNY',total:36500},payer:{openid:'synthetic-openid'},success_time:new Date().toISOString()};
  const expected={appId,merchantId:'1234567890'};
  const server=createServer(async(req,res)=>{try{if(!await host.http(req,res)){res.writeHead(404);res.end();}}catch{res.writeHead(500);res.end();}});
  await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));
  t.after(()=>new Promise(resolve=>{server.closeAllConnections();server.close(resolve);}));
  const call=(path,body)=>new Promise((resolve,reject)=>{
    const req=request({hostname:'127.0.0.1',port:server.address().port,path:'/api/admin/membership-grants'+path,method:body===undefined?'GET':'POST',headers:{
      Host:new URL(origin).host,Origin:origin,'Content-Type':'application/json','X-Club-Request':'1','X-Club-Actor':'synthetic-admin',Cookie:'club_pg_admin='+'a'.repeat(64)
    }},res=>{const chunks=[];res.on('data',b=>chunks.push(b));res.on('end',()=>{try{resolve({status:res.statusCode,data:JSON.parse(Buffer.concat(chunks).toString())});}catch(error){reject(error);}});});
    req.on('error',reject);req.end(body===undefined?undefined:JSON.stringify(body));
  });
  const preflight=await call('/preflight',input);assert.equal(preflight.status,200);assert.equal(preflight.data.ready,true);
  const confirmation={...input,idempotencyKey:randomUUID(),confirmationToken:preflight.data.confirmationToken};
  return {pool,schema,query,host,core,user,order,remote,expected,call,confirmation,attempts,rewardCalls:()=>rewardCalls,
    arm:match=>{assert.equal(pause,null);pause={match,entered:deferred(),release:deferred()};return pause;},
    waitOnLock:async from=>{let attempt;await poll(()=>{attempt=attempts.slice(from).find(x=>x.sql==='LOCK TABLE users IN SHARE ROW EXCLUSIVE MODE');return !!attempt;},'second users-table lock attempted');
      await poll(async()=>Number((await pool.query('SELECT cardinality(pg_blocking_pids($1)) AS n',[attempt.pid])).rows[0].n)>0,'second writer actually waits');}
  };
}

test('actual core payment wins users-table lock, grant-host HTTP confirmation waits and rejects overlap', {skip},async t=>{
  const f=await fixture(t),gate=f.arm(/^SELECT \* FROM payment_receipts WHERE transaction_id=/);
  const paying=f.core.applyPayment(f.remote,f.expected);paying.catch(()=>{});await bounded(gate.entered.promise,'actual payment has users-table lock');
  const from=f.attempts.length,granting=f.call('',f.confirmation);granting.catch(()=>{});
  try{await f.waitOnLock(from);}finally{gate.release.resolve();}
  assert.equal((await paying).outcome,'activated');const grant=await granting;
  assert.equal(grant.status,409);assert.equal(grant.data.code,'PREFLIGHT_BLOCKED');
  assert.equal((await f.query('SELECT * FROM collab_grants')).rows.length,0);
  assert.equal((await f.query('SELECT * FROM collab_grant_batches')).rows.length,0);
  assert.equal((await f.query('SELECT plan_id FROM memberships')).rows[0].plan_id,'basic');
  assert.equal((await f.query('SELECT outcome FROM payment_receipts')).rows[0].outcome,'activated');
  assert.equal((await f.core.order(f.user,f.order.id)).status,'paid');assert.equal(f.rewardCalls(),1);
});

test('actual grant-host wins users-table lock, actual payment retains reconciliation receipt without overwriting gift', {skip},async t=>{
  const f=await fixture(t),gate=f.arm(/^SELECT id,role FROM users WHERE id=\$1 FOR UPDATE$/);
  const granting=f.call('',f.confirmation);granting.catch(()=>{});await bounded(gate.entered.promise,'grant issue holds users-table lock');
  const from=f.attempts.length,paying=f.core.applyPayment(f.remote,f.expected);paying.catch(()=>{});
  try{await f.waitOnLock(from);}finally{gate.release.resolve();}
  const grant=await granting;assert.equal(grant.status,200,JSON.stringify(grant.data));assert.equal(grant.data.level,'star');
  assert.equal((await paying).outcome,'needs_reconciliation');
  assert.equal((await f.query('SELECT * FROM memberships')).rows.length,0);
  assert.equal((await f.query('SELECT level FROM collab_grants')).rows[0].level,'star');
  assert.equal((await f.query('SELECT outcome FROM payment_receipts')).rows[0].outcome,'needs_reconciliation');
  assert.equal((await f.core.order(f.user,f.order.id)).status,'pending');assert.equal(f.rewardCalls(),0);
  assert.equal((await f.query("SELECT referral_locked_at FROM users WHERE id='synthetic-consumer'")).rows[0].referral_locked_at,null);
  assert.equal((await f.core.me(f.user)).displayMembership.planId,'star');
  assert.equal((await f.core.applyPayment(f.remote,f.expected)).duplicate,true);
  const replay=await f.call('',f.confirmation);assert.equal(replay.status,200);assert.equal(replay.data.duplicate,true);assert.equal(replay.data.grantId,grant.data.grantId);
  const recovered=await f.call('/operations/'+f.confirmation.idempotencyKey);assert.equal(recovered.status,200);
  assert.equal(recovered.data.found,true);assert.equal(recovered.data.outcome,'committed');
  assert.equal(recovered.data.grant.grantId,grant.data.grantId);
  assert.equal((await f.query('SELECT count(*)::int AS n FROM payment_receipts')).rows[0].n,1);
});
