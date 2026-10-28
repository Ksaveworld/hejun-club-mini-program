import test from 'node:test';
import assert from 'node:assert/strict';
import {randomUUID} from 'node:crypto';
import {fixture} from './fixture.mjs';
import {createSingleGrants} from '../../server/collaboration/single-grants.mjs';
import {createGrantIdentityVerifier} from '../../server/collaboration/grant-identity.mjs';

const policy={approved:true,startRule:'confirmation-time',timeZone:'Asia/Shanghai',yearRule:'calendar-anniversary-clamp',overlap:'block-active',version:'SYNTHETIC-v1'};
const input={userId:'person-a',level:'star',reason:'SYNTHETIC single grant',approvalReference:'SYNTHETIC-approval-a'};
async function setup(t) {
  const f=await fixture(t);
  await f.pg.exec("INSERT INTO users(id,username,password_hash,role,created_at,referral_code,consent_version) VALUES('person-a','same_name_a','synthetic','member','2026','REF-A','fixture'),('person-b','same_name_b','synthetic','member','2026','REF-B','fixture'); INSERT INTO wechat_identities VALUES('synthetic-app','openid-a','person-a','2026'),('synthetic-app','openid-b','person-b','2026')");
  let now='2026-10-28T10:00:00.000Z';
  const facts={identity:true,approved:true,revision:'1',multiple:false};
  const resolveEvidence=async(_c,{userId})=>facts.multiple?[{},{}]:({verified:facts.identity,userId,appId:'synthetic-app',openId:userId==='person-a'?'openid-a':'openid-b',reference:'SYNTHETIC-person-check',revision:facts.revision});
  const options={policy,clock:()=>now,confirmationSecret:'SYNTHETIC-ONLY-SECRET-32-BYTES-LONG',writesEnabled:true,writeCoordinationReady:true,
    identityVerifier:createGrantIdentityVerifier({resolveEvidence}),approvalResolver:async(_c,r)=>({approved:facts.approved,userId:r.userId,level:'star',reference:r.approvalReference,revision:facts.revision})};
  const service=createSingleGrants(f.access,options);
  return {...f,service,options,facts,setNow:v=>{now=v},request:async(body=input)=>{const p=await service.preflight(f.admin,body);return {...body,idempotencyKey:randomUUID(),confirmationToken:p.confirmationToken};}};
}
const code=c=>e=>e.code===c;

test('single grant confirms once at server time, survives expired-token replay and leaves paid tables unchanged',async t=>{
  const f=await setup(t),before=JSON.stringify((await f.pg.query('SELECT * FROM users ORDER BY id')).rows);
  const request=await f.request();f.setNow('2026-10-28T10:01:00.000Z');
  const first=await f.service.issue(f.admin,request);
  assert.equal(first.startsAt,'2026-10-28T10:01:00.000Z');assert.equal(first.expiresAt,'2027-10-28T10:01:00.000Z');
  assert.equal(first.duplicate,false);assert.equal(first.effectiveEntitlements.active,true);
  f.setNow('2026-10-28T11:00:00.000Z');const replay=await f.service.issue(f.admin,request);
  assert.equal(replay.grantId,first.grantId);assert.equal(replay.startsAt,first.startsAt);assert.equal(replay.duplicate,true);
  assert.equal((await f.pg.query('SELECT * FROM collab_grants')).rows.length,1);
  for(const table of ['orders','memberships','payment_receipts'])assert.equal((await f.pg.query(`SELECT * FROM ${table}`)).rows.length,0);
  assert.equal(JSON.stringify((await f.pg.query('SELECT * FROM users ORDER BY id')).rows),before);
  assert.equal((await f.pg.query("SELECT * FROM audit_log WHERE action='collab.grant.issued'")).rows.length,1);
});

test('all methods require a current server-authenticated platform session',async t=>{
  const f=await setup(t),request=await f.request(),fake={id:'admin',role:'admin'};
  for(const call of [()=>f.service.lookup(fake,{type:'userId',value:'person-a'}),()=>f.service.preflight(fake,input),()=>f.service.issue(fake,request),()=>f.service.list(fake),()=>f.service.revoke(fake,'missing',{reason:'test'})])await assert.rejects(call,code('AUTH_REQUIRED'));
  await f.pg.query("UPDATE users SET role='member' WHERE id='admin'");
  await assert.rejects(f.service.issue(f.admin,request),code('FORBIDDEN'));
  await f.pg.query("DELETE FROM sessions WHERE user_id='admin'");
  await assert.rejects(f.service.list(f.admin),code('AUTH_REQUIRED'));
});

