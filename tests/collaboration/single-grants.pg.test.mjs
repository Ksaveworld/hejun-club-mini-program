import test from 'node:test';
import assert from 'node:assert/strict';
import {randomBytes,randomUUID} from 'node:crypto';
import {readFileSync} from 'node:fs';
import pg from 'pg';
import {digest} from '../../server/domain.mjs';
import {createCollaborationAccess} from '../../server/collaboration/access.mjs';
import {initializeGrantDatabase} from '../../server/collaboration/grant-migration.mjs';
import {createSingleGrants} from '../../server/collaboration/single-grants.mjs';
import {createGrantIdentityVerifier} from '../../server/collaboration/grant-identity.mjs';

// Opt-in only. Never use DATABASE_URL, host defaults, a shared schema or real users.
// No URL => explicit SKIP, not a concurrency pass. Wrong URL => FAIL before connecting.
const url=process.env.GRANT_TEST_DATABASE_URL;
const skip=url?false:'UNVERIFIED: set GRANT_TEST_DATABASE_URL for an isolated local grant_test PostgreSQL database';
const NOW='2026-10-28T10:00:00.000Z';
const policy={approved:true,startRule:'confirmation-time',timeZone:'Asia/Shanghai',yearRule:'calendar-anniversary-clamp',overlap:'block-active',version:'SYNTHETIC-PG-v1'};
const input={userId:'synthetic-person',level:'star',reason:'SYNTHETIC PG grant',approvalReference:'SYNTHETIC-PG-approval'};
function validateUrl(value){
  const parsed=new URL(value);
  assert.ok(['postgres:','postgresql:'].includes(parsed.protocol),'PostgreSQL URL required');
  assert.ok(['127.0.0.1','localhost'].includes(parsed.hostname),'Only local PostgreSQL is allowed');
  assert.equal(parsed.pathname,'/grant_test','Only the isolated grant_test database is allowed');
  assert.equal(parsed.search,'','Connection-string query overrides are forbidden');
  assert.equal(parsed.hash,'','Connection-string fragment is forbidden');
}
if(url)validateUrl(url);
const code=value=>error=>error.code===value;
function signal(){let resolve;const promise=new Promise(r=>{resolve=r});return {promise,resolve};}
async function bounded(promise,label){
  let timer;try{return await Promise.race([promise,new Promise((_,reject)=>{timer=setTimeout(()=>reject(Error(`Timeout: ${label}`)),5000)})]);}
  finally{clearTimeout(timer);}
}
async function poll(fn,label){
  const deadline=Date.now()+4000;
  while(Date.now()<deadline){if(await fn())return;await new Promise(r=>setTimeout(r,10));}
  assert.fail(`Expected actual PostgreSQL lock wait: ${label}`);
}

