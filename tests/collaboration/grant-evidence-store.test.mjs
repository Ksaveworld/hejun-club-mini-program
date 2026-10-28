import test from 'node:test';
import assert from 'node:assert/strict';
import {randomUUID} from 'node:crypto';
import {fixture} from './fixture.mjs';
import {createCollaborationAccess} from '../../server/collaboration/access.mjs';
import {initializeGrantEvidenceDatabase,validateGrantEvidenceDatabase,createGrantEvidenceStore,grantEvidenceMigration,grantEvidenceTables} from '../../server/collaboration/grant-evidence-store.mjs';
import {createSingleGrants} from '../../server/collaboration/single-grants.mjs';
const code=c=>e=>e.code===c;
const policy={approved:true,startRule:'confirmation-time',timeZone:'Asia/Shanghai',yearRule:'calendar-anniversary-clamp',overlap:'block-active',version:'SYNTHETIC-v1'};
const identity={userId:'person-a',appId:'synthetic-app',openId:'openid-a',evidenceReference:'SYNTHETIC-IN-PERSON-01',expiresAt:'2026-11-28T10:00:00.000Z',expectedRevision:0};
const approval={userId:'person-a',level:'star',reference:'SYNTHETIC-APPROVAL-01',expiresAt:'2026-11-28T10:00:00.000Z',expectedRevision:0};
const grant={userId:'person-a',level:'star',reason:'SYNTHETIC grant',approvalReference:approval.reference};
async function setup(t){
 const f=await fixture(t);let time='2026-10-28T10:00:00.000Z';
 await f.pg.exec("INSERT INTO users(id,username,password_hash,role,created_at,referral_code,consent_version) VALUES('person-a','synthetic-person','synthetic','member','2026','REF-A','fixture');INSERT INTO wechat_identities VALUES('synthetic-app','openid-a','person-a','2026');ALTER TABLE collab_grants DROP CONSTRAINT collab_grants_level_check;ALTER TABLE collab_grants ADD CONSTRAINT collab_grants_level_check CHECK(level IN ('basic','star'))");
 await initializeGrantEvidenceDatabase(f.pool,{schema:f.schema});
 const liveAccess=createCollaborationAccess(f.pool,{schema:f.schema,clock:()=>time});
 const admin=await liveAccess.authenticate({headers:{cookie:'club_pg_admin='+'a'.repeat(64)}});
 const store=createGrantEvidenceStore(liveAccess,{clock:()=>time,writesEnabled:true});
 const access={...liveAccess,writeRun:fn=>liveAccess.run(async c=>{await c.query('LOCK TABLE users IN SHARE ROW EXCLUSIVE MODE');return fn(c);})};
 const svc=createSingleGrants(access,{policy,clock:()=>time,confirmationSecret:'SYNTHETIC-ONLY-SECRET-32-BYTES-LONG',writesEnabled:true,writeCoordinationReady:true,
  identityVerifier:store.identityVerifier,approvalResolver:store.approvalResolver,phoneResolver:store.phoneResolver});
 return {...f,access:liveAccess,admin,store,svc,setTime:t=>time=t,
  account:async(...args)=>{const r=await f.account(...args);await f.pg.query("UPDATE sessions SET expires_at='2099-01-01T00:00:00.000Z' WHERE user_id=$1",[r.user.id]);return {...r,actor:await liveAccess.authenticate(r.req)};},
  seed:async()=>{await store.recordIdentity(admin,identity);await store.recordApproval(admin,approval);},
  request:async input=>({...input,idempotencyKey:randomUUID(),confirmationToken:(await svc.preflight(admin,input)).confirmationToken})};
}
test('explicit migration is idempotent, preserves rows, rejects hash/schema drift and missing/partial adoption',async t=>{
 const f=await setup(t);await f.seed();
 await initializeGrantEvidenceDatabase(f.pool,{schema:f.schema});await validateGrantEvidenceDatabase(f.pool,{schema:f.schema});
 assert.equal((await f.pg.query('SELECT * FROM grant_person_evidence')).rows.length,1);
 await f.pg.query('ALTER TABLE grant_person_evidence ADD COLUMN unexpected TEXT');
 await assert.rejects(validateGrantEvidenceDatabase(f.pool,{schema:f.schema}),code('EVIDENCE_MIGRATION_INCONSISTENT'));
 await f.pg.query('ALTER TABLE grant_person_evidence DROP COLUMN unexpected');
 const marker=(await f.pg.query('SELECT value FROM settings WHERE key=$1',[grantEvidenceMigration.key])).rows[0].value;
 await f.pg.query('UPDATE settings SET value=$2 WHERE key=$1',[grantEvidenceMigration.key,marker.replace(grantEvidenceMigration.sha256,'tampered')]);
 await assert.rejects(initializeGrantEvidenceDatabase(f.pool,{schema:f.schema}),code('EVIDENCE_MIGRATION_INCONSISTENT'));
 await f.pg.query('DELETE FROM settings WHERE key=$1',[grantEvidenceMigration.key]);
 await assert.rejects(initializeGrantEvidenceDatabase(f.pool,{schema:f.schema}),code('EVIDENCE_MIGRATION_INCONSISTENT'));
 assert.equal((await f.pg.query('SELECT * FROM grant_person_approvals')).rows.length,1);
});
test('default closed and every mutation/resolver requires server-authenticated current platform administrator',async t=>{
 const f=await setup(t),fake={id:'admin',role:'admin'};
 await assert.rejects(createGrantEvidenceStore(f.access).recordIdentity(f.admin,identity),code('FEATURE_DISABLED'));
 await assert.rejects(f.store.recordIdentity(fake,identity),code('AUTH_REQUIRED'));
 const org=await f.account('SYNTHETIC-ORG','synthetic_operator');
 await assert.rejects(f.store.recordIdentity(org.actor,identity),code('FORBIDDEN'));
 await assert.rejects(f.store.recordApproval(fake,approval),code('AUTH_REQUIRED'));
 await assert.rejects(f.store.revoke(fake,{kind:'identity',id:'person-a',expectedRevision:0,reason:'SYNTHETIC'}),code('AUTH_REQUIRED'));
 await assert.rejects(f.access.run(c=>f.store.resolveEvidence(c,{userId:'person-a',actor:fake,now:'2026-10-28T10:00:00.000Z'})),code('AUTH_REQUIRED'));
 await f.pg.query("DELETE FROM sessions WHERE user_id='admin'");
 await assert.rejects(f.store.recordIdentity(f.admin,identity),code('AUTH_REQUIRED'));
});
test('manual record binds existing consumer WeChat identity and rejects self-reported verification or phone',async t=>{
 const f=await setup(t);
 await assert.rejects(f.store.recordIdentity(f.admin,{...identity,verified:true}),code('INVALID_REQUEST'));
 await assert.rejects(f.store.recordIdentity(f.admin,{...identity,evidenceReference:'x'.repeat(201)}),code('INVALID_REQUEST'));
 await assert.rejects(f.store.recordIdentity(f.admin,{...identity,phone:'+9990000001'}),code('INVALID_REQUEST'));
 await assert.rejects(f.store.recordIdentity(f.admin,{...identity,openId:'other'}),code('IDENTITY_CHANGED'));
 await assert.rejects(f.store.recordIdentity(f.admin,{...identity,userId:'admin'}),code('USER_UNAVAILABLE'));
 await assert.rejects(f.store.recordApproval(f.admin,approval),code('IDENTITY_UNVERIFIED'));
 const first=await f.store.recordIdentity(f.admin,identity),again=await f.store.recordIdentity(f.admin,identity);
 assert.equal(first.revision,1);assert.equal(again.duplicate,true);
 assert.equal((await f.pg.query("SELECT * FROM audit_log WHERE action='grant.identity.recorded'")).rows.length,1);
 assert.equal((await f.svc.lookup(f.admin,{type:'phone',value:'+8613800000000'})).blockers[0].code,'PHONE_VERIFICATION_UNAVAILABLE');
});
test('approval is immutable to user/level, duplicate-safe, and basic/star grants use real persisted evidence',async t=>{
 const f=await setup(t);await f.seed();assert.equal((await f.store.recordApproval(f.admin,approval)).duplicate,true);
 await assert.rejects(f.store.recordApproval(f.admin,{...approval,level:'basic',expectedRevision:1}),code('APPROVAL_CONFLICT'));
 assert.equal((await f.svc.preflight(f.admin,{...grant,level:'basic'})).ready,false);
 const request=await f.request(grant),issued=await f.svc.issue(f.admin,request);
 assert.equal(issued.level,'star');assert.equal((await f.svc.issue(f.admin,request)).duplicate,true);
 await f.svc.revoke(f.admin,issued.grantId,{reason:'SYNTHETIC change tier'});
 await f.store.recordApproval(f.admin,{...approval,reference:'SYNTHETIC-BASIC',level:'basic'});
 const basic={...grant,level:'basic',approvalReference:'SYNTHETIC-BASIC'};
 assert.equal((await f.svc.issue(f.admin,await f.request(basic))).level,'basic');
});
test('changed identity or approval version invalidates preflight; re-verification also requires fresh approval',async t=>{
 const f=await setup(t);await f.seed();const request=await f.request(grant);
 await f.store.recordApproval(f.admin,{...approval,expiresAt:'2026-11-29T10:00:00.000Z',expectedRevision:1});
 await assert.rejects(f.svc.issue(f.admin,request),code('PREFLIGHT_CHANGED'));
 const next=await f.request(grant);
 await f.store.recordIdentity(f.admin,{...identity,evidenceReference:'SYNTHETIC-RECHECK-02',expectedRevision:1});
 assert.equal((await f.svc.preflight(f.admin,grant)).ready,false);
 await assert.rejects(f.svc.issue(f.admin,next));
 await f.store.recordApproval(f.admin,{...approval,expectedRevision:2});
 assert.equal((await f.svc.preflight(f.admin,grant)).ready,true);
 await assert.rejects(f.store.recordIdentity(f.admin,{...identity,expectedRevision:0}),code('VERSION_CONFLICT'));
});
test('expiry, revocation and binding changes fail closed; duplicate revoke has one audit',async t=>{
 const f=await setup(t);await f.seed();
 await f.store.revoke(f.admin,{kind:'approval',id:approval.reference,expectedRevision:1,reason:'SYNTHETIC withdrawn'});
 assert.equal((await f.store.revoke(f.admin,{kind:'approval',id:approval.reference,expectedRevision:1,reason:'SYNTHETIC withdrawn'})).duplicate,true);
 assert.equal((await f.svc.preflight(f.admin,grant)).ready,false);
 assert.equal((await f.pg.query("SELECT * FROM audit_log WHERE action='grant.approval.revoked'")).rows.length,1);
 await f.store.recordApproval(f.admin,{...approval,expectedRevision:2});
 await f.pg.query("DELETE FROM wechat_identities WHERE user_id='person-a'");
 assert.equal((await f.svc.lookup(f.admin,{type:'userId',value:'person-a'})).verified,false);
 await f.pg.query("INSERT INTO wechat_identities VALUES('synthetic-app','openid-a','person-a','2026')");
 f.setTime(identity.expiresAt);assert.equal((await f.svc.preflight(f.admin,grant)).ready,false);
});
test('audit failure rolls back evidence write and revision',async t=>{
 const f=await setup(t);f.faults.audit=true;
 await assert.rejects(f.store.recordIdentity(f.admin,identity),/synthetic audit failure/);
 assert.equal((await f.pg.query('SELECT * FROM grant_person_evidence')).rows.length,0);
 f.faults.audit=false;await f.seed();f.faults.audit=true;
 await assert.rejects(f.store.revoke(f.admin,{kind:'identity',id:'person-a',expectedRevision:1,reason:'SYNTHETIC withdrawn'}));
 const row=(await f.pg.query('SELECT * FROM grant_person_evidence')).rows[0];assert.equal(row.active,true);assert.equal(Number(row.revision),1);
});