test('default-off writes and missing shared payment lock cannot issue or revoke; reads remain usable',async t=>{
  const f=await setup(t),request=await f.request();
  for(const [options,expected] of [[{writesEnabled:false},'FEATURE_DISABLED'],[{writeCoordinationReady:false},'WRITE_COORDINATION_REQUIRED']]) {
    const svc=createSingleGrants(f.access,{...f.options,...options});
    await assert.rejects(svc.issue(f.admin,request),code(expected));await assert.rejects(svc.revoke(f.admin,'none',{reason:'test'}),code(expected));
    assert.deepEqual((await svc.list(f.admin)).items,[]);
  }
});

test('exact userId lookup requires independent verified evidence and existing WeChat binding',async t=>{
  const f=await setup(t);
  assert.equal((await f.service.lookup(f.admin,{type:'userId',value:'person-a'})).verified,true);
  f.facts.identity=false;assert.equal((await f.service.lookup(f.admin,{type:'userId',value:'person-a'})).verified,false);
  f.facts.identity=true;f.facts.multiple=true;
  assert.equal((await f.service.lookup(f.admin,{type:'userId',value:'person-a'})).blockers[0].code,'IDENTITY_AMBIGUOUS');
  f.facts.multiple=false;await f.pg.query("DELETE FROM wechat_identities WHERE user_id='person-a'");
  assert.equal((await f.service.preflight(f.admin,input)).ready,false);
  await assert.rejects(f.service.lookup(f.admin,{type:'name',value:'same name'}),code('INVALID_REQUEST'));
  const noProof=createSingleGrants(f.access,{...f.options,identityVerifier:undefined,approvalResolver:undefined});
  assert.equal((await noProof.preflight(f.admin,input)).ready,false);
  assert.equal((await f.service.lookup(f.admin,{type:'userId',value:'missing'})).verified,false);
});

test('single-only requests reject arrays, supplied role, supplied time and approved flag',async t=>{
  const f=await setup(t);
  for(const invalid of [[input],{...input,userIds:['person-a']},{...input,role:'admin'},{...input,approved:true},{...input,startsAt:'2026-01-01T00:00:00Z'}])await assert.rejects(f.service.preflight(f.admin,invalid),code('INVALID_REQUEST'));
  const operational=await f.account('SYNTHETIC-org','synthetic_operator');
  assert.equal((await f.service.preflight(f.admin,{...input,userId:operational.user.id})).ready,false);
  await assert.rejects(f.service.list(operational.actor),code('FORBIDDEN'));
});

test('signed token rejects tampering, expiry, target/reason changes and changed approval evidence',async t=>{
  const f=await setup(t),request=await f.request();
  assert.ok(!Buffer.from(request.confirmationToken.split('.')[0],'base64url').toString().includes('openid'));
  await assert.rejects(f.service.issue(f.admin,{...request,confirmationToken:request.confirmationToken+'x'}),code('CONFIRMATION_INVALID'));
  await assert.rejects(f.service.issue(f.admin,{...request,userId:'person-b'}),code('PREFLIGHT_CHANGED'));
  await assert.rejects(f.service.issue(f.admin,{...request,reason:'different'}),code('PREFLIGHT_CHANGED'));
  f.facts.revision='2';await assert.rejects(f.service.issue(f.admin,request),code('PREFLIGHT_CHANGED'));f.facts.revision='1';
  f.setNow('2026-10-28T10:05:00.000Z');await assert.rejects(f.service.issue(f.admin,request),code('CONFIRMATION_EXPIRED'));
  assert.equal((await f.pg.query('SELECT * FROM collab_grant_batches')).rows.length,0);
});

test('changed policy, revoked approval and identity block confirmation',async t=>{
  const f=await setup(t),request=await f.request();
  const next=createSingleGrants(f.access,{...f.options,policy:{...policy,version:'SYNTHETIC-v2'}});
  await assert.rejects(next.issue(f.admin,request),code('PREFLIGHT_CHANGED'));
  f.facts.approved=false;await assert.rejects(f.service.issue(f.admin,request),code('PREFLIGHT_BLOCKED'));
  f.facts.approved=true;f.facts.identity=false;await assert.rejects(f.service.issue(f.admin,request),code('PREFLIGHT_BLOCKED'));
});

