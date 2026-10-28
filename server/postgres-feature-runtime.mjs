import {postgresTransaction} from './postgres.mjs';
import {initializePostgresPostVersions} from './postgres-content.mjs';
import {createNativeInviteCode} from './native-invite-code.mjs';
import {createPostgresRenewals,initializePostgresRenewals,configurePostgresRenewalPolicy,renewalMigrationTables} from './postgres-renewals.mjs';
import {createPostgresReminders,initializePostgresReminders} from './postgres-reminders.mjs';

const object=value=>value&&typeof value==='object'&&!Array.isArray(value);
const approvedRenewalPolicy=value=>object(value)&&value.status==='approved'&&value.termKind==='calendar_year'
  &&value.startPolicy==='later_expiry_or_verified_paid_at'&&['version','approvalRef','approvedAt'].every(key=>typeof value[key]==='string'&&value[key].length>0)
  &&Number.isFinite(Date.parse(value.approvedAt))&&Date.parse(value.approvedAt)<=Date.now()
  &&Object.keys(value).every(key=>['status','version','approvalRef','approvedAt','termKind','startPolicy'].includes(key));
const stable=value=>JSON.stringify(Object.fromEntries(Object.entries(value).sort(([a],[b])=>a.localeCompare(b))));

export function validatePhaseOneFeatures(config){
  if(config.postVersions!==undefined&&typeof config.postVersions!=='boolean')throw Error('投稿版本配置不正确');
  const code=config.nativeInviteCode;
  if(code!==undefined){
    if(!code||typeof code!=='object'||Array.isArray(code)||typeof code.enabled!=='boolean'
      ||Object.keys(code).some(key=>!['enabled','envVersion','checkPath','releaseEntryVerified'].includes(key)))
      throw Error('邀请扫码配置不正确');
    if(code.enabled&&(!config.wechat||!['release','trial','develop'].includes(code.envVersion)||typeof code.checkPath!=='boolean'))
      throw Error('邀请扫码环境及微信身份必须明确配置');
    if(code.releaseEntryVerified!==undefined&&typeof code.releaseEntryVerified!=='boolean')throw Error('邀请正式入口验证记录不正确');
  }
  const renewal=config.renewals;
  if(renewal!==undefined){
    if(!object(renewal)||typeof renewal.enabled!=='boolean'||Object.keys(renewal).some(key=>!['enabled','policy'].includes(key)))throw Error('续费运行配置不正确');
    if(renewal.enabled&&!approvedRenewalPolicy(renewal.policy))throw Error('续费必须明确配置已批准周年口径及保留剩余时间的规则快照');
    if(renewal.policy!==undefined&&!approvedRenewalPolicy(renewal.policy))throw Error('续费规则快照与本轮批准的周年口径不一致');
  }
  const reminder=config.reminders;
  if(reminder!==undefined){
    if(!object(reminder)||typeof reminder.enabled!=='boolean'||Object.keys(reminder).some(key=>key!=='enabled'))throw Error('提醒运行配置不正确');
    // This assembly deliberately has no sender, trusted callback or worker.
    if(reminder.enabled)throw Error('真实提醒模板、时点、可信事件及发送渠道尚未完成配置，不能启用提醒');
  }
}
export async function initializeRenewalRuntime(pool,config,flag){
  if(flag===undefined)return;
  validatePhaseOneFeatures(config);
  if(flag!==config.schema||config.mode!=='fresh'||config.renewals?.enabled!==true)throw Error('续费迁移需要明确开启已批准配置及精确数据区');
  await initializePostgresRenewals(pool,{schema:config.schema});
  return configurePostgresRenewalPolicy(pool,{schema:config.schema,policy:config.renewals.policy});
}
export async function initializeReminderRuntime(pool,config,flag){
  if(flag===undefined)return;
  validatePhaseOneFeatures(config);
  if(flag!==config.schema||config.mode!=='fresh'||config.reminders?.enabled!==false)throw Error('提醒存储迁移需要显式关闭提醒发送及精确数据区');
  return initializePostgresReminders(pool,{schema:config.schema});
}
export async function verifyLifecycleRuntime(pool,config){
  validatePhaseOneFeatures(config);if(config.renewals?.enabled!==true)return {renewals:false,reminders:false};
  return postgresTransaction(pool,async c=>{
    await c.query('SET TRANSACTION READ ONLY');await c.query(`SET LOCAL search_path TO "${config.schema}"`);
    if((await renewalMigrationTables(c,config.schema)).length!==1)throw Error('续费已启用，但005存储未显式初始化');
    const stored=(await c.query("SELECT value FROM settings WHERE key='membership_renewal_policy_v1'")).rows[0];let policy;
    try{policy=JSON.parse(stored?.value??'null');}catch{}
    if(!approvedRenewalPolicy(policy)||stable(policy)!==stable(config.renewals.policy))throw Error('续费已启用，但已批准规则尚未落库或与运行配置不一致');
    return {renewals:true,reminders:false};
  });
}
export function createPostgresLifecycleRuntime(pool,config){
  validatePhaseOneFeatures(config);
  return {renewals:createPostgresRenewals(pool,{schema:config.schema,enabled:config.renewals?.enabled===true}),
    reminders:createPostgresReminders(pool,{schema:config.schema,appId:config.appId,enabled:false})};
}
export async function initializePostVersionRuntime(pool,config,flag){
  if(flag===undefined)return;
  if(flag!==config.schema||config.mode!=='fresh'||config.postVersions!==true)
    throw Error('投稿版本迁移需要明确开启及精确数据区');
  return initializePostgresPostVersions(pool,{schema:config.schema});
}
export function createPostgresInviteCode(pool,config,wechat,{fetchImpl=globalThis.fetch}={}){
  validatePhaseOneFeatures(config);
  return createNativeInviteCode({...config.nativeInviteCode,appId:config.appId},{
    fetchImpl,getAccessToken:input=>wechat.getAccessToken(input),
    getMember:id=>postgresTransaction(pool,async client=>{
      await client.query('SET TRANSACTION READ ONLY');
      await client.query(`SET LOCAL search_path TO "${config.schema}"`);
      const row=(await client.query('SELECT id,role,referral_code FROM users WHERE id=$1',[id])).rows[0];
      return row&&{id:row.id,role:row.role,referralCode:row.referral_code};
    }),
  });
}
