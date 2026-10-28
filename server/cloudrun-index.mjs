import {prepareGrantHost} from './collaboration/grant-host.mjs';
import {createApplicationMaterials} from './application-materials.mjs';
import {requireRule} from './domain.mjs';
import {initializeBatch2,createBatch2Content} from './batch2-content.mjs';
import {createServer} from 'node:http';
import {readFileSync} from 'node:fs';
import {createHash} from 'node:crypto';
import {fileURLToPath} from 'node:url';
import {resolve} from 'node:path';
import {openPostgres} from './postgres.mjs';
import {validatePostgresRuntime,verifyPostgresImport,createPostgresPaymentRuntime,virtualPaymentApproved} from './postgres-runtime.mjs';
import {initializeVirtualPaymentSchema} from './postgres-virtual-payment.mjs';
import {verifyFreshDatabase,initializeFreshDatabase} from './postgres-fresh.mjs';
import {initializeReportStore,importReportBatch} from './postgres-report-store.mjs';
import {seedPublishedContent} from './postgres-published-content.mjs';
import {createPostgresCore} from './postgres-core.mjs';
import {createPostgresManualAftercare} from './postgres-manual-aftercare.mjs';
import {createPostgresForms} from './postgres-forms.mjs';
import {createPostgresContent} from './postgres-content.mjs';
import {createPostgresSupport} from './postgres-support.mjs';
import {createPostgresAdmin} from './postgres-admin.mjs';
import {initializeOperationsAdmin} from './postgres-admin-setup.mjs';
import {createPostgresApplication} from './postgres-app.mjs';
import {prepareProfileRuntime} from './postgres-profile-runtime.mjs';
import {createWechatAdapter} from './wechat.mjs';
import {createPostgresRewardRuntime,initializeRewardRuntime} from './postgres-reward-runtime.mjs';
import {createPostgresInviteCode,initializePostVersionRuntime,createPostgresLifecycleRuntime,initializeRenewalRuntime,initializeReminderRuntime,verifyLifecycleRuntime} from './postgres-feature-runtime.mjs';
import {createPostgresReviewRuntime,initializeReviewRuntime,verifyReviewRuntime} from './postgres-review-runtime.mjs';
import {initializeReviewAccounts} from './postgres-review-setup.mjs';
import {decodeCloudRuntimeEnvironment,cloudRuntimeEnvelopeKey} from './cloudrun-config.mjs';
import {runCloudReportIncremental} from './cloudrun-report-incremental.mjs';

export function createManualAftercareRuntime(pool,config,{admin,paymentRuntime,rewards}){
  // A renewal-enabled environment still contains eligible first purchases.
  // The service checks each original transaction and rejects later orders.
  if(!admin||paymentRuntime.paymentChannel!=='virtual'||!paymentRuntime.virtualPayment?.configured||rewards?.enabled===true)return undefined;
  return createPostgresManualAftercare(pool,{...config,env:paymentRuntime.virtualPayment.env,authorizeInTransaction:admin.directorySessionInTransaction.bind(admin)});
}

// Optional one-shot diagnosis of the existing approved credential chain. Failure
// is reported separately and never closes ordinary PG business or recovery.
export async function checkVirtualTokenAtStartup(config,virtualPayment,flag){
  if(flag===undefined)return {checked:false};
  if(flag!==config.appId||(config.paymentChannel??'virtual')!=='virtual'||!virtualPaymentApproved(config)
    ||virtualPayment?.configured!==true||virtualPayment.appId!==config.appId||typeof virtualPayment.checkAvailability!=='function')
    return {checked:true,success:false,code:'VIRTUAL_DIAGNOSTIC_TARGET_INVALID'};
  try{
    const result=await virtualPayment.checkAvailability();
    if(result?.available!==true)throw Error('unavailable');
    return {checked:true,success:true};
  }catch{return {checked:true,success:false,code:'VIRTUAL_TOKEN_UNAVAILABLE'};}
}