async function fixture(t){
  const pool=new pg.Pool({connectionString:url,max:8,connectionTimeoutMillis:5000,statement_timeout:8000,idle_in_transaction_session_timeout:12000,ssl:false});
  const schema='club_migration_grant_'+randomBytes(8).toString('hex');
  assert.match(schema,/^club_migration_grant_[a-f0-9]{16}$/);
  let created=false;
  t.after(async()=>{
    // This exact random schema was created by this fixture; never discover/drop others.
    try{if(created)await pool.query(`DROP SCHEMA "${schema}" CASCADE`);}finally{await pool.end();}
  });
  assert.equal((await pool.query('SELECT current_database() AS name')).rows[0].name,'grant_test');
  await pool.query(`CREATE SCHEMA "${schema}"`);created=true;
  const setup=await pool.connect();
  try{
    await setup.query('BEGIN');await setup.query(`SET LOCAL search_path TO "${schema}"`);
    await setup.query(readFileSync(new URL('../../server/migrations/postgres/001-baseline.sql',import.meta.url),'utf8'));
    await setup.query(`INSERT INTO users(id,username,password_hash,role,created_at,referral_code,consent_version)
      VALUES('synthetic-admin','synthetic-admin','synthetic','admin',$1,'SYNTHETIC-ADMIN','fixture'),
      ('synthetic-person','synthetic-person','synthetic','member',$1,'SYNTHETIC-PERSON','fixture')`,[NOW]);
    await setup.query("INSERT INTO wechat_identities VALUES('synthetic-app','synthetic-openid','synthetic-person',$1)",[NOW]);
    await setup.query('INSERT INTO sessions VALUES($1,$2,$3)',[digest('pg-admin:'+'a'.repeat(64)),'synthetic-admin','2099-01-01T00:00:00.000Z']);
    await setup.query('COMMIT');
  }catch(error){await setup.query('ROLLBACK');throw error;}finally{setup.release();}
  await initializeGrantDatabase(pool,{schema});
  let pause=null;
  const attempts=[];
  const connectionFailures=new Map();
  const tracked={connect:async()=>{
    const client=await pool.connect(),pid=(await client.query('SELECT pg_backend_pid() AS pid')).rows[0].pid;
    // A test can terminate a connection while JS holds its barrier, between SQL
    // calls. pg emits an error event then; retain it and discard this client on
    // release rather than letting an unhandled EventEmitter error crash the run.
    const onError=error=>connectionFailures.set(pid,error);
    client.on('error',onError);
    return {query:async(sql,args)=>{
      if(connectionFailures.has(pid))throw connectionFailures.get(pid);
      attempts.push({pid,sql});const result=await client.query(sql,args);
      if(pause&&/^SELECT id(?:,role)? FROM users WHERE id=\$1 FOR UPDATE$/.test(sql)){
        const gate=pause;pause=null;gate.entered.resolve(pid);await bounded(gate.release.promise,'release synthetic transaction barrier');
      }
      return result;
    },release:error=>{client.removeListener('error',onError);client.release(error??connectionFailures.get(pid));}};
  }};
  const access=createCollaborationAccess(tracked,{schema,clock:()=>NOW});
  const admin=await access.authenticate({headers:{cookie:'club_pg_admin='+'a'.repeat(64)}});
  const service=createSingleGrants(access,{policy,clock:()=>NOW,confirmationSecret:'SYNTHETIC-PG-SECRET-32-BYTES-ONLY',writesEnabled:true,writeCoordinationReady:true,
    identityVerifier:createGrantIdentityVerifier({resolveEvidence:async(_c,{userId})=>({verified:true,userId,appId:'synthetic-app',openId:'synthetic-openid',reference:'SYNTHETIC-PG-person-check',revision:'1'})}),
    // Immutable synthetic facts; production adapters must lock their evidence rows.
    approvalResolver:async(_c,r)=>({approved:true,userId:r.userId,level:r.level,reference:r.approvalReference,revision:'1'})});
  async function tx(){
    const c=await pool.connect();await c.query('BEGIN');await c.query(`SET LOCAL search_path TO "${schema}"`);
    return c;
  }
  async function query(sql,args=[]){const c=await tx();try{const r=await c.query(sql,args);await c.query('COMMIT');return r;}catch(error){await c.query('ROLLBACK');throw error;}finally{c.release();}}
  const f={pool,schema,service,admin,attempts,connectionFailures,tx,query,
    request:async(body=input)=>({...body,idempotencyKey:randomUUID(),confirmationToken:(await service.preflight(admin,body)).confirmationToken}),
    pauseTarget:()=>{assert.equal(pause,null);pause={entered:signal(),release:signal()};return pause;},
    blocked:async(pid,label)=>poll(async()=>Number((await pool.query('SELECT cardinality(pg_blocking_pids($1)) AS n',[pid])).rows[0].n)>0,label),
    attempted:async(from,pattern)=>{let attempt;await poll(()=>{attempt=attempts.slice(from).find(a=>pattern.test(a.sql));return !!attempt;},'contending query started');return attempt.pid;}
  };
  return f;
}
async function pausedIssue(f,request){
  const gate=f.pauseTarget(),operation=f.service.issue(f.admin,request);operation.catch(()=>{});
  const pid=await bounded(gate.entered.promise,'first grant holds target lock');return {gate,operation,pid};
}
async function counts(f){
  return (await f.query(`SELECT (SELECT count(*) FROM collab_grants)::int AS grants,
    (SELECT count(*) FROM collab_grant_batches)::int AS batches,
    (SELECT count(*) FROM audit_log WHERE action='collab.grant.issued')::int AS issued,
    (SELECT count(*) FROM audit_log WHERE action='collab.grant.revoked')::int AS revoked`)).rows[0];
}

