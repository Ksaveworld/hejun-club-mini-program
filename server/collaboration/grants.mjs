import {randomUUID} from 'node:crypto';
import {digest,validateKey} from '../domain.mjs';
import {fail,one,audit,string} from './common.mjs';
import {calendarYearExpiry,effectiveEntitlements} from './entitlements.mjs';
import {requireConsumerIdentity} from './member-boundary.mjs';
// Absent business decisions always block. Configuration is server-owned, never request-supplied.
export function createCollaborationGrants(access,{policy,clock=()=>new Date().toISOString()}={}) {
 const run=access.run;
 const policyReady=()=>policy?.approved===true&&policy.startRule==='explicit-start'&&policy.timeZone==='Asia/Shanghai'&&policy.yearRule==='calendar-anniversary-clamp'&&['block-active','parallel-preserve-paid'].includes(policy.overlap)&&policy.listHandling==='all-or-nothing'&&typeof policy.approvalReference==='string'&&policy.approvalReference.trim();
 function normalize(input){fail(Array.isArray(input.userIds)&&input.userIds.length>0&&input.userIds.length<=100,'Select 1–100 users');fail(input.userIds.every(id=>typeof id==='string'&&id.length>0),'Invalid user IDs');fail(new Set(input.userIds).size===input.userIds.length,'Duplicate user ID');const expiresAt=calendarYearExpiry(input.startsAt);const startsAt=new Date(input.startsAt).toISOString();return {userIds:[...input.userIds].sort(),startsAt,expiresAt,level:'star',reason:string(input.reason,'reason',500)};}
 async function inspect(c,actor,input,{lock=false}={}) {
  await access.platform(c,actor);
  if(!policyReady())return {ready:false,blockers:['BUSINESS_DECISIONS_UNCONFIRMED'],writes:0};
  const request=normalize(input),blockers=[],snapshots=[];
  for(const id of request.userIds){const user=await one(c,`SELECT id,role FROM users WHERE id=$1${lock?' FOR UPDATE':''}`,[id]);
   if(!user||user.role!=='member'){blockers.push({userId:id,code:'USER_UNAVAILABLE'});continue;}
   if(await one(c,'SELECT user_id FROM collab_accounts WHERE user_id=$1',[id])){blockers.push({userId:id,code:'OPERATIONAL_ACCOUNT'});continue;}
   const paid=await one(c,'SELECT * FROM memberships WHERE user_id=$1',[id]);
   const grants=(await c.query("SELECT * FROM collab_grants WHERE user_id=$1 AND status='active' ORDER BY id",[id])).rows;
   const overlap=[...(paid?[{starts_at:paid.starts_at,expires_at:paid.expires_at}]:[]),...grants].some(x=>x.starts_at<request.expiresAt&&x.expires_at>request.startsAt);
   if(overlap&&policy.overlap==='block-active')blockers.push({userId:id,code:'EXISTING_ENTITLEMENT'});
   snapshots.push({userId:id,paid:paid??null,grants});
  }
  const fingerprint=digest(JSON.stringify({request,policy,snapshots}));
  return {ready:blockers.length===0,blockers,request,fingerprint,policyReference:policy.approvalReference,writes:0};
 }
 return {
 preflight:(actor,input)=>run(c=>inspect(c,actor,input)),
 issue:(actor,input,key,fingerprint)=>run(async c=>{
  await access.platform(c,actor);validateKey(key);fail(policyReady(),'Business decisions unconfirmed',409,'PREFLIGHT_BLOCKED');const request=normalize(input),requestHash=digest(JSON.stringify({request,policy}));
  await c.query('INSERT INTO collab_grant_batches VALUES($1,$2,$3) ON CONFLICT DO NOTHING',[key,requestHash,clock()]);
  const batch=await one(c,'SELECT * FROM collab_grant_batches WHERE idempotency_key=$1 FOR UPDATE',[key]);fail(batch.request_hash===requestHash,'Idempotency conflict',409,'IDEMPOTENCY_CONFLICT');
  // Lock all targets in deterministic order; re-check idempotency after locks.
  for(const id of request.userIds)await one(c,'SELECT id FROM users WHERE id=$1 FOR UPDATE',[id]);
  const existing=(await c.query('SELECT * FROM collab_grants WHERE idempotency_key = ANY($1::text[])',[request.userIds.map(id=>key+':'+id)])).rows;
  if(existing.length){fail(existing.length===request.userIds.length&&existing.every(g=>g.request_hash===requestHash),'Idempotency conflict',409,'IDEMPOTENCY_CONFLICT');return {duplicate:true,grants:existing};}
  // Guard reuse of the batch key with a different recipient list, including disjoint lists.
  const prior=await one(c,'SELECT detail FROM audit_log WHERE action=$1 AND target_id=$2',['collab.grant.batch',key]);fail(!prior,'Idempotency conflict',409,'IDEMPOTENCY_CONFLICT');
  const check=await inspect(c,actor,input,{lock:true});fail(check.ready,'Grant preflight blocked',409,'PREFLIGHT_BLOCKED');fail(typeof fingerprint==='string'&&fingerprint===check.fingerprint,'Preflight changed; review again',409,'PREFLIGHT_CHANGED');
  const grants=[];for(const userId of request.userIds){await requireConsumerIdentity(c,userId);const id=randomUUID();const row=await one(c,"INSERT INTO collab_grants(id,user_id,level,starts_at,expires_at,reason,approval_reference,actor_id,status,idempotency_key,request_hash,created_at) VALUES($1,$2,'star',$3,$4,$5,$6,$7,'active',$8,$9,$10) RETURNING *",[id,userId,request.startsAt,request.expiresAt,request.reason,policy.approvalReference,actor.id,key+':'+userId,requestHash,clock()]);grants.push(row);await audit(c,actor.id,'collab.grant.issued',id,{userId,startsAt:request.startsAt,expiresAt:request.expiresAt,reason:request.reason});}
  await audit(c,actor.id,'collab.grant.batch',key,{requestHash,userIds:request.userIds});return {duplicate:false,grants};
 }),
 revoke:(actor,id,reason)=>run(async c=>{await access.platform(c,actor);reason=string(reason,'revocation reason',500);const grant=await one(c,'SELECT * FROM collab_grants WHERE id=$1 FOR UPDATE',[id]);fail(grant,'Grant unavailable',404);if(grant.status==='revoked')return {...grant,duplicate:true};const updated=await one(c,"UPDATE collab_grants SET status='revoked',revoked_at=$1,revoked_by=$2,revoke_reason=$3 WHERE id=$4 RETURNING *",[clock(),actor.id,reason,id]);await audit(c,actor.id,'collab.grant.revoked',id,{reason,userId:grant.user_id});return {...updated,duplicate:false};}),
 list:actor=>run(async c=>{await access.platform(c,actor);return (await c.query('SELECT * FROM collab_grants ORDER BY created_at,id')).rows;}),
 effectiveInTransaction:effectiveEntitlements
 };
}
