import test from 'node:test';
import assert from 'node:assert/strict';
import {PGlite} from '@electric-sql/pglite';
import {effectiveEntitlements,canReadWithEntitlements,calendarYearExpiry,normalizeEntitlementTime} from '../../server/collaboration/entitlements.mjs';

async function fixture(t) {
 const db=new PGlite();await db.waitReady;t.after(()=>db.close());
 // The resolver needs no association, account or collaboration configuration tables.
 await db.exec('CREATE TABLE memberships(user_id TEXT,order_id TEXT,plan_id TEXT,starts_at TEXT,expires_at TEXT); CREATE TABLE collab_grants(id TEXT,user_id TEXT,level TEXT,status TEXT,starts_at TEXT,expires_at TEXT);');
 const paid=(plan,start,end)=>db.query('INSERT INTO memberships VALUES($1,$2,$3,$4,$5)',['SYNTHETIC-user','SYNTHETIC-order',plan,start,end]);
 const grant=(id,start,end,status='active')=>db.query('INSERT INTO collab_grants VALUES($1,$2,$3,$4,$5,$6)',[id,'SYNTHETIC-user','star',status,start,end]);
 const effective=now=>effectiveEntitlements(db,'SYNTHETIC-user',now);
 return {db,paid,grant,effective};
}

test('grant start is inclusive, expiry exclusive, and equivalent offsets denote the same instant',async t=>{
 const {grant,effective}=await fixture(t);
 await grant('SYNTHETIC-grant','2026-10-28T00:30:00+08:00','2027-10-28T00:30:00+08:00');
 assert.equal((await effective('2026-10-27T16:29:59.999Z')).active,false);
 const start=await effective('2026-10-27T16:30:00.000Z');assert.equal(start.active,true);
 assert.equal(start.sources[0].startsAt,'2026-10-27T16:30:00.000Z');
 assert.deepEqual(await effective('2026-10-28T00:30:00+08:00'),start);
 assert.equal((await effective('2027-10-27T16:29:59.999Z')).active,true);
 assert.equal((await effective('2027-10-27T16:30:00.000Z')).active,false);
});

test('star display expires with star, while longer basic source remains distinct and survives revocation',async t=>{
 const {db,paid,grant,effective}=await fixture(t);
 await paid('basic','2026-01-01T00:00:00Z','2029-01-01T00:00:00Z');
 await grant('SYNTHETIC-star','2026-10-28T00:00:00Z','2027-10-28T00:00:00Z');
 await grant('SYNTHETIC-future','2028-01-01T00:00:00Z','2030-01-01T00:00:00Z');
 const before=await effective('2026-10-28T00:00:00Z');
 assert.equal(before.displayMembership.planId,'star');assert.equal(before.displayMembership.expiresAt,'2027-10-28T00:00:00.000Z');
 assert.equal(before.byPlan.find(p=>p.planId==='basic').expiresAt,'2029-01-01T00:00:00.000Z');
 assert.equal(before.sources.length,2);assert.equal(Object.hasOwn(before.displayMembership,'orderId'),false);
 await db.query("UPDATE collab_grants SET status='revoked' WHERE id=$1",['SYNTHETIC-star']);
 const after=await effective('2026-10-28T00:00:00Z');
 assert.deepEqual(after.planIds,['basic']);assert.equal(after.paidActive,true);assert.deepEqual(after.paid,before.paid);
 assert.equal((await effective('2029-01-01T00:00:00Z')).displayMembership.planId,'star');
});

test('multiple currently active sources use only their own plan intervals and retain source IDs',async t=>{
 const {paid,grant,effective}=await fixture(t);
 await paid('star','2025-01-01T00:00:00Z','2027-01-01T00:00:00Z');
 await grant('SYNTHETIC-star','2026-01-01T00:00:00Z','2028-01-01T00:00:00Z');
 const entitlements=await effective('2026-10-28T00:00:00Z');
 assert.deepEqual(entitlements.displayMembership,{planId:'star',active:true,startsAt:'2025-01-01T00:00:00.000Z',expiresAt:'2028-01-01T00:00:00.000Z',sourceIds:[{source:'paid',id:'SYNTHETIC-order'},{source:'grant',id:'SYNTHETIC-star'}]});
 assert.equal((await effective('2027-01-01T00:00:00Z')).paidActive,false);
 assert.equal((await effective('2028-01-01T00:00:00Z')).displayMembership,null);
});

test('paid entitlement terminated at its start does not suppress another valid grant',async t=>{
 const {paid,grant,effective}=await fixture(t);
 await paid('basic','2026-10-28T00:00:00Z','2026-10-28T00:00:00Z');
 await grant('SYNTHETIC-star','2026-10-28T00:00:00Z','2027-10-28T00:00:00Z');
 const result=await effective('2026-10-28T00:00:00Z');
 assert.equal(result.paidActive,false);assert.deepEqual(result.planIds,['star']);
});

test('report access matches exact plans and preserves public, unpublished and preview boundaries',()=>{
 const entitled={active:true,planIds:['star']};
 const article=(status,visibility,planIds,previewPages)=>({status,access:{visibility,planIds,...(previewPages?{previewPages}:{})}});
 assert.equal(canReadWithEntitlements(article('published','plans',['star']),entitled),true);
 assert.equal(canReadWithEntitlements(article('published','plans',['basic']),entitled),false);
 assert.equal(canReadWithEntitlements(article('published','plans',['organization']),entitled),false);
 assert.equal(canReadWithEntitlements(article('published','public',[]),null),true);
 assert.equal(canReadWithEntitlements(article('draft','public',[]),entitled),false);
 assert.equal(canReadWithEntitlements(article('published','plans',['star'],10),{active:false,planIds:[]}),false);
 for(const malformed of [{active:true},{active:true,planIds:'star'},null])assert.equal(canReadWithEntitlements(article('published','plans',['star']),malformed),false);
});

test('bad persisted intervals fail closed without leaking raw data; invalid now never grants access',async t=>{
 const {grant,effective}=await fixture(t);
 await grant('SYNTHETIC-bad','2026-02-30T00:00:00Z','2027-02-28T00:00:00Z');
 await assert.rejects(effective('2026-10-28T00:00:00Z'),e=>e.code==='ENTITLEMENT_DATA_INVALID'&&e.status===503&&!e.message.includes('SYNTHETIC'));
 await assert.rejects(effective('2026-02-30T00:00:00Z'),e=>e.status===400);
});

test('Shanghai calendar anniversary clamps leap days including UTC date crossings',()=>{
 assert.equal(calendarYearExpiry('2024-02-28T16:00:00.001Z'),'2025-02-27T16:00:00.001Z');
 assert.equal(calendarYearExpiry('2023-03-01T00:00:00+08:00'),'2024-02-29T16:00:00.000Z');
 assert.equal(normalizeEntitlementTime('2026-10-28T00:00:00.1+08:00'),'2026-10-27T16:00:00.100Z');
 for(const value of ['2026-02-30T00:00:00Z','2026-01-01T24:00:00Z','2026-01-01T00:00:00','2026-01-01T00:00:00+14:01','2026-01-01T00:00:00+08:61'])assert.throws(()=>normalizeEntitlementTime(value));
});
