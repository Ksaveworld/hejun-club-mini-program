import test from 'node:test';
import assert from 'node:assert/strict';
import {randomUUID} from 'node:crypto';
import {readFileSync} from 'node:fs';
import {PGlite} from '@electric-sql/pglite';
import {digest} from '../../server/domain.mjs';
import {createCollaborationAccess} from '../../server/collaboration/access.mjs';
import {createSingleGrants} from '../../server/collaboration/single-grants.mjs';
import {initializeGrantDatabase} from '../../server/collaboration/grant-migration.mjs';
import {createGrantIdentityVerifier,normalizeGrantPhone} from '../../server/collaboration/grant-identity.mjs';

const now='2026-10-28T10:00:00.000Z';
const phone='+8619900000001'; // Synthetic fixture only; never sent to a provider.
const input={userId:'synthetic-person',level:'basic',reason:'SYNTHETIC',approvalReference:'SYNTHETIC-approval'};
async function fixture(t){
  const pg=new PGlite();await pg.waitReady;t.after(()=>pg.close());
  const schema='club_migration_grant_phone';
  await pg.exec(`CREATE SCHEMA ${schema}; SET search_path TO ${schema};`+readFileSync(new URL('../../server/migrations/postgres/001-baseline.sql',import.meta.url),'utf8'));
  let tail=Promise.resolve();const pool={connect:async()=>{const prior=tail;let release;tail=new Promise(r=>{release=r});await prior;return {query:(sql,args)=>args?pg.query(sql,args):pg.exec(sql).then(r=>r.at(-1)),release};}};
  await initializeGrantDatabase(pool,{schema});
  await pg.exec("INSERT INTO users(id,username,password_hash,role,created_at,referral_code,consent_version) VALUES('synthetic-admin','synthetic-admin','synthetic','admin','2026','ADMIN','fixture'),('synthetic-person','synthetic-person','synthetic','member','2026','PERSON','fixture'); INSERT INTO wechat_identities VALUES('synthetic-app','synthetic-openid','synthetic-person','2026')");
  await pg.query('INSERT INTO sessions VALUES($1,$2,$3)',[digest('pg-admin:'+'a'.repeat(64)),'synthetic-admin','2099-01-01T00:00:00.000Z']);
  const access=createCollaborationAccess(pool,{schema,clock:()=>now}),admin=await access.authenticate({headers:{cookie:'club_pg_admin='+'a'.repeat(64)}});
  const match={verified:true,userId:input.userId,phone,reference:'SYNTHETIC-phone-proof',revision:'1'};
  const facts={available:true,matches:[match],allowed:'basic',bound:true};let received;
  const options={policy:{approved:true,version:'SYNTHETIC-v2',startRule:'confirmation-time',timeZone:'Asia/Shanghai',yearRule:'calendar-anniversary-clamp',overlap:'block-active'},clock:()=>now,confirmationSecret:'SYNTHETIC-PHONE-KEY-32-CHARACTERS',writesEnabled:true,writeCoordinationReady:true,
    identityVerifier:createGrantIdentityVerifier({resolveEvidence:async()=>({verified:facts.bound,userId:input.userId,appId:'synthetic-app',openId:'synthetic-openid',reference:'SYNTHETIC-person-proof',revision:'1'})}),
    phoneResolver:async(_c,r)=>{received=r.phone;return {available:facts.available,matches:facts.matches}},
    approvalResolver:async(_c,r)=>({approved:true,userId:r.userId,level:facts.allowed,reference:r.approvalReference,revision:'1'})};
  const service=createSingleGrants(access,options);
  return {pg,pool,access,admin,service,facts,match,options,received:()=>received,request:async(r=input)=>({...r,idempotencyKey:randomUUID(),confirmationToken:(await service.preflight(admin,r)).confirmationToken})};
}

test('basic and star are explicit approved levels; same key cannot change level and tokens cannot change level',async t=>{
  const f=await fixture(t),request=await f.request();
  f.facts.allowed='star';await assert.rejects(f.service.issue(f.admin,{...request,level:'star'}),e=>e.code==='PREFLIGHT_CHANGED');
  f.facts.allowed='basic';const grant=await f.service.issue(f.admin,request);
  assert.equal(grant.level,'basic');assert.equal(grant.effectiveEntitlements.displayMembership.planId,'basic');
  assert.equal((await f.service.issue(f.admin,request)).grantId,grant.grantId);
  await assert.rejects(f.service.issue(f.admin,{...request,level:'star'}),e=>e.code==='IDEMPOTENCY_CONFLICT');
  const audit=(await f.pg.query("SELECT detail FROM audit_log WHERE action='collab.grant.issued'")).rows[0];assert.equal(JSON.parse(audit.detail).level,'basic');
  assert.equal((await f.service.list(f.admin)).items[0].level,'basic');
  for(const invalid of [undefined,'organization','admin'])await assert.rejects(f.service.preflight(f.admin,{...input,level:invalid}),e=>e.code==='INVALID_REQUEST');
});

