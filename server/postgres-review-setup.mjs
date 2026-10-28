import {postgresTransaction} from './postgres.mjs';
import {digest,requireRule} from './domain.mjs';
import {validateReviewRuntime} from './postgres-review-runtime.mjs';
import {reviewApplication,reviewMigrationTables} from './postgres-review-access.mjs';

export const reviewAccountBootstrapMarker='_club_review_accounts_bootstrap_v1';
export const reviewAccountApproval={approvedBy:'Ethan',approvalRef:'Ethan direct reply call_Lt5qFPIZxw4BlxV9v9cV7yYl'};
const uuid=/^[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}$/;
const hashPattern=/^[a-f0-9]{32}:[a-f0-9]{128}$/;
const one=async(c,sql,args=[])=>(await c.query(sql,args)).rows[0];
const exact=(value,keys)=>value&&typeof value==='object'&&!Array.isArray(value)&&Object.keys(value).length===keys.length&&Object.keys(value).every(key=>keys.includes(key));
const canonical=value=>Array.isArray(value)?value.map(canonical):value&&typeof value==='object'?Object.fromEntries(Object.keys(value).sort().map(key=>[key,canonical(value[key])])):value;
const iso=value=>new Date(value instanceof Date?value.getTime():Date.parse(value)).toISOString();
function payload(config,input){
  validateReviewRuntime(config);
  requireRule(config.mode==='fresh'&&/^club_migration_[a-z0-9_]{1,40}$/.test(config.schema||'')&&config.reviewAccess?.enabled===true&&config.reviewAccess.status==='approved','审核账号初始化需要明确已批准的新版配置');
  requireRule(exact(input,['version','schema','appId','appVersion','approvedBy','approvedAt','approvalRef','accounts'])&&input.version===1&&input.schema===config.schema&&input.appId===config.appId
    &&input.appId===reviewApplication.appId&&input.appVersion===reviewApplication.appVersion,'审核账号初始化目标或字段不正确');
  requireRule(input.approvedBy===reviewAccountApproval.approvedBy&&input.approvalRef===reviewAccountApproval.approvalRef
    &&['appId','appVersion','approvedBy','approvedAt','approvalRef'].every(key=>input[key]===config.reviewAccess[key]),'审核账号初始化须与本次负责人批准快照完全匹配');
  requireRule(Array.isArray(input.accounts)&&input.accounts.length===2,'须一次初始化基础和星级两个审核账号');
  const accounts=input.accounts.map(row=>{
    requireRule(exact(row,['id','username','planId','passwordHash','scope'])&&uuid.test(row.id||'')&&['basic','star'].includes(row.planId)&&row.username==='review_'+row.planId+'_110'&&hashPattern.test(row.passwordHash||''),'审核账号身份或密码指纹不正确');
    requireRule(exact(row.scope,['articleIds','resourceIds'])&&Array.isArray(row.scope.articleIds)&&row.scope.articleIds.length===63
      &&row.scope.articleIds.every(id=>typeof id==='string'&&uuid.test(id))&&new Set(row.scope.articleIds).size===63&&Array.isArray(row.scope.resourceIds)&&row.scope.resourceIds.length===0,'审核账号仅允许本次明确批准的63份报告清单');
    return {...row,scope:{articleIds:[...row.scope.articleIds].sort(),resourceIds:[]}};
  }).sort((a,b)=>a.planId.localeCompare(b.planId));
  requireRule(new Set(accounts.map(row=>row.planId)).size===2&&new Set(accounts.map(row=>row.id)).size===2&&new Set(accounts.map(row=>row.passwordHash)).size===2,'两个审核账号档位、ID及密码指纹必须独立');
  requireRule(JSON.stringify(accounts[0].scope)===JSON.stringify(accounts[1].scope),'两个账号须使用同一本次批准报告清单，仍按原档位限制访问');
  return {...input,accounts};
}
async function completeStore(c,schema){
  requireRule((await reviewMigrationTables(c,schema)).length===2,'007审核存储尚未完整初始化',503);
  const columns=(await c.query("SELECT table_name,column_name,data_type FROM information_schema.columns WHERE table_schema=$1 AND table_name IN ('_club_review_accounts','_club_review_sessions')",[schema])).rows;
  const expected=[];
  for(const name of ['id','username','password_hash','app_id','app_version','plan_id','approved_by','approval_ref'])expected.push('_club_review_accounts:'+name+':text');
  expected.push('_club_review_accounts:scope_json:jsonb');
  for(const name of ['starts_at','expires_at','approved_at','revoked_at'])expected.push('_club_review_accounts:'+name+':timestamp with time zone');
  for(const name of ['token_hash','account_id','auth_mode','grant_digest'])expected.push('_club_review_sessions:'+name+':text');
  for(const name of ['created_at','expires_at'])expected.push('_club_review_sessions:'+name+':timestamp with time zone');
  expected.push('_club_review_sessions:consent_json:jsonb');
  requireRule(columns.map(row=>row.table_name+':'+row.column_name+':'+row.data_type).sort().join(',')===expected.sort().join(','),'007审核存储列结构不完整',503);
}
function persistedMatches(row,wanted,input,marker){
  const scope=typeof row.scope_json==='string'?JSON.parse(row.scope_json):row.scope_json;
  return row.id===wanted.id&&row.username===wanted.username&&row.plan_id===wanted.planId&&row.password_hash===wanted.passwordHash
    &&row.app_id===input.appId&&row.app_version===input.appVersion&&row.approved_by===input.approvedBy&&row.approval_ref===input.approvalRef
    &&iso(row.approved_at)===iso(input.approvedAt)&&iso(row.starts_at)===marker.startsAt&&iso(row.expires_at)===marker.expiresAt&&!row.revoked_at
    &&digest(JSON.stringify(canonical(scope)))===digest(JSON.stringify(canonical(wanted.scope)));
}
// The explicit payload contains only caller-supplied password hashes. Never
// generate credentials, write plaintext, create members, or expose an HTTP route.
export async function initializeReviewAccounts(pool,config,input){
  const normalized=payload(config,input),requestHash=digest(JSON.stringify(canonical(normalized)));
  return postgresTransaction(pool,async c=>{
    await c.query(`SET LOCAL search_path TO "${config.schema}"`);await c.query('LOCK TABLE settings IN SHARE ROW EXCLUSIVE MODE');
    await completeStore(c,config.schema);await c.query('LOCK TABLE _club_review_accounts IN SHARE ROW EXCLUSIVE MODE');
    const ids=normalized.accounts[0].scope.articleIds;
    const published=(await c.query("SELECT id FROM articles WHERE id=ANY($1::text[]) AND status='published' FOR SHARE",[ids])).rows;
    requireRule(published.length===63&&published.every(row=>ids.includes(row.id)),'批准报告清单含不存在或未发布的内容，未初始化账号',409);
    const saved=await one(c,'SELECT value FROM settings WHERE key=$1',[reviewAccountBootstrapMarker]);
    const rows=(await c.query('SELECT * FROM _club_review_accounts ORDER BY plan_id FOR UPDATE')).rows;
    if(saved){
      let marker;try{marker=JSON.parse(saved.value);}catch{}
      requireRule(exact(marker,['version','requestHash','startsAt','expiresAt'])&&marker.version===1&&marker.requestHash===requestHash
        &&Date.parse(marker.expiresAt)-Date.parse(marker.startsAt)===30*86400000&&rows.length===2
        &&rows.every((row,index)=>persistedMatches(row,normalized.accounts[index],normalized,marker)),'审核账号已初始化，不能更换密码、范围、批准或续期；请核对既有授权',409);
      return {reused:true,accounts:2,startsAt:marker.startsAt,expiresAt:marker.expiresAt};
    }
    requireRule(rows.length===0,'存在未完整标记的审核账号，禁止补套或覆盖授权',409);
    const serverTime=await one(c,'SELECT clock_timestamp() AS at'),startsAt=iso(serverTime.at),expiresAt=new Date(Date.parse(startsAt)+30*86400000).toISOString();
    requireRule(Date.parse(normalized.approvedAt)<=Date.parse(startsAt),'批准时间不得晚于真实服务器首次启用时间',409);
    for(const row of normalized.accounts)await c.query('INSERT INTO _club_review_accounts(id,username,password_hash,app_id,app_version,plan_id,scope_json,starts_at,expires_at,approved_by,approval_ref,approved_at) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12)',
      [row.id,row.username,row.passwordHash,normalized.appId,normalized.appVersion,row.planId,JSON.stringify(row.scope),startsAt,expiresAt,normalized.approvedBy,normalized.approvalRef,normalized.approvedAt]);
    await c.query('INSERT INTO settings(key,value) VALUES($1,$2)',[reviewAccountBootstrapMarker,JSON.stringify({version:1,requestHash,startsAt,expiresAt})]);
    return {reused:false,accounts:2,startsAt,expiresAt};
  });
}
