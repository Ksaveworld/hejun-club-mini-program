import {accessPolicy} from '../articles.mjs';
import {fail} from './common.mjs';
// Read-only additive resolver. Never use for reward, ambassador, paid renewal or aftercare eligibility.
export async function effectiveEntitlements(c,userId,now=new Date().toISOString()) {
 const paid=(await c.query('SELECT * FROM memberships WHERE user_id=$1',[userId])).rows[0];
 const grants=(await c.query("SELECT * FROM collab_grants WHERE user_id=$1 AND status='active' AND starts_at<=$2 AND expires_at>$2 ORDER BY expires_at DESC,id",[userId,now])).rows;
 const paidActive=!!paid&&paid.starts_at<=now&&paid.expires_at>now;
 const sources=[...(paidActive?[{source:'paid',id:paid.order_id,planId:paid.plan_id,startsAt:paid.starts_at,expiresAt:paid.expires_at}]:[]),...grants.map(g=>({source:'grant',id:g.id,planId:g.level,startsAt:g.starts_at,expiresAt:g.expires_at}))];
 return {active:sources.length>0,planIds:[...new Set(sources.map(s=>s.planId))].sort(),sources,paid:paid??null,paidActive};
}
export function canReadWithEntitlements(article,entitlements){
 if(article?.status!=='published')return false;
 let policy;try{policy=accessPolicy(article.access??JSON.parse(article.access_json));}catch{return false;}
 if(policy.visibility==='public')return true;
 return policy.visibility==='plans'&&entitlements?.active===true&&policy.planIds.some(id=>entitlements.planIds.includes(id));
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