test('session or evidence expiry during the write rolls back before commit',async t=>{
 const f=await setup(t);
 const lateAccess={...f.access,run:fn=>f.access.run(c=>fn({query:async(sql,args)=>{
  const result=await c.query(sql,args);
  if(sql.startsWith('INSERT INTO audit_log'))f.setTime('2026-10-28T10:01:00.000Z');
  return result;
 }}))};
 const store=createGrantEvidenceStore(lateAccess,{writesEnabled:true,clock:()=> '2026-10-28T10:00:00.000Z'});
 await f.pg.query("UPDATE sessions SET expires_at='2026-10-28T10:00:30.000Z' WHERE user_id='admin'");
 await assert.rejects(store.recordIdentity(f.admin,identity),code('AUTH_REQUIRED'));
 assert.equal((await f.pg.query('SELECT * FROM grant_person_evidence')).rows.length,0);
 assert.equal((await f.pg.query("SELECT * FROM audit_log WHERE action='grant.identity.recorded'")).rows.length,0);
 f.setTime('2026-10-28T10:00:00.000Z');await f.pg.query("UPDATE sessions SET expires_at='2099-01-01T00:00:00.000Z' WHERE user_id='admin'");
 let expiryClock=0;
 const expiringStore=createGrantEvidenceStore(f.access,{writesEnabled:true,clock:()=>expiryClock++===0?'2026-10-28T10:00:00.000Z':identity.expiresAt});
 await assert.rejects(expiringStore.recordIdentity(f.admin,identity),code('EVIDENCE_EXPIRED'));
 assert.equal((await f.pg.query('SELECT * FROM grant_person_evidence')).rows.length,0);
});

test('fresh-host discovery allows absence and rejects partial installation without adopting it',async t=>{
 const f=await fixture(t);
 assert.deepEqual(await f.access.run(c=>grantEvidenceTables(c,f.schema)),[]);
 await f.pg.query('CREATE TABLE grant_person_evidence (user_id TEXT PRIMARY KEY)');
 await assert.rejects(f.access.run(c=>grantEvidenceTables(c,f.schema)),code('EVIDENCE_MIGRATION_INCONSISTENT'));
 await assert.rejects(initializeGrantEvidenceDatabase(f.pool,{schema:f.schema}),code('EVIDENCE_MIGRATION_INCONSISTENT'));
 assert.equal((await f.pg.query("SELECT COUNT(*) AS n FROM information_schema.columns WHERE table_schema=$1 AND table_name='grant_person_evidence'",[f.schema])).rows[0].n,1);
});
