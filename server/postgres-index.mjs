import {readFileSync} from 'node:fs';
import {openPostgres} from './postgres.mjs';
import {validatePostgresRuntime,verifyPostgresImport,createPostgresPaymentRuntime,virtualPaymentApproved} from './postgres-runtime.mjs';
import {verifyVirtualPaymentSchema} from './postgres-virtual-payment.mjs';
import {verifyFreshDatabase} from './postgres-fresh.mjs';
import {createPostgresCore} from './postgres-core.mjs';
import {createPostgresForms} from './postgres-forms.mjs';
import {createPostgresContent} from './postgres-content.mjs';
import {createPostgresSupport} from './postgres-support.mjs';
import {createPostgresAdmin} from './postgres-admin.mjs';
import {createPostgresApplication} from './postgres-app.mjs';
import {createWechatAdapter} from './wechat.mjs';
import {createPostgresRewardRuntime} from './postgres-reward-runtime.mjs';
import {createPostgresInviteCode,createPostgresLifecycleRuntime,verifyLifecycleRuntime} from './postgres-feature-runtime.mjs';
import {createPostgresReviewRuntime,verifyReviewRuntime} from './postgres-review-runtime.mjs';

let pool,server;
try{
  if(process.env.NODE_ENV==='production'||process.argv[2]!=='--config'||!process.argv[3]||process.argv.length>5||
    (process.argv[4]!==undefined&&process.argv[4]!=='--check'))throw Error('invalid invocation');
  const config=validatePostgresRuntime(JSON.parse(readFileSync(process.argv[3],'utf8')));
  const wechat=createWechatAdapter({appId:config.appId,appSecret:config.wechat?.appSecret});
  pool=openPostgres({...config.database,max:5});
  if(config.mode==='fresh')await verifyFreshDatabase(pool,config);else await verifyPostgresImport(pool,config);
  await verifyLifecycleRuntime(pool,config);
  await verifyReviewRuntime(pool,config);
  if(virtualPaymentApproved(config))await verifyVirtualPaymentSchema(pool,config);
  if(process.argv[4]==='--check'){
    await pool.end();console.log('配置及隔离库导入标记检查通过；未启动HTTP、未调用微信、未写入数据库。');
  }else{
    const rewards=createPostgresRewardRuntime(pool,config),{renewals,reminders}=createPostgresLifecycleRuntime(pool,config),core=createPostgresCore(pool,{...config,rewards,renewals}),forms=createPostgresForms(pool,config);
    const paymentRuntime=await createPostgresPaymentRuntime(pool,config,wechat,core,{rewards,renewals});
    const inviteCode=createPostgresInviteCode(pool,config,wechat);
    const reviewAccess=createPostgresReviewRuntime(pool,config);
    server=createPostgresApplication({core,rewards,reminders,inviteCode,reviewAccess,forms,content:createPostgresContent(pool,config),support:createPostgresSupport(pool,config),admin:config.adminOrigin?createPostgresAdmin(pool,config):undefined,wechat,...paymentRuntime,hosts:config.hosts,origins:config.origins,enterpriseIntake:config.enterpriseIntake===true,mode:config.mode});
    await new Promise((resolve,reject)=>{server.once('error',reject);server.listen(config.port,config.listenHost,resolve);});
    console.log('PostgreSQL隔离迁移服务已启动；尚未完成正式发布验收。');
    let closing=false;
    for(const signal of ['SIGINT','SIGTERM'])process.on(signal,()=>{
      if(closing)return;closing=true;
      const timer=setTimeout(()=>process.exit(1),35000);timer.unref();
      server.close(async()=>{try{await pool.end();clearTimeout(timer);process.exit(0);}catch{process.exit(1);}});
    });
  }
}catch{
  // Connection errors may contain credentials; never print raw error objects.
  console.error('迁移服务启动/检查失败。请核对私有配置、数据库连接和导入报告；未切换正式服务。');
  server?.close();if(pool)await pool.end().catch(()=>{});process.exitCode=1;
}
