import {accessPolicy} from '../articles.mjs';
import {plans} from '../domain.mjs';
import {fail} from './common.mjs';
// Require a real ISO calendar value, not Date.parse's permissive date rollover.
export function normalizeEntitlementTime(value) {
 const parts=typeof value==='string'&&/^(\d{4})-(\d\d)-(\d\d)T(\d\d):(\d\d):(\d\d)(?:\.(\d{1,3}))?(Z|[+-]\d\d:\d\d)$/.exec(value);
 fail(parts,'Explicit ISO timestamp required');
 const [year,month,day,hour,minute,second]=parts.slice(1,7).map(Number);
 const zone=parts[8],offset=zone==='Z'?[0,0]:zone.slice(1).split(':').map(Number);
 fail(year>=1900&&year<=9998&&month>=1&&month<=12&&day>=1&&day<=new Date(Date.UTC(year,month,0)).getUTCDate()
  &&hour<24&&minute<60&&second<60&&offset[0]<=14&&offset[1]<60&&(offset[0]!==14||offset[1]===0),'Invalid calendar timestamp');
 const timestamp=Date.parse(value);fail(Number.isFinite(timestamp),'Invalid timestamp');
 return new Date(timestamp).toISOString();
}

function source(source,id,planId,startsAt,expiresAt) {
 try {
  fail(typeof id==='string'&&id.length>0&&Object.hasOwn(plans,planId),'Invalid entitlement source');
  startsAt=normalizeEntitlementTime(startsAt);expiresAt=normalizeEntitlementTime(expiresAt);
  // A paid entitlement terminated at its start is an empty, valid interval.
  fail(Date.parse(startsAt)<=Date.parse(expiresAt),'Invalid entitlement interval');
  return {source,id,planId,startsAt,expiresAt};
 } catch {
  fail(false,'Entitlement data requires reconciliation',503,'ENTITLEMENT_DATA_INVALID');
 }
}

// Read-only additive resolver. Never use for reward, ambassador, paid renewal or aftercare eligibility.
// Caller must supply an authenticated consumer and a consistent transaction snapshot.
export async function effectiveEntitlements(c,userId,now=new Date().toISOString()) {
 now=normalizeEntitlementTime(now);const nowMs=Date.parse(now);
 const paid=(await c.query('SELECT * FROM memberships WHERE user_id=$1',[userId])).rows[0];
 // Legacy TEXT columns may contain equivalent ISO offsets. Compare instants only after normalization.
 const grants=(await c.query("SELECT * FROM collab_grants WHERE user_id=$1 AND status='active' ORDER BY id",[userId])).rows;
 const current=s=>Date.parse(s.startsAt)<=nowMs&&nowMs<Date.parse(s.expiresAt);
 const paidSource=paid?source('paid',paid.order_id,paid.plan_id,paid.starts_at,paid.expires_at):null;
 const paidActive=!!paidSource&&current(paidSource);
 const sources=[...(paidActive?[paidSource]:[]),...grants.map(g=>source('grant',g.id,g.level,g.starts_at,g.expires_at)).filter(current)];
 const planIds=[...new Set(sources.map(s=>s.planId))].sort();
 const byPlan=planIds.map(planId=>{
  const matching=sources.filter(s=>s.planId===planId);
  return {planId,active:true,startsAt:matching.map(s=>s.startsAt).sort()[0],expiresAt:matching.map(s=>s.expiresAt).sort().at(-1),sourceIds:matching.map(s=>({source:s.source,id:s.id}))};
 });
 // This order only selects a label. It NEVER grants access to another plan's resources.
 const rank={basic:1,star:2,organization:3};
 const highest=[...byPlan].sort((a,b)=>rank[b.planId]-rank[a.planId])[0];
 const displayMembership=highest?{...highest,sourceIds:highest.sourceIds.map(s=>({...s}))}:null;
 return {active:sources.length>0,planIds,sources,paid:paid??null,paidActive,evaluatedAt:now,byPlan,displayMembership};
}
export function canReadWithEntitlements(article,entitlements){
 if(article?.status!=='published')return false;
 let policy;try{policy=accessPolicy(article.access??JSON.parse(article.access_json));}catch{return false;}
 if(policy.visibility==='public')return true;
 return policy.visibility==='plans'&&entitlements?.active===true&&Array.isArray(entitlements.planIds)&&policy.planIds.some(id=>entitlements.planIds.includes(id));
}
export function calendarYearExpiry(startsAt){
 fail(typeof startsAt==='string'&&/^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d(?:\.\d{3})?(?:Z|\+08:00)$/.test(startsAt)&&Number.isFinite(Date.parse(startsAt)),'Explicit ISO start required');
 const parts=/^(\d{4})-(\d\d)-(\d\d)T(\d\d):(\d\d):(\d\d)(?:\.(\d{3}))?(Z|\+08:00)$/.exec(startsAt);
 const [year0,month0,day0,hour0,minute0,second0]=parts.slice(1,7).map(Number);
 fail(year0>=1900&&year0<=9998&&month0>=1&&month0<=12&&day0>=1&&day0<=new Date(Date.UTC(year0,month0,0)).getUTCDate()&&hour0<24&&minute0<60&&second0<60,'Invalid calendar date');
 const start=new Date(startsAt),local=new Date(start.getTime()+8*3600000),year=local.getUTCFullYear()+1,month=local.getUTCMonth();
 const day=Math.min(local.getUTCDate(),new Date(Date.UTC(year,month+1,0)).getUTCDate());
 return new Date(Date.UTC(year,month,day,local.getUTCHours(),local.getUTCMinutes(),local.getUTCSeconds(),local.getUTCMilliseconds())-8*3600000).toISOString();
}
