import {postgresTransaction} from './postgres.mjs';
import {createPostgresReviewAccess,initializePostgresReviewAccess,reviewApplication,reviewMigrationTables} from './postgres-review-access.mjs';

export function validateReviewRuntime(config){
  const value=config.reviewAccess;if(value===undefined)return;
  if(!value||typeof value!=='object'||Array.isArray(value)||typeof value.enabled!=='boolean'
    ||Object.keys(value).some(key=>!['enabled','status','appId','appVersion','approvedBy','approvedAt','approvalRef'].includes(key))
    ||(value.status!==undefined&&!['disabled','draft','approved'].includes(value.status)))throw Error('审核只读运行配置不正确');
  if(value.enabled&&(value.status!=='approved'||value.appId!==reviewApplication.appId||value.appId!==config.appId
    ||value.appVersion!==reviewApplication.appVersion||!['approvedBy','approvalRef'].every(key=>typeof value[key]==='string'&&value[key].trim().length>0)
    ||typeof value.approvedAt!=='string'||!Number.isFinite(Date.parse(value.approvedAt))||Date.parse(value.approvedAt)>Date.now()
    ||config.legal?.status!=='approved'))throw Error('审核只读入口须明确批准当前AppID/1.1.0、负责人和现行协议');
  if(value.enabled)createPostgresReviewAccess({connect(){throw Error('validation must not access DB');}},{...value,schema:config.schema,legal:config.legal,reportStorage:config.reportStorage});
}
export function createPostgresReviewRuntime(pool,config){
  validateReviewRuntime(config);
  return createPostgresReviewAccess(pool,{...config.reviewAccess,schema:config.schema,
    appId:config.reviewAccess?.appId??config.appId,appVersion:config.reviewAccess?.appVersion??reviewApplication.appVersion,
    enabled:config.reviewAccess?.enabled===true,legal:config.legal,reportStorage:config.reportStorage});
}
export async function initializeReviewRuntime(pool,config,flag){
  if(flag===undefined)return;
  validateReviewRuntime(config);
  if(flag!==config.schema||config.mode!=='fresh'||config.reviewAccess?.enabled!==true||config.reviewAccess.status!=='approved')throw Error('007审核存储迁移须明确批准开启并精确指定数据区');
  // This helper only initializes empty stores. There is no account/password/grant
  // setup path; those actions require separate concrete human authorization.
  return initializePostgresReviewAccess(pool,{schema:config.schema});
}
export async function verifyReviewRuntime(pool,config){
  validateReviewRuntime(config);if(config.reviewAccess?.enabled!==true)return {enabled:false};
  await postgresTransaction(pool,async c=>{
    await c.query('SET TRANSACTION READ ONLY');await c.query(`SET LOCAL search_path TO "${config.schema}"`);
    if((await reviewMigrationTables(c,config.schema)).length!==2)throw Error('审核入口已配置，但007存储未显式初始化');
  });
  // Account readiness controls advertising; a revoked reviewer must not disable
  // ordinary member business. Every review request still rechecks its own grant.
  return createPostgresReviewRuntime(pool,config).readiness();
}