test('PG real connections: same idempotency key waits then returns one unchanged grant', {skip},async t=>{
  const f=await fixture(t),request=await f.request(),first=await pausedIssue(f,request);
  const from=f.attempts.length,second=f.service.issue(f.admin,request);second.catch(()=>{});
  try{await f.blocked(await f.attempted(from,/^INSERT INTO collab_grant_batches/),'same-key reservation');}finally{first.gate.release.resolve();}
  const [a,b]=await Promise.all([first.operation,second]);
  assert.equal(a.grantId,b.grantId);assert.equal(a.startsAt,b.startsAt);assert.equal(a.expiresAt,b.expiresAt);
  assert.equal(a.duplicate,false);assert.equal(b.duplicate,true);
  assert.deepEqual(await counts(f),{grants:1,batches:1,issued:1,revoked:0});
});

test('PG real connections: different keys on one user serialize and cannot bypass overlap', {skip},async t=>{
  const f=await fixture(t),request=await f.request(),first=await pausedIssue(f,request);
  const from=f.attempts.length,second=f.service.issue(f.admin,{...request,idempotencyKey:randomUUID()});second.catch(()=>{});
  try{await f.blocked(await f.attempted(from,/^SELECT id,role FROM users .*FOR UPDATE$/),'same target with another key');}finally{first.gate.release.resolve();}
  await first.operation;await assert.rejects(second,code('PREFLIGHT_BLOCKED'));
  assert.deepEqual(await counts(f),{grants:1,batches:1,issued:1,revoked:0});
});

test('PG basic grant persists basic, replays once and cannot change to star with the same key', {skip},async t=>{
  const f=await fixture(t),request=await f.request({...input,level:'basic'});
  const first=await f.service.issue(f.admin,request);assert.equal(first.level,'basic');
  assert.deepEqual(first.effectiveEntitlements.planIds,['basic']);
  assert.equal((await f.query('SELECT level FROM collab_grants')).rows[0].level,'basic');
  const replay=await f.service.issue(f.admin,request);assert.equal(replay.grantId,first.grantId);assert.equal(replay.duplicate,true);
  await assert.rejects(f.service.issue(f.admin,{...request,level:'star'}),code('IDEMPOTENCY_CONFLICT'));
  assert.deepEqual(await counts(f),{grants:1,batches:1,issued:1,revoked:0});
});

test('PG real transaction: audit trigger failure rolls back grant and reservation and permits same-key retry', {skip},async t=>{
  const f=await fixture(t),request=await f.request();
  await f.query(`CREATE FUNCTION synthetic_reject_audit() RETURNS trigger LANGUAGE plpgsql AS $$
    BEGIN RAISE EXCEPTION 'SYNTHETIC audit failure'; END $$`);
  await f.query('CREATE TRIGGER synthetic_reject_audit BEFORE INSERT ON audit_log FOR EACH ROW EXECUTE FUNCTION synthetic_reject_audit()');
  await assert.rejects(f.service.issue(f.admin,request),/SYNTHETIC audit failure/);
  assert.deepEqual(await counts(f),{grants:0,batches:0,issued:0,revoked:0});
  await f.query('DROP TRIGGER synthetic_reject_audit ON audit_log');
  assert.equal((await f.service.issue(f.admin,request)).duplicate,false);
  assert.deepEqual(await counts(f),{grants:1,batches:1,issued:1,revoked:0});
});

