import test from 'node:test';
import assert from 'node:assert/strict';
import {randomUUID} from 'node:crypto';
import {fixture} from './fixture.mjs';
import {createSingleGrants} from '../../server/collaboration/single-grants.mjs';
import {createGrantIdentityVerifier} from '../../server/collaboration/grant-identity.mjs';

const initial='2026-10-28T10:00:00.000Z';
const request={userId:'SYNTHETIC-person',level:'star',reason:'SYNTHETIC review regression',approvalReference:'SYNTHETIC-approved'};
async function setup(t,{approvalExpiry,identityExpiry}={}) {
 const f=await fixture(t);
 await f.pg.exec("INSERT INTO users(id,username,password_hash,role,created_at,referral_code,consent_version) VALUES('SYNTHETIC-person','synthetic_person','synthetic','member','2026','REF-R','fixture'); INSERT INTO wechat_identities VALUES('synthetic-app','synthetic-openid','SYNTHETIC-person','2026')");
 const time={now:initial,advanceTo:null};
 const service=createSingleGrants(f.access,{policy:{approved:true,startRule:'confirmation-time',timeZone:'Asia/Shanghai',yearRule:'calendar-anniversary-clamp',overlap:'block-active',version:'SYNTHETIC-v1'},clock:()=>time.now,confirmationSecret:'SYNTHETIC-ONLY-SECRET-32-BYTES-LONG',writesEnabled:true,writeCoordinationReady:true,
  identityVerifier:createGrantIdentityVerifier({resolveEvidence:async()=>({verified:true,userId:request.userId,appId:'synthetic-app',openId:'synthetic-openid',reference:'SYNTHETIC-person-proof',revision:'1',...(identityExpiry?{expiresAt:identityExpiry}:{})})}),
  approvalResolver:async(_c,r)=>{if(time.advanceTo)time.now=time.advanceTo;return {approved:true,userId:r.userId,level:'star',reference:r.approvalReference,revision:'1',...(approvalExpiry?{expiresAt:approvalExpiry}:{})};}});
 const prepare=async()=>{const p=await service.preflight(f.admin,request);assert.equal(p.ready,true);assert.equal('validity' in p,false);return {...request,idempotencyKey:randomUUID(),confirmationToken:p.confirmationToken};};
 const untouched=async()=>{for(const table of ['collab_grants','collab_grant_batches'])assert.equal((await f.pg.query(`SELECT * FROM ${table}`)).rows.length,0);};
 return {...f,service,time,prepare,untouched};
}

for(const kind of ['approval','identity'])test(`${kind} deadline that passes during evidence reads prevents issue and rolls back reservation`,async t=>{
 const f=await setup(t,{[kind+'Expiry']:'2026-10-28T10:00:01.000Z'}),body=await f.prepare();
 f.time.advanceTo='2026-10-28T10:00:02.000Z';
 await assert.rejects(f.service.issue(f.admin,body),e=>e.code==='PREFLIGHT_CHANGED');await f.untouched();
});

test('successful issue starts at the final decision clock after evidence reads',async t=>{
 const f=await setup(t),body=await f.prepare();f.time.advanceTo='2026-10-28T10:00:02.000Z';
 const result=await f.service.issue(f.admin,body);
 assert.equal(result.startsAt,f.time.advanceTo);assert.equal(result.expiresAt,'2027-10-28T10:00:02.000Z');
 f.time.advanceTo='2026-10-28T10:00:04.000Z';const replay=await f.service.issue(f.admin,body);
 assert.equal(replay.duplicate,true);assert.equal(replay.startsAt,result.startsAt);assert.equal(replay.grantId,result.grantId);
});

test('the final anniversary interval is rechecked for a newly overlapping future paid source',async t=>{
 const f=await setup(t);
 await f.pg.exec("INSERT INTO orders(id,user_id,plan_id,amount_cents,status,profile_json,created_at,idempotency_key,request_hash) VALUES('SYNTHETIC-paid','SYNTHETIC-person','basic',36500,'paid','{}','2026','SYNTHETIC-key','SYNTHETIC-hash'); INSERT INTO memberships VALUES('SYNTHETIC-person','SYNTHETIC-paid','basic','2027-10-28T10:00:01.000Z','2028-10-28T10:00:01.000Z')");
 const body=await f.prepare();f.time.advanceTo='2026-10-28T10:00:02.000Z';
 await assert.rejects(f.service.issue(f.admin,body),e=>e.code==='PREFLIGHT_BLOCKED');await f.untouched();
});

test('legacy offset timestamps use the same instant for status filtering, output and pagination',async t=>{
 const f=await setup(t),first=await f.service.issue(f.admin,await f.prepare());
 await f.pg.query('UPDATE collab_grants SET starts_at=$1,expires_at=$2,created_at=$1 WHERE id=$3',['2026-10-28T18:00:00+08:00','2027-10-28T18:00:00+08:00',first.grantId]);
 await f.pg.query("INSERT INTO collab_grants(id,user_id,level,starts_at,expires_at,reason,approval_reference,actor_id,status,idempotency_key,request_hash,created_at) SELECT $1,user_id,level,$2,$3,reason,approval_reference,actor_id,status,$4,request_hash,$2 FROM collab_grants WHERE id=$5",['SYNTHETIC-old','2026-10-28T09:00:00Z','2027-10-28T09:00:00Z','SYNTHETIC-old-key',first.grantId]);
 const one=await f.service.list(f.admin,{status:'active',limit:1});assert.equal(one.items.length,1);assert.equal(one.items[0].grantId,first.grantId);
 assert.equal(one.items[0].startsAt,initial);assert.equal(one.items[0].status,'active');
 const two=await f.service.list(f.admin,{status:'active',limit:1,cursor:one.nextCursor});assert.equal(two.items[0].grantId,'SYNTHETIC-old');assert.equal(two.nextCursor,null);
 assert.deepEqual((await f.service.list(f.admin,{status:'scheduled'})).items,[]);
 const malformed=Buffer.from(JSON.stringify({userId:null,status:'active',createdAt:'2026-02-30T00:00:00Z',id:'SYNTHETIC',asOf:initial})).toString('base64url');
 await assert.rejects(f.service.list(f.admin,{status:'active',cursor:malformed}),e=>e.status===400);
});

test('impossible evidence expiry dates cannot become valid through Date.parse rollover',async t=>{
 const f=await setup(t,{approvalExpiry:'2027-02-30T10:00:00Z'});
 assert.equal((await f.service.preflight(f.admin,request)).ready,false);
});