test('overlap blocks a future paid interval, new keys cannot bypass grants, reused keys conflict',async t=>{
  const f=await setup(t),request=await f.request();await f.service.issue(f.admin,request);
  await assert.rejects(f.service.issue(f.admin,{...request,idempotencyKey:randomUUID()}),code('PREFLIGHT_BLOCKED'));
  await assert.rejects(f.service.issue(f.admin,{...request,userId:'person-b'}),code('IDEMPOTENCY_CONFLICT'));
  await f.pg.exec("INSERT INTO orders(id,user_id,plan_id,amount_cents,status,profile_json,created_at,idempotency_key,request_hash) VALUES('paid-b','person-b','basic',36500,'paid','{}','2026','test','test'); INSERT INTO memberships VALUES('person-b','paid-b','basic','2027-01-01T00:00:00.000Z','2028-01-01T00:00:00.000Z')");
  const pre=await f.service.preflight(f.admin,{...input,userId:'person-b'});assert.equal(pre.ready,false);assert.ok(pre.blockers.some(x=>x.code==='EXISTING_ENTITLEMENT'));
});

test('audit failure rolls back grant and idempotency reservation together',async t=>{
  const f=await setup(t),request=await f.request();f.faults.audit=true;
  await assert.rejects(f.service.issue(f.admin,request),/audit failure/);f.faults.audit=false;
  for(const table of ['collab_grants','collab_grant_batches'])assert.equal((await f.pg.query(`SELECT * FROM ${table}`)).rows.length,0);
  assert.equal((await f.service.issue(f.admin,request)).duplicate,false);
});

test('revoke retains other paid source, records once, and survives write-switch rollback',async t=>{
  const f=await setup(t),g=await f.service.issue(f.admin,await f.request());
  await f.pg.exec("INSERT INTO orders(id,user_id,plan_id,amount_cents,status,profile_json,created_at,idempotency_key,request_hash) VALUES('paid-a','person-a','basic',36500,'paid','{}','2026','test','test'); INSERT INTO memberships VALUES('person-a','paid-a','basic','2026-01-01T00:00:00.000Z','2028-01-01T00:00:00.000Z')");
  const revoked=await f.service.revoke(f.admin,g.grantId,{reason:'SYNTHETIC revoke'});
  assert.equal(revoked.status,'revoked');assert.deepEqual(revoked.effectiveEntitlements.planIds,['basic']);
  assert.equal((await f.service.revoke(f.admin,g.grantId,{reason:'retry'})).duplicate,true);
  assert.equal((await f.pg.query("SELECT * FROM audit_log WHERE action='collab.grant.revoked'")).rows.length,1);
  const off=createSingleGrants(f.access,{...f.options,writesEnabled:false});assert.equal((await off.list(f.admin,{status:'revoked'})).items.length,1);
});

test('history cursor is ordered, bounded, filter-bound and expiry is calculated at its snapshot time',async t=>{
  const f=await setup(t);const a=await f.service.issue(f.admin,await f.request());
  const b=await f.service.issue(f.admin,await f.request({...input,userId:'person-b'}));
  const first=await f.service.list(f.admin,{limit:1,status:'active'});assert.equal(first.items.length,1);assert.ok(first.nextCursor);
  f.setNow('2027-10-28T10:00:00.000Z');const second=await f.service.list(f.admin,{limit:1,status:'active',cursor:first.nextCursor});
  assert.equal(second.items.length,1);assert.notEqual(first.items[0].grantId,second.items[0].grantId);
  assert.equal((await f.service.list(f.admin,{status:'expired'})).items.length,2);
  await assert.rejects(f.service.list(f.admin,{status:'revoked',cursor:first.nextCursor}),code('INVALID_REQUEST'));
  await assert.rejects(f.service.list(f.admin,{limit:101}),code('INVALID_REQUEST'));
  assert.deepEqual(new Set([first.items[0].grantId,second.items[0].grantId]),new Set([a.grantId,b.grantId]));
});

test('minimal installation without association tables supports consumer checks',async t=>{
  const f=await setup(t);await f.pg.exec('DROP TABLE collab_accounts');
  assert.equal((await f.service.lookup(f.admin,{type:'userId',value:'person-a'})).verified,true);
  assert.equal((await f.service.issue(f.admin,await f.request())).level,'star');
});

test('paid source shortened by aftercare to an empty interval does not block a new grant',async t=>{
  const f=await setup(t);
  await f.pg.exec("INSERT INTO orders(id,user_id,plan_id,amount_cents,status,profile_json,created_at,idempotency_key,request_hash) VALUES('empty-a','person-a','basic',36500,'paid','{}','2026','test','test'); INSERT INTO memberships VALUES('person-a','empty-a','basic','2027-01-01T00:00:00.000Z','2027-01-01T00:00:00.000Z')");
  assert.equal((await f.service.preflight(f.admin,input)).ready,true);
  assert.deepEqual((await f.service.issue(f.admin,await f.request())).effectiveEntitlements.planIds,['star']);
});