test('PG real connection loss: terminating a held transaction rolls back reservation and same-key retry succeeds', {skip},async t=>{
  const f=await fixture(t),request=await f.request(),first=await pausedIssue(f,request);
  try{
    const terminated=(await f.pool.query('SELECT pg_terminate_backend($1) AS terminated',[first.pid])).rows[0].terminated;
    assert.equal(terminated,true);
    await poll(()=>f.connectionFailures.has(first.pid),'terminated test connection reports its error');
  }finally{first.gate.release.resolve();}
  await assert.rejects(first.operation,error=>error.code==='57P01'||/terminat|closed|connection/i.test(error.message));
  assert.deepEqual(await counts(f),{grants:0,batches:0,issued:0,revoked:0});
  assert.equal((await f.service.issue(f.admin,request)).duplicate,false);
  assert.deepEqual(await counts(f),{grants:1,batches:1,issued:1,revoked:0});
});

test('PG real connections: concurrent revocations serialize and audit success only once', {skip},async t=>{
  const f=await fixture(t),grant=await f.service.issue(f.admin,await f.request()),gate=f.pauseTarget();
  const first=f.service.revoke(f.admin,grant.grantId,{reason:'SYNTHETIC revoke'});first.catch(()=>{});
  await bounded(gate.entered.promise,'first revoke holds target');
  const from=f.attempts.length,second=f.service.revoke(f.admin,grant.grantId,{reason:'SYNTHETIC retry'});second.catch(()=>{});
  try{await f.blocked(await f.attempted(from,/^SELECT id FROM users .*FOR UPDATE$/),'revoke target');}finally{gate.release.resolve();}
  const [a,b]=await Promise.all([first,second]);assert.equal(a.duplicate,false);assert.equal(b.duplicate,true);
  assert.equal(a.status,'revoked');assert.equal(b.status,'revoked');
  assert.deepEqual(await counts(f),{grants:1,batches:1,issued:1,revoked:1});
});

test('PG real connections: revoke racing stale grant confirmation forces renewed preflight', {skip},async t=>{
  const f=await fixture(t),stale=await f.request(),grant=await f.service.issue(f.admin,stale),gate=f.pauseTarget();
  const revoking=f.service.revoke(f.admin,grant.grantId,{reason:'SYNTHETIC revoke'});revoking.catch(()=>{});
  await bounded(gate.entered.promise,'revoke holds target');
  const from=f.attempts.length,issuing=f.service.issue(f.admin,{...stale,idempotencyKey:randomUUID()});issuing.catch(()=>{});
  try{await f.blocked(await f.attempted(from,/^SELECT id,role FROM users .*FOR UPDATE$/),'grant waits for revoke');}finally{gate.release.resolve();}
  await revoking;await assert.rejects(issuing,code('PREFLIGHT_CHANGED'));
  assert.deepEqual(await counts(f),{grants:1,batches:1,issued:1,revoked:1});
});

test('PG real connections: grant holds administrator role lock; later revocation blocks future access', {skip},async t=>{
  const f=await fixture(t),request=await f.request(),first=await pausedIssue(f,request),c=await f.tx();
  const pid=(await c.query('SELECT pg_backend_pid() AS pid')).rows[0].pid;
  const updating=c.query("UPDATE users SET role='member' WHERE id='synthetic-admin'");updating.catch(()=>{});
  try{
    try{await f.blocked(pid,'administrator role revocation waits for grant');}finally{first.gate.release.resolve();}
    await first.operation;await updating;await c.query('COMMIT');
  }catch(error){await c.query('ROLLBACK');throw error;}finally{c.release();}
  await assert.rejects(f.service.list(f.admin),code('FORBIDDEN'));
  assert.deepEqual(await counts(f),{grants:1,batches:1,issued:1,revoked:0});
});