// The image starts without credentials. Business routes stay closed until the
// explicit runtime validation and the selected database check both pass.
export async function startCloudMigration(env=process.env){
  const port=Number(env.PORT||8080);
  if(!Number.isInteger(port)||port<1024||port>65535)throw Error('Invalid port');
  let pool,delegate,virtualPayment,application,state='configuration-required',closing=false,check;
  const server=createServer((req,res)=>{
    let path;try{path=new URL(req.url,'http://localhost').pathname;}catch{}
    if(delegate)return delegate(req,res);
    const liveness=(req.method==='GET'||req.method==='HEAD')&&path==='/healthz';
    const health=req.method==='GET'&&path==='/api/health';
    const payload=liveness?{status:'ok',mode:'migration-bootstrap',releaseReady:false}:
      health?{status:state,mode:'migration-bootstrap',releaseReady:false,databaseReady:false,paymentReady:false,nativeAuth:{wechat:false,localTrial:false},...(check?{check}:{})}:
      {error:'迁移服务尚未完成配置，请稍后再试'};
    res.writeHead(liveness?200:503,{'Content-Type':'application/json; charset=utf-8','Cache-Control':'no-store','X-Content-Type-Options':'nosniff','Retry-After':'60'});
    req.resume();res.end(req.method==='HEAD'?undefined:JSON.stringify(payload));
  });
  server.headersTimeout=15000;server.requestTimeout=30000;
  await new Promise((resolve,reject)=>{server.once('error',reject);server.listen(port,'0.0.0.0',resolve);});
  const initialized=(async()=>{
    if(!env.CLUB_RUNTIME_JSON&&!env.CLUB_RUNTIME_CONFIG&&env[cloudRuntimeEnvelopeKey]===undefined)return;
    state='initializing';
    let stage='runtime-config';
    try{
      if(env.NODE_ENV==='production')throw Error('Migration only');
      env=decodeCloudRuntimeEnvironment(env);
      const config=validatePostgresRuntime(JSON.parse(env.CLUB_RUNTIME_JSON||readFileSync(env.CLUB_RUNTIME_CONFIG,'utf8')));
      if(config.listenHost!=='0.0.0.0'||config.port!==port)throw Error('Port mismatch');
      const wechat=createWechatAdapter({appId:config.appId,appSecret:config.wechat?.appSecret});
      stage='database-connect';
      pool=openPostgres({...config.database,max:5});
      if(env.CLUB_INITIALIZE_FRESH_SCHEMA){
        if(config.mode!=='fresh'||env.CLUB_INITIALIZE_FRESH_SCHEMA!==config.schema)throw Error('Explicit fresh setup target mismatch');
        const existing=(await pool.query('SELECT EXISTS(SELECT 1 FROM information_schema.schemata WHERE schema_name=$1) AS present',[config.schema])).rows[0].present;
        if(!existing){stage='fresh-initialize';await initializeFreshDatabase(pool,config);}
      }
      if(env.CLUB_INITIALIZE_REPORT_STORE){
        if(config.mode!=='fresh'||env.CLUB_INITIALIZE_REPORT_STORE!==config.schema||config.reportStorage!=='postgres')throw Error('Explicit private store target mismatch');
        stage='report-store-initialize';await initializeReportStore(pool,config);
      }
      if(env.CLUB_INITIALIZE_VIRTUAL_PAYMENT_SCHEMA){
        if(env.CLUB_INITIALIZE_VIRTUAL_PAYMENT_SCHEMA!==config.schema||!virtualPaymentApproved(config))throw Error('Explicit approved virtual payment upgrade required');
        stage='virtual-payment-schema-initialize';await initializeVirtualPaymentSchema(pool,config);
      }
      if(env.CLUB_INITIALIZE_REWARD_LEDGER_SCHEMA){
        stage='reward-ledger-schema-initialize';await initializeRewardRuntime(pool,config,env.CLUB_INITIALIZE_REWARD_LEDGER_SCHEMA);
      }
      if(env.CLUB_INITIALIZE_POST_VERSIONS_SCHEMA){
        stage='post-versions-schema-initialize';await initializePostVersionRuntime(pool,config,env.CLUB_INITIALIZE_POST_VERSIONS_SCHEMA);
      }
      if(env.CLUB_INITIALIZE_RENEWALS_SCHEMA){
        stage='renewals-schema-initialize';await initializeRenewalRuntime(pool,config,env.CLUB_INITIALIZE_RENEWALS_SCHEMA);
      }
      if(env.CLUB_INITIALIZE_REMINDERS_SCHEMA){
        stage='reminders-schema-initialize';await initializeReminderRuntime(pool,config,env.CLUB_INITIALIZE_REMINDERS_SCHEMA);
      }
      if(env.CLUB_INITIALIZE_REVIEW_ACCESS_SCHEMA){
        stage='review-access-schema-initialize';await initializeReviewRuntime(pool,config,env.CLUB_INITIALIZE_REVIEW_ACCESS_SCHEMA);
      }
      stage='database-verify';
      if(config.mode==='fresh')await verifyFreshDatabase(pool,config,env.PROFILE_SCHEMA_TARGET);
      else await verifyPostgresImport(pool,config);
      stage='lifecycle-config-verify';await verifyLifecycleRuntime(pool,config);
      if(env.CLUB_CONTENT_SEED_DIGEST){
        if(config.mode!=='fresh'||!/^[a-f0-9]{64}$/.test(env.CLUB_CONTENT_SEED_DIGEST))throw Error('Explicit content target required');
        const bytes=readFileSync(new URL('./published-content.json',import.meta.url));
        if(createHash('sha256').update(bytes).digest('hex')!==env.CLUB_CONTENT_SEED_DIGEST)throw Error('Published content package mismatch');
        stage='published-content-initialize';await seedPublishedContent(pool,config,JSON.parse(bytes));
      }
      if(env.CLUB_REPORT_BATCH_DIGEST){
        if(config.mode!=='fresh'||config.reportStorage!=='postgres'||!/^[a-f0-9]{64}$/.test(env.CLUB_REPORT_BATCH_DIGEST))throw Error('Explicit report batch required');
        const bytes=readFileSync('/opt/club-report-import/batch.json');
        if(createHash('sha256').update(bytes).digest('hex')!==env.CLUB_REPORT_BATCH_DIGEST)throw Error('Private batch package mismatch');
        stage='private-report-import';const result=await importReportBatch(pool,{schema:config.schema,directory:'/opt/club-report-import',files:JSON.parse(bytes).files});
        console.log('Private report batch verified; stored='+result.stored+'; reused='+result.reused+'.');
      }
      if(env.CLUB_ADMIN_BOOTSTRAP_JSON){
        stage='operations-admin-initialize';await initializeOperationsAdmin(pool,config,JSON.parse(env.CLUB_ADMIN_BOOTSTRAP_JSON));
      }
      if(env.CLUB_REVIEW_ACCOUNT_BOOTSTRAP_JSON){
        stage='review-account-initialize';await initializeReviewAccounts(pool,config,JSON.parse(env.CLUB_REVIEW_ACCOUNT_BOOTSTRAP_JSON));
      }
      stage='review-access-config-verify';await verifyReviewRuntime(pool,config);
      stage='incremental-report-batch';
      const incremental=await runCloudReportIncremental(pool,config,env);
      if(incremental.enabled)console.log('Incremental private report batch; '+JSON.stringify(incremental)+'.');
      if(closing)return;
      const grantHost=await prepareGrantHost(pool,{schema:config.schema,adminOrigin:config.adminOrigin});
      const grantOptions=grantHost?{entitlementResolver:grantHost.entitlementResolver,grantPaymentConflict:grantHost.grantPaymentConflict}:{};
      const rewards=createPostgresRewardRuntime(pool,config);
      const {renewals,reminders}=createPostgresLifecycleRuntime(pool,config);
      const core=createPostgresCore(pool,{...config,rewards,renewals,...grantOptions}),paymentRuntime=await createPostgresPaymentRuntime(pool,config,wechat,core,{rewards,renewals,grantPaymentConflict:grantHost?.grantPaymentConflict});
      virtualPayment=paymentRuntime.virtualPayment;
      if(env.CLUB_VERIFY_VIRTUAL_TOKEN_APPID!==undefined){
        const tokenCheck=await checkVirtualTokenAtStartup(config,virtualPayment,env.CLUB_VERIFY_VIRTUAL_TOKEN_APPID);
        console.log('Virtual payment token availability; '+JSON.stringify(tokenCheck)+'.');
      }
      const inviteCode=createPostgresInviteCode(pool,config,wechat);
      const reviewAccess=createPostgresReviewRuntime(pool,config);
      const admin=config.adminOrigin?createPostgresAdmin(pool,config):undefined;
      const manualAftercare=createManualAftercareRuntime(pool,config,{admin,paymentRuntime,rewards});
      const profile=await prepareProfileRuntime(pool,config,env.PROFILE_SCHEMA_TARGET);
      let batch2;
      if(env.BATCH2_SCHEMA_TARGET){
        requireRule(config.mode==='fresh'&&env.BATCH2_SCHEMA_TARGET===config.schema,'运营维护目标数据区不一致');
        await initializeBatch2(pool,{schema:config.schema,targetSchema:env.BATCH2_SCHEMA_TARGET});
        batch2=createBatch2Content(pool,config);
      }

      application=createPostgresApplication({core,grantHost,profile,batch2,rewards,reminders,inviteCode,reviewAccess,manualAftercare,forms:createPostgresForms(pool,config),applicationMaterials:createApplicationMaterials(pool,config),content:createPostgresContent(pool,{...config,...grantOptions}),support:createPostgresSupport(pool,config),admin,wechat,...paymentRuntime,hosts:config.hosts,origins:config.origins,enterpriseIntake:config.enterpriseIntake===true,mode:config.mode});
      const handler=application.listeners('request')[0];
      delegate=(req,res)=>{
        if((req.method==='GET'||req.method==='HEAD')&&req.url==='/healthz'){
          const serverHost=/^[a-zA-Z0-9.:-]{1,180}$/.test(req.headers.host||'')?req.headers.host:undefined;
          res.writeHead(200,{'Content-Type':'application/json','Cache-Control':'no-store'});res.end(req.method==='HEAD'?undefined:JSON.stringify({status:'ok',mode:config.mode,releaseReady:false,serverHost}));return;
        }
        return handler(req,res);
      };
      state='database-ready';
      console.log('Cloud database initialization verified; releaseReady=false.');
    }catch(error){
      state='configuration-invalid';
      virtualPayment?.stopRecovery?.();
      application?.stopMaintenance?.();
      if(pool){await pool.end().catch(()=>{});pool=undefined;}
      // Raw connection errors and config must never enter cloud logs.
      const codes=new Set(['28P01','28000','3D000','42501','42P06','42P01','55000','ECONNREFUSED','ETIMEDOUT','ENETUNREACH','ERR_TLS_CERT_ALTNAME_INVALID','CERT_HAS_EXPIRED','UNABLE_TO_VERIFY_LEAF_SIGNATURE','SELF_SIGNED_CERT_IN_CHAIN','DEPTH_ZERO_SELF_SIGNED_CERT']);
      const code=codes.has(error?.code)?error.code:'unclassified';
      check={stage,code};
      if(code==='ERR_TLS_CERT_ALTNAME_INVALID'){
        const name=value=>typeof value==='string'&&/^[a-zA-Z0-9.*:, _-]{1,500}$/.test(value)?value:undefined;
        check.tlsIdentity={requested:name(error.host),commonName:name(error.cert?.subject?.CN),alternativeNames:name(error.cert?.subjectaltname)};
      }
      console.error('Cloud configuration/database check failed; stage='+stage+'; code='+code+'; business routes remain closed.');
    }
  })();
  async function close(){
    if(closing)return;closing=true;
    virtualPayment?.stopRecovery?.();
    application?.stopMaintenance?.();
    server.closeIdleConnections();
    await new Promise(resolve=>server.close(resolve));
    await initialized;if(pool)await pool.end();
  }
  return {server,initialized,close};
}

if(process.argv[1]&&resolve(process.argv[1])===fileURLToPath(import.meta.url)){
  try{
    const service=await startCloudMigration();
    console.log('Cloud migration container listening; business readiness is reported separately.');
    for(const signal of ['SIGINT','SIGTERM'])process.once(signal,()=>{
      const deadline=setTimeout(()=>process.exit(1),35000);deadline.unref();
      service.close().then(()=>{clearTimeout(deadline);process.exit(0);},()=>process.exit(1));
    });
  }catch{console.error('Cloud migration container failed to start.');process.exitCode=1;}
}