test('approval for basic never authorizes star; absence of approval cannot grant either level',async t=>{
  const f=await fixture(t);assert.equal((await f.service.preflight(f.admin,{...input,level:'star'})).ready,false);
  f.facts.allowed=null;for(const level of ['basic','star'])assert.equal((await f.service.preflight(f.admin,{...input,level})).ready,false);
  assert.equal((await f.pg.query('SELECT * FROM collab_grants')).rows.length,0);
});

test('phone lookup normalizes input, verifies trusted binding plus identity, and only returns masked phone',async t=>{
  const f=await fixture(t);
  for(const value of ['199 0000 0001','+86 199-0000-0001','008619900000001']){
    const result=await f.service.lookup(f.admin,{type:'phone',value});
    assert.equal(f.received(),phone);assert.equal(result.verified,true);assert.equal(result.userId,input.userId);
    assert.ok(result.identitySummary.phoneMasked.includes('****'));assert.ok(!JSON.stringify(result).includes('19900000001'));
  }
  assert.equal(normalizeGrantPhone('+1 (202) 555-0100'),'+12025550100');
  for(const value of ['name','138001','+8612300000000','19900000001\nOR true'])assert.throws(()=>normalizeGrantPhone(value));
  assert.equal((await f.pg.query('SELECT * FROM audit_log')).rows.length,0);
});

test('phone source absent, no match, ambiguous, self-reported and expired evidence all fail closed',async t=>{
  const f=await fixture(t),lookup=svc=>(svc??f.service).lookup(f.admin,{type:'phone',value:phone});
  const absent=createSingleGrants(f.access,{...f.options,phoneResolver:undefined});assert.equal((await lookup(absent)).blockers[0].code,'PHONE_VERIFICATION_UNAVAILABLE');
  f.facts.available=false;assert.equal((await lookup()).blockers[0].code,'PHONE_VERIFICATION_UNAVAILABLE');f.facts.available=true;
  f.facts.matches=[];assert.equal((await lookup()).blockers[0].code,'PHONE_NOT_FOUND');
  f.facts.matches=[f.match,f.match];assert.equal((await lookup()).blockers[0].code,'IDENTITY_AMBIGUOUS');
  for(const override of [{verified:false},{phone:'+8619900000002'},{expiresAt:now},{expiresAt:'bad-date'},{userId:'missing'}]){
    f.facts.matches=[{...f.match,...override}];assert.equal((await lookup()).verified,false);
  }
  f.facts.matches=[f.match];f.facts.bound=false;assert.equal((await lookup()).verified,false);
});

test('operation lookup recovers committed result across service recreation and disabled writes; missing is unknown',async t=>{
  const f=await fixture(t),request=await f.request(),grant=await f.service.issue(f.admin,request);
  const restarted=createSingleGrants(f.access,{...f.options,writesEnabled:false});
  const found=await restarted.operation(f.admin,request.idempotencyKey);assert.equal(found.found,true);assert.equal(found.grant.grantId,grant.grantId);
  assert.deepEqual(await restarted.operation(f.admin,randomUUID()),{found:false,outcome:'unknown',grant:null});
  await assert.rejects(restarted.operation({id:'synthetic-admin',role:'admin'},request.idempotencyKey),e=>e.code==='AUTH_REQUIRED');
  assert.equal((await f.pg.query('SELECT * FROM collab_grants')).rows.length,1);
});

test('identity adapter cannot accidentally expose raw provider fields in lookup or preflight DTOs',async t=>{
  const f=await fixture(t),service=createSingleGrants(f.access,{...f.options,identityVerifier:async()=>({verified:true,fingerprint:'SYNTHETIC-proof',summary:{phone,openId:'SYNTHETIC-private-openid',reference:phone}})});
  for(const result of [await service.lookup(f.admin,{type:'userId',value:input.userId}),await service.preflight(f.admin,input)]){
    assert.ok(!JSON.stringify(result).includes(phone));assert.ok(!JSON.stringify(result).includes('SYNTHETIC-private-openid'));
  }
});