test('PG real connections: role revoked first makes a waiting grant fail without writes', {skip},async t=>{
  const f=await fixture(t),request=await f.request(),c=await f.tx();
  await c.query("UPDATE users SET role='member' WHERE id='synthetic-admin'");
  const from=f.attempts.length,issuing=f.service.issue(f.admin,request);issuing.catch(()=>{});
  try{
    await f.blocked(await f.attempted(from,/FOR SHARE OF s,u$/),'grant waits for changed admin role');
    await c.query('COMMIT');
  }catch(error){await c.query('ROLLBACK');throw error;}finally{c.release();}
  await assert.rejects(issuing,code('FORBIDDEN'));
  assert.deepEqual(await counts(f),{grants:0,batches:0,issued:0,revoked:0});
});

// Synthetic payment-protocol writer ONLY. This is not the host's real payment,
// renewal, callback, refund or reconciliation implementation, and cannot prove
// their integration. It exercises the mandatory shared user-row locking contract.
async function insertSyntheticPaid(c){
  await c.query(`INSERT INTO orders(id,user_id,plan_id,amount_cents,status,profile_json,created_at,idempotency_key,request_hash)
    VALUES('synthetic-paid','synthetic-person','basic',36500,'paid','{}',$1,'synthetic-paid-key','synthetic-paid-hash')`,[NOW]);
  await c.query("INSERT INTO memberships VALUES('synthetic-person','synthetic-paid','basic',$1,'2027-10-28T10:00:00.000Z')",[NOW]);
}

test('PG protocol only: paid writer wins shared user lock, later grant blocks without overwriting paid membership', {skip},async t=>{
  const f=await fixture(t),request=await f.request(),c=await f.tx();
  await c.query("SELECT id FROM users WHERE id='synthetic-person' FOR UPDATE");
  const from=f.attempts.length,issuing=f.service.issue(f.admin,request);issuing.catch(()=>{});
  try{
    await f.blocked(await f.attempted(from,/^SELECT id,role FROM users .*FOR UPDATE$/),'grant waits for synthetic paid writer');
    await insertSyntheticPaid(c);await c.query('COMMIT');
  }catch(error){await c.query('ROLLBACK');throw error;}finally{c.release();}
  await assert.rejects(issuing,code('PREFLIGHT_BLOCKED'));
  assert.deepEqual(await counts(f),{grants:0,batches:0,issued:0,revoked:0});
  assert.equal((await f.query('SELECT plan_id FROM memberships')).rows[0].plan_id,'basic');
});

test('PG protocol only: grant wins shared user lock, synthetic paid writer observes grant and blocks', {skip},async t=>{
  const f=await fixture(t),first=await pausedIssue(f,await f.request()),c=await f.tx();
  const pid=(await c.query('SELECT pg_backend_pid() AS pid')).rows[0].pid;
  const locking=c.query("SELECT id FROM users WHERE id='synthetic-person' FOR UPDATE");locking.catch(()=>{});
  try{
    try{await f.blocked(pid,'synthetic paid writer waits for grant');}finally{first.gate.release.resolve();}
    await first.operation;await locking;
    const overlapping=(await c.query("SELECT id FROM collab_grants WHERE user_id='synthetic-person' AND status='active' AND starts_at<=$1 AND expires_at>$1",[NOW])).rows;
    assert.equal(overlapping.length,1);
    // A real paid callback needs an approved conflict policy; this protocol
    // fixture deliberately rejects before any synthetic order/member write.
    await c.query('ROLLBACK');
  }catch(error){await c.query('ROLLBACK');throw error;}finally{c.release();}
  assert.equal((await f.query('SELECT * FROM memberships')).rows.length,0);
  assert.equal((await f.query('SELECT * FROM orders')).rows.length,0);
  assert.deepEqual(await counts(f),{grants:1,batches:1,issued:1,revoked:0});
});
