import test from 'node:test';import assert from 'node:assert/strict';import {randomUUID} from 'node:crypto';
import {fixture} from './fixture.mjs';import {createCollaborationGrants} from '../../server/collaboration/grants.mjs';import {calendarYearExpiry,effectiveEntitlements,canReadWithEntitlements} from '../../server/collaboration/entitlements.mjs';
const policy={approved:true,startRule:'explicit-start',timeZone:'Asia/Shanghai',yearRule:'calendar-anniversary-clamp',overlap:'parallel-preserve-paid',listHandling:'all-or-nothing',approvalReference:'SYNTHETIC-TEST-ONLY'};
async function consumers(pg){await pg.exec("INSERT INTO users(id,username,password_hash,role,created_at,referral_code,consent_version) VALUES('consumer-a','consumer_a','synthetic','member','2026','REF-A','fixture'),('consumer-b','consumer_b','synthetic','member','2026','REF-B','fixture'); INSERT INTO orders(id,user_id,plan_id,amount_cents,status,profile_json,created_at,idempotency_key,request_hash) VALUES('paid-order','consumer-a','basic',36500,'paid','{}','2026','fixture','fixture'); INSERT INTO memberships VALUES('consumer-a','paid-order','basic','2026-01-01T00:00:00.000Z','2027-01-01T00:00:00.000Z')");}
const request={userIds:['consumer-a','consumer-b'],startsAt:'2026-10-21T00:00:00+08:00',reason:'Synthetic only'};
const snapshot=async pg=>JSON.stringify((await pg.query("SELECT jsonb_build_object('orders',(SELECT jsonb_agg(o) FROM orders o),'memberships',(SELECT jsonb_agg(m) FROM memberships m),'receipts',(SELECT jsonb_agg(p) FROM payment_receipts p),'referrals',(SELECT jsonb_agg(jsonb_build_object('id',u.id,'referrer',u.referrer_id)) FROM users u)) AS data")).rows);
test('K3 missing decisions block; atomic grants are idempotent and do not modify paid state',async t=>{
 const {pg,access,admin,clock,faults}=await fixture(t);await consumers(pg);const unchanged=await snapshot(pg),blocked=createCollaborationGrants(access,{clock});
 assert.deepEqual((await blocked.preflight(admin,request)).blockers,['BUSINESS_DECISIONS_UNCONFIRMED']);await assert.rejects(blocked.issue(admin,request,randomUUID(),'x'),e=>e.code==='PREFLIGHT_BLOCKED');
 const grants=createCollaborationGrants(access,{policy,clock}),pre=await grants.preflight(admin,request);assert.equal(pre.ready,true);
 faults.audit=true;await assert.rejects(grants.issue(admin,request,randomUUID(),pre.fingerprint),/audit failure/);faults.audit=false;
 assert.equal((await pg.query('SELECT * FROM collab_grants')).rows.length,0);assert.equal((await pg.query('SELECT * FROM collab_grant_batches')).rows.length,0);
 const key=randomUUID(),result=await grants.issue(admin,request,key,pre.fingerprint);assert.equal(result.grants.length,2);
 assert.equal((await grants.issue(admin,request,key,pre.fingerprint)).duplicate,true);
 await assert.rejects(grants.issue(admin,{...request,userIds:['consumer-b']},key,pre.fingerprint),e=>e.code==='IDEMPOTENCY_CONFLICT');
 await assert.rejects(grants.issue(admin,request,randomUUID(),pre.fingerprint),e=>e.code==='PREFLIGHT_CHANGED');
 const e=await access.run(c=>effectiveEntitlements(c,'consumer-a',clock()));assert.deepEqual(e.planIds,['basic','star']);
 for(const planId of ['basic','star'])assert.equal(canReadWithEntitlements({status:'published',access:{visibility:'plans',planIds:[planId]}},e),true);
 assert.equal(canReadWithEntitlements({status:'draft',access:{visibility:'public',planIds:[]}},e),false);
 const grant=result.grants.find(g=>g.user_id==='consumer-a');await grants.revoke(admin,grant.id,'Synthetic revoke');assert.equal((await grants.revoke(admin,grant.id,'Retry')).duplicate,true);
 assert.deepEqual((await access.run(c=>effectiveEntitlements(c,'consumer-a',clock()))).planIds,['basic']);
 assert.equal(await snapshot(pg),unchanged);
 assert.equal((await access.run(c=>effectiveEntitlements(c,'consumer-b','2027-10-20T16:00:00.000Z'))).active,false);
});
test('K3 all-or-nothing missing users, active overlap and operational-account rejection',async t=>{
 const {pg,access,admin,account,clock}=await fixture(t);await consumers(pg);const a=await account('org-a','orga_user'),grants=createCollaborationGrants(access,{policy:{...policy,overlap:'block-active'},clock});
 assert.equal((await grants.preflight(admin,request)).ready,false);
 assert.equal((await grants.preflight(admin,{...request,userIds:['consumer-b','missing']})).ready,false);
 assert.equal((await grants.preflight(admin,{...request,userIds:[a.user.id]})).blockers[0].code,'OPERATIONAL_ACCOUNT');
 await assert.rejects(grants.preflight(a.actor,request),e=>e.status===403);
 assert.equal((await pg.query('SELECT * FROM collab_grants')).rows.length,0);
});
test('K3 calendar year uses Shanghai anniversary and leap-day clamp, not 365 days',()=>{
 assert.equal(calendarYearExpiry('2024-02-29T12:30:00+08:00'),'2025-02-28T04:30:00.000Z');
 assert.equal(calendarYearExpiry('2023-03-01T00:00:00+08:00'),'2024-02-29T16:00:00.000Z');
 assert.equal(calendarYearExpiry('2024-12-31T20:00:00Z'),'2025-12-31T20:00:00.000Z');
});
test('K3 malformed access policies fail closed and impossible dates are rejected',()=>{
 const entitlement={active:true,planIds:['basic']};
 for(const policy of [{visibility:'public',planIds:['basic']},{visibility:'plans',planIds:['unknown']},{visibility:'plans',planIds:[]},{visibility:'public',planIds:[],previewPages:10}])assert.equal(canReadWithEntitlements({status:'published',access:policy},entitlement),false);
 for(const start of ['2026-02-30T00:00:00+08:00','2026-04-31T00:00:00Z','2026-01-01T24:00:00Z','2026-13-01T00:00:00Z','2026-00-01T00:00:00Z'])assert.throws(()=>calendarYearExpiry(start));
});
