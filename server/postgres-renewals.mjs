import {readFileSync} from 'node:fs';
import {postgresTransaction,safeInteger} from './postgres.mjs';
import {plans,yearAfter} from './domain.mjs';

export const renewalTable='_club_order_transactions';
export const renewalMigrationMarker={key:'_club_same_plan_renewal_migration',value:'005-same-plan-renewal-v1'};
const migration=readFileSync(new URL('./migrations/postgres/005-same-plan-renewal.sql',import.meta.url),'utf8');
const one=async(c,sql,args=[])=>(await c.query(sql,args)).rows[0];
const fail=(code,message,status=409)=>{throw Object.assign(new Error(message),{code,status});};
const need=(condition,code,message,status)=>{if(!condition)fail(code,message,status);};
const validSchema=schema=>/^club_migration_[a-z0-9_]{1,40}$/.test(schema||'');
const instant=value=>typeof value==='string'&&Number.isFinite(Date.parse(value));
const membershipSnapshot=row=>row?{userId:row.user_id,orderId:row.order_id,planId:row.plan_id,startsAt:row.starts_at,expiresAt:row.expires_at}:null;
// JSONB does not retain key order. Compare only explicit membership fields.
const membershipMatches=(row,snapshot)=>!!row&&!!snapshot&&Object.entries(membershipSnapshot(row)).every(([key,value])=>snapshot[key]===value);
const label=policy=>policy.termKind==='calendar_year'?'一年（按周年）':'365天';
const unavailable=reason=>({enabled:false,canRenew:false,reason});
function validatePolicy(policy){
  need(policy?.status==='approved'&&typeof policy.version==='string'&&policy.version.length>0&&typeof policy.approvalRef==='string'&&policy.approvalRef.length>0
    &&instant(policy.approvedAt)&&['calendar_year','fixed_days'].includes(policy.termKind)
    &&(policy.termKind!=='fixed_days'||policy.durationDays===365)&&policy.startPolicy==='later_expiry_or_verified_paid_at',
    'RENEWAL_POLICY_UNCONFIGURED','同档续费期限和起点尚未明确批准',503);
  return policy;
}
export async function renewalMigrationTables(c,schema){
  need(validSchema(schema),'RENEWAL_SCHEMA_INVALID','续费数据区不正确',503);
  const marker=await one(c,'SELECT value FROM settings WHERE key=$1',[renewalMigrationMarker.key]);if(!marker)return [];
  need(marker.value===renewalMigrationMarker.value,'RENEWAL_STORAGE_INVALID','续费迁移标记不一致',503);
  const columns=(await c.query('SELECT column_name,data_type FROM information_schema.columns WHERE table_schema=$1 AND table_name=$2',[schema,renewalTable])).rows;
  need(columns.map(row=>row.column_name+':'+row.data_type).sort().join(',')===['order_id:text','kind:text','snapshot_json:jsonb','applied_at:text','expires_at:text'].sort().join(','),'RENEWAL_STORAGE_INVALID','续费表结构不一致',503);
  return [renewalTable];
}
export async function initializePostgresRenewals(pool,{schema}={}){
  need(validSchema(schema),'RENEWAL_SCHEMA_INVALID','需要显式指定续费迁移数据区',400);
  return postgresTransaction(pool,async c=>{
    await c.query(`SET LOCAL search_path TO "${schema}"`);await c.query('LOCK TABLE settings IN SHARE ROW EXCLUSIVE MODE');
    if((await renewalMigrationTables(c,schema)).length)return {initialized:false};
    need(!await one(c,'SELECT 1 FROM pg_tables WHERE schemaname=$1 AND tablename=$2',[schema,renewalTable]),'RENEWAL_STORAGE_INVALID','发现未标记续费表，请先核对迁移',503);
    await c.query(migration);return {initialized:true};
  });
}
// Explicit trusted operational setup; never expose this method as a member API.
// It records approved business policy without recalculating any old membership.
export async function configurePostgresRenewalPolicy(pool,{schema,policy,policySettingKey='membership_renewal_policy_v1'}={}){
  need(validSchema(schema)&&typeof policySettingKey==='string'&&policySettingKey.length>0,'RENEWAL_CONFIG_INVALID','续费配置格式不正确',400);
  validatePolicy(policy);need(Date.parse(policy.approvedAt)<=Date.now(),'RENEWAL_POLICY_UNCONFIGURED','同档续费批准时间尚未生效',503);
  return postgresTransaction(pool,async c=>{
    await c.query(`SET LOCAL search_path TO "${schema}"`);await c.query('LOCK TABLE settings IN SHARE ROW EXCLUSIVE MODE');
    need((await renewalMigrationTables(c,schema)).length===1,'RENEWAL_STORAGE_UNCONFIGURED','同档续费迁移尚未完成',503);
    const old=await one(c,'SELECT value FROM settings WHERE key=$1',[policySettingKey]);let previous;
    try{previous=JSON.parse(old?.value??'null');}catch{fail('RENEWAL_POLICY_UNCONFIGURED','现有续费配置需核对',503);}
    const stable=value=>JSON.stringify(Object.fromEntries(Object.entries(value).sort(([a],[b])=>a.localeCompare(b))));
    if(previous?.version===policy.version){need(stable(previous)===stable(policy),'RENEWAL_POLICY_VERSION_CONFLICT','同一版本不能变更已批准续费规则');return {configured:true,reused:true,version:policy.version};}
    await c.query('INSERT INTO settings(key,value) VALUES($1,$2) ON CONFLICT(key) DO UPDATE SET value=excluded.value',[policySettingKey,JSON.stringify(policy)]);
    return {configured:true,reused:false,version:policy.version};
  });
}
export function createPostgresRenewals(pool,{schema,enabled=false,policySettingKey='membership_renewal_policy_v1'}={}){
  need(validSchema(schema)&&typeof enabled==='boolean'&&typeof policySettingKey==='string','RENEWAL_CONFIG_INVALID','续费配置格式不正确',400);
  async function policy(c){
    if(!enabled)return null;
    const saved=await one(c,'SELECT value FROM settings WHERE key=$1 FOR SHARE',[policySettingKey]);let value;
    try{value=JSON.parse(saved?.value??'null');}catch{fail('RENEWAL_POLICY_UNCONFIGURED','同档续费期限配置需核对',503);}
    if(value?.status!=='approved')return null;validatePolicy(value);
    need(Date.parse(value.approvedAt)<=Date.now(),'RENEWAL_POLICY_UNCONFIGURED','同档续费批准时间尚未生效',503);
    need((await renewalMigrationTables(c,schema)).length===1,'RENEWAL_STORAGE_UNCONFIGURED','同档续费迁移尚未完成',503);
    return value;
  }
  async function transaction(c,row){
    const marker=await one(c,'SELECT value FROM settings WHERE key=$1',[renewalMigrationMarker.key]);if(!marker)return null;
    need(marker.value===renewalMigrationMarker.value,'RENEWAL_STORAGE_INVALID','续费迁移标记不一致',503);
    const stored=await one(c,`SELECT * FROM ${renewalTable} WHERE order_id=$1`,[row.id]);
    if(!stored)return null;
    const snapshot=typeof stored.snapshot_json==='string'?JSON.parse(stored.snapshot_json):stored.snapshot_json;
    need(snapshot.kind===stored.kind&&snapshot.userId===row.user_id&&snapshot.planId===row.plan_id&&snapshot.amountCents===safeInteger(row.amount_cents)&&snapshot.currency===row.currency,'RENEWAL_ORDER_CHANGED','订单交易快照与当前资料不一致');
    return {...stored,snapshot};
  }
  async function statusInTransaction(c,userId){
    const approved=await policy(c);if(!approved)return unavailable('同档续费配置尚未启用或批准配置未就绪，暂未开放');
    const membership=await one(c,'SELECT * FROM memberships WHERE user_id=$1',[userId]);
    return {enabled:true,canRenew:!!membership&&['basic','star'].includes(membership.plan_id),planId:membership?.plan_id??null,
      termLabel:label(approved),startPolicy:approved.startPolicy,reason:membership?'':'当前没有可续费会籍'};
  }
  async function saveOrderInTransaction(c,row,{kind='first_purchase',membership=null}={}){
    need(['first_purchase','renewal'].includes(kind),'RENEWAL_KIND_INVALID','交易类型无效',400);
    let approved=null;
    if(kind==='renewal'){
      approved=await policy(c);need(approved,'RENEWAL_DISABLED','同档续费期限和起点尚未明确批准，暂未开放',503);
      need(membership&&membership.user_id===row.user_id&&membership.plan_id===row.plan_id&&['basic','star'].includes(row.plan_id),'RENEWAL_PLAN_MISMATCH','续费只能选择当前同一档位');
      need(safeInteger(row.amount_cents)===plans[row.plan_id].amountCents,'RENEWAL_AMOUNT_INVALID','续费金额与现有年费不一致');
    }else if(!(await renewalMigrationTables(c,schema)).length)return {kind};
    const snapshot={userId:row.user_id,planId:row.plan_id,amountCents:safeInteger(row.amount_cents),currency:row.currency,kind,
      priorMembership:membershipSnapshot(membership),policy:approved};
    await c.query(`INSERT INTO ${renewalTable}(order_id,kind,snapshot_json) VALUES($1,$2,$3)`,[row.id,kind,JSON.stringify(snapshot)]);
    return {kind};
  }
  async function assertPayableInTransaction(c,row){
    const saved=await transaction(c,row),member=await one(c,'SELECT * FROM memberships WHERE user_id=$1',[row.user_id]);
    if(saved?.kind==='renewal'){
      need(await policy(c),'RENEWAL_DISABLED','同档续费暂未开放，请保留订单');
      need(membershipMatches(member,saved.snapshot.priorMembership),'RENEWAL_MEMBERSHIP_CHANGED','会籍已变化，请核对订单后重新办理');
      return {kind:'renewal'};
    }
    need(!member,'RENEWAL_MEMBERSHIP_CHANGED','已有会籍，请核对现有会员订单');return {kind:'first_purchase'};
  }
  async function fulfillmentInTransaction(c,row,paidAt){
    const saved=await transaction(c,row);if(saved?.kind!=='renewal')return null;
    validatePolicy(saved.snapshot.policy);
    const current=await one(c,'SELECT * FROM memberships WHERE user_id=$1 FOR UPDATE',[row.user_id]);
    if(row.status!=='pending'||saved.applied_at||!membershipMatches(current,saved.snapshot.priorMembership))return {kind:'renewal',outcome:'needs_reconciliation'};
    need(instant(paidAt)&&instant(current.expires_at)&&instant(current.starts_at),'RENEWAL_TIME_INVALID','续费付款或会籍时间无效');
    const base=new Date(Math.max(Date.parse(current.expires_at),Date.parse(paidAt))).toISOString();
    const expiresAt=saved.snapshot.policy.termKind==='calendar_year'?yearAfter(base):new Date(Date.parse(base)+365*86400000).toISOString();
    return {kind:'renewal',outcome:'activated',expiresAt,startsAt:Date.parse(current.expires_at)>Date.parse(paidAt)?current.starts_at:paidAt};
  }
  async function commitFulfillmentInTransaction(c,row,paidAt,expiresAt){
    const saved=await transaction(c,row);if(!saved)return;
    await c.query(`UPDATE ${renewalTable} SET applied_at=$1,expires_at=$2 WHERE order_id=$3 AND applied_at IS NULL`,[paidAt,expiresAt,row.id]);
  }
  async function orderInfoInTransaction(c,row){
    const saved=await transaction(c,row);return {transactionKind:saved?.kind??'first_purchase',...(saved?.kind==='renewal'?{renewal:{previousExpiresAt:saved.snapshot.priorMembership.expiresAt,termLabel:label(saved.snapshot.policy)}}:{})};
  }
  return {statusInTransaction,saveOrderInTransaction,assertPayableInTransaction,fulfillmentInTransaction,commitFulfillmentInTransaction,orderInfoInTransaction,
    status:userId=>postgresTransaction(pool,async c=>{await c.query(`SET LOCAL search_path TO "${schema}"`);return statusInTransaction(c,userId);})};
}
