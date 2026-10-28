import {createPostgresRewards,initializePostgresRewards} from './postgres-rewards.mjs';

export function rewardsApproved(config){return config?.rewards?.enabled===true&&config.rewards.status==='approved';}
export function validateRewardRuntime(config){
  if(config.rewards===undefined)return;
  const value=config.rewards;
  if(!value||typeof value!=='object'||Array.isArray(value)||typeof value.enabled!=='boolean'
    ||!['draft','approved','disabled'].includes(value.status)
    ||Object.keys(value).some(key=>!['enabled','status'].includes(key)))
    throw new Error('奖励运行配置格式不正确；正式规则与岗位授权须另行批准。');
}
export function createPostgresRewardRuntime(pool,config){
  validateRewardRuntime(config);
  return Object.assign(createPostgresRewards(pool,{schema:config.schema,enabled:rewardsApproved(config)}),{enabled:rewardsApproved(config)});
}
export async function initializeRewardRuntime(pool,config,flag){
  if(flag===undefined)return;
  if(flag!==config.schema||config.mode!=='fresh'||!rewardsApproved(config))
    throw new Error('奖励迁移需要明确的已批准配置与精确数据区。');
  return initializePostgresRewards(pool,{schema:config.schema});
}
