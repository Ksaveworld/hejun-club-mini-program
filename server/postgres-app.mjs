import {createReportUpload} from './report-upload-session.mjs';
import {exclusiveContactsForMembership,publicServicePeople} from './exclusive-contacts.mjs';
import {createApplicationUpload} from './application-materials.mjs';
import {createServer} from 'node:http';
import {createSourceDiagnostics} from './source-diagnostics.mjs';
import {requireRule,plans} from './domain.mjs';
import {surveys} from './surveys.mjs';
import {intakeConfig,intakeVersion,maxFileBytes} from './enterprise-intake.mjs';
import {sendPublicDocument} from './public-documents.mjs';
import {campaignState} from './campaign.mjs';
import {sendCloudStatic} from './cloud-static.mjs';
import {createEnterpriseUpload} from './enterprise-upload.mjs';
import {createPostgresRateLimiter,createLoginAdmission} from './postgres-rate-limit.mjs';

// Migration endpoint, all supported routes use the same PG database. Explicitly not
// a replacement for the full production application until remaining modules are ported.
export function createPostgresApplication({core,profile,forms,applicationMaterials,content,batch2,support,rewards,reminders,inviteCode,reviewAccess,admin,grantHost,manualAftercare,wechat,payment,virtualPayment,paymentChannel='ordinary',autoRecover=true,hosts,origins=[],enterpriseIntake=false,mode='migration'}){
  requireRule(Array.isArray(hosts)&&hosts.length>0,'需要显式配置允许访问的服务域名');
  requireRule(['migration','fresh'].includes(mode),'数据库运行方式不受支持');
  if(payment?.configured)requireRule(payment.appId===core.appId&&wechat?.appId===core.appId,'微信身份与支付AppID不一致');
  requireRule(['ordinary','virtual'].includes(paymentChannel),'支付渠道配置不正确');
  if(virtualPayment?.configured)requireRule(virtualPayment.appId===core.appId&&wechat?.appId===core.appId,'虚拟支付身份AppID不一致');
  const ready=paymentChannel==='virtual'?virtualPayment?.configured===true:payment?.configured===true;
  const limit=createPostgresRateLimiter(),admitLogin=createLoginAdmission();
  const admitGrant=createLoginAdmission({concurrency:4,capacity:32,waitMs:5000});
  const sourceDiagnostics=createSourceDiagnostics();
  const uploads=createEnterpriseUpload();
  const reportUploads=createReportUpload();
  const applicationUploads=createApplicationUpload();
  const json=(res,status,data,headers={})=>{res.writeHead(status,{'Content-Type':'application/json; charset=utf-8','Cache-Control':'no-store','X-Content-Type-Options':'nosniff',...headers});res.end(JSON.stringify(data));};
  async function raw(req,max=65536){let size=0;const parts=[];for await(const part of req){size+=part.length;requireRule(size<=max,'请求体过大',413);parts.push(part);}return Buffer.concat(parts).toString('utf8');}
  async function body(req,max){requireRule(req.headers['content-type']?.split(';')[0]==='application/json','请求必须使用JSON',415);const text=await raw(req,max);let result;try{result=JSON.parse(text);}catch{requireRule(false,'请求格式不正确');}requireRule(result&&typeof result==='object'&&!Array.isArray(result),'请求格式不正确');return result;}
  const rewardUnavailable={enabled:false,reason:'奖励及提现规则或岗位权限尚未配置',collectionAllowed:false};
  const reminderUnavailable={enabled:false,reason:'到期提醒尚未启用，真实模板、提醒时点和发送渠道仍待核实。',tasks:[]};
  function rewardResult(value){requireRule(value&&value.configured!==false&&value.enabled!==false,value?.message||value?.reason||'奖励及提现尚未配置',503);return value;}
  function staffRewardView(value){
    if(!value?.configured)return {configured:false,message:value?.message||rewardUnavailable.reason};
    const fields=['id','orderId','beneficiaryId','grossCents','amountCents','reversedCents','status','confirmedAt','maturityAt','createdAt','updatedAt','paidAt','recipientMethod','reason','payoutReconciliationRequired','payoutReconciledAt'];
    const project=row=>Object.fromEntries(fields.filter(key=>row[key]!==undefined).map(key=>[key,row[key]]));
    return {configured:true,rewards:value.rewards.map(project),withdrawals:value.withdrawals.map(project)};
  }
  async function sync(user,id){
    if(paymentChannel==='virtual'){
      if(ready)await virtualPayment.sync(user,id);
      return core.order(user,id);
    }
    const order=await core.order(user,id);
    if(ready&&order.status==='pending'&&await core.attempted(id)){
      const result=await payment.query(id);requireRule(result.appid===core.appId&&result.mchid===payment.merchantId&&result.out_trade_no===id.slice(2),'支付查单主体不一致',409);
      if(result.trade_state==='SUCCESS')await core.applyPayment(result,payment);
    }
    return core.order(user,id);
  }
  const server=createServer(async(req,res)=>{
    try{
      requireRule(hosts.includes(req.headers.host),'访问地址不受支持',403);
      sourceDiagnostics(req,res);
      if(grantHost?.http&&/^\/api\/admin\/membership-grants(?:\/|\?|$)/.test(req.url||'')){
        limit(req,'grant-admission',120);
        if(await admitGrant(req,()=>grantHost.http(req,res),res))return;
      }
      const path=new URL(req.url,'http://localhost').pathname,method=req.method;
      if(path==='/api/exclusive-contacts'){res.setHeader('Cache-Control','no-store');res.setHeader('Vary','Authorization');}
      if(path==='/api/native/auth/login'&&method==='POST')requireRule(!req.headers.cookie&&req.headers.authorization===undefined,'登录时不能混用会话',400);
      // Resolve every bearer before static/public/writing routes. Known expired
      // review tokens throw directly; unknown/disabled review tokens must also
      // fail native authentication before reaching visitor form submissions.
      const token=/^Bearer ([a-f0-9]{64})$/.exec(req.headers.authorization||'')?.[1];
      let user=null;
      if(req.headers.authorization){
        const reviewer=reviewAccess?await reviewAccess.authenticate(token):null;
        const publicMetadata=method==='GET'&&['/api/health','/api/legal','/api/plans','/api/campaign','/api/service-people'].includes(path);
        if(reviewer){
          requireRule(!req.headers.cookie,'审核登录不能混用网页会话',400);
          requireRule(!req.headers.origin||origins.includes(req.headers.origin),'请求来源不受支持',403);
          requireRule(req.headers['sec-fetch-site']!=='cross-site','不允许跨站请求',403);
          if(method!=='GET')requireRule(req.headers['x-club-request']==='1','缺少请求校验标记',403);
          if(!publicMetadata){
            const result=await reviewAccess.handle(reviewer,{method,path:path.replace(/^\/api(?=\/)/,''),req,res});
            if(result?.sent)return;
            return json(res,result.status,result.body);
          }
        }else{
          user=await core.authenticate(token);requireRule(user&&user.role!=='reviewer','请重新登录',401);limit.bind(req,'member',user.id);
        }
      }
      if(path==='/api/payments/wechat/notify'&&method==='POST'&&ready&&paymentChannel==='ordinary'){
        requireRule(!req.headers.cookie&&!req.headers.authorization,'通知不能携带用户身份');
        const notice=payment.decodeNotification(req.headers,await raw(req));
        requireRule(notice.appid===core.appId&&notice.mchid===payment.merchantId&&/^[A-F0-9]{32}$/.test(notice.out_trade_no||''),'支付通知主体不一致',409);
        const confirmed=await payment.query('HJ'+notice.out_trade_no);
        requireRule(confirmed.out_trade_no===notice.out_trade_no&&confirmed.transaction_id===notice.transaction_id,'通知与查单不一致',409);
        await core.applyPayment(confirmed,payment);res.writeHead(204);return res.end();
      }
      requireRule(!req.headers.origin||origins.includes(req.headers.origin)||req.headers.origin===admin?.origin,'请求来源不受支持',403);
      requireRule(req.headers['sec-fetch-site']!=='cross-site','不允许跨站请求',403);
      if(sendCloudStatic(req,res,path,{adminOrigin:admin?.origin}))return;
      if(method!=='GET')requireRule(req.headers['x-club-request']==='1','缺少请求校验标记',403);
      const adminRoute=admin&&(path.startsWith('/api/admin/')||path.startsWith('/api/auth/')||(path==='/api/me'&&req.headers.cookie));
      if(adminRoute){
        requireRule(req.headers.host===new URL(admin.origin).host&&!req.headers.authorization,'后台会话入口不正确',403);
        if(method!=='GET')requireRule(req.headers.origin===admin.origin,'后台操作需要同源请求',403);
        if(path==='/api/auth/login'&&method==='POST'){
          limit(req,'admin-login',10);const result=await admin.login(await body(req));
          // Only verified platform credentials may replace a stale collaboration
          // browser identity. No account, permission or other session is changed.
          return json(res,200,{user:result.user},{'Set-Cookie':[result.cookie,'club_pg_collab=; HttpOnly; Secure; SameSite=Strict; Path=/; Max-Age=0']});
        }
        const actor=await admin.authenticate(req);
        if(path==='/api/me'&&method==='GET')return json(res,200,{user:actor,membership:null,membershipGrantsEnabled:!!grantHost?.http,paymentReady:ready,paymentChannel,manualPaymentReady:false,defaultReferralConfigured:false});
        requireRule(actor,'请重新登录管理员账号',401);
        limit.bind(req,'admin',actor.id);
        if(method!=='GET')requireRule(req.headers['x-club-actor']===actor.id,'登录账号已变化，请刷新后重新操作',409);
        if(path==='/api/auth/logout'&&method==='POST')return json(res,200,{ok:true},{'Set-Cookie':await admin.logout(req)});
        const url=new URL(req.url,'https://'+req.headers.host);
        if(applicationMaterials&&path==='/api/admin/application-materials'&&method==='GET')return json(res,200,await applicationMaterials.listAdmin(actor,url.searchParams.get('before')??undefined,url.searchParams.get('kind')||undefined));
        const applicationFile=/^\/api\/admin\/application-materials\/([a-f0-9-]{36})\/file$/.exec(path);
        if(applicationMaterials&&applicationFile&&method==='GET')return await applicationMaterials.downloadAdmin(actor,applicationFile[1],res);
        if(batch2){
          const meta=/^\/api\/admin\/content-meta\/([a-f0-9-]+)$/.exec(path);
          if(meta&&method==='GET')return json(res,200,{metadata:await batch2.metadata(actor,meta[1])});
          if(meta&&method==='POST')return json(res,200,{metadata:await batch2.saveMetadata(actor,meta[1],await body(req),req.headers['idempotency-key'])});
          if(path==='/api/admin/enterprises'&&method==='GET')return json(res,200,{enterprises:await batch2.enterprises(actor)});
          if(path==='/api/admin/enterprises'&&method==='POST')return json(res,200,{enterprise:await batch2.saveEnterprise(actor,await body(req,256*1024),req.headers['idempotency-key'])});
          const enterprise=/^\/api\/admin\/enterprises\/([a-f0-9-]+)(?:\/(publish|unpublish))?$/.exec(path);
          if(enterprise&&method==='POST'){
            const input=await body(req,256*1024);
            return json(res,200,{enterprise:enterprise[2]?await batch2.transitionEnterprise(actor,enterprise[1],enterprise[2],input.revision,req.headers['idempotency-key']):await batch2.saveEnterprise(actor,input,req.headers['idempotency-key'],enterprise[1])});
          }
          const start=/^\/api\/admin\/articles\/([a-f0-9-]+)\/pdf\/start$/.exec(path);
          if(start&&method==='POST'){
            await batch2.metadata(actor,start[1]);
            limit(req,'admin-pdf-start',10);
            return json(res,200,{upload:reportUploads.start(actor,start[1],await body(req),req.headers['idempotency-key'])});
          }
          const part=/^\/api\/admin\/articles\/([a-f0-9-]+)\/pdf\/([a-f0-9-]+)\/(part|complete|abort)$/.exec(path);
          if(part&&method==='POST'){
            const input=await body(req,400*1024);
            if(part[3]==='abort')return json(res,200,reportUploads.abort(actor,part[1],part[2],input));
            if(part[3]==='part')return json(res,200,reportUploads.part(actor,part[1],part[2],input));
            return json(res,200,await reportUploads.complete(actor,part[1],part[2],input,req.headers['idempotency-key'],(data,key)=>batch2.uploadPdf(actor,part[1],data,key)));
          }
        }

        if(path==='/api/admin/rewards'&&method==='GET'){
          if(!rewards)return json(res,200,{configured:false,message:rewardUnavailable.reason});
          const role=url.searchParams.get('role')||'finance';requireRule(['finance','secretary_general'].includes(role),'岗位不正确');
          return json(res,200,staffRewardView(await rewards.managed(actor,role)));
        }
        const rewardAction=/^\/api\/admin\/rewards\/withdrawals\/(wd-[a-f0-9]{24})\/(finance-review|secretary-approve|reject|payout|failure)$/.exec(path);
        if(rewardAction&&method==='POST'){
          requireRule(rewards,rewardUnavailable.reason,503);limit(req,'reward-staff',30);
          const input=await body(req),id=rewardAction[1],key=req.headers['idempotency-key'];let result;
          if(rewardAction[2]==='finance-review')result=await rewards.financeReview(actor,id,key);
          else if(rewardAction[2]==='secretary-approve')result=await rewards.secretaryApprove(actor,id,key);
          else if(rewardAction[2]==='reject')result=await rewards.rejectWithdrawal(actor,id,input.reason,key,{role:input.role});
          else if(rewardAction[2]==='payout')result=await rewards.recordPayout(actor,id,input,key);
          else result=await rewards.failPayout(actor,id,input,key);
          const projection=staffRewardView({configured:true,rewards:[],withdrawals:[rewardResult(result)]});
          return json(res,200,{withdrawal:projection.withdrawals[0]});
        }
        if(path==='/api/admin/orders'&&method==='GET')return json(res,200,{orders:(await core.managedOrders(actor)).map(order=>({...order,manualAftercareAvailable:!!manualAftercare&&order.status==='paid'&&['basic','star'].includes(order.planId)}))});
        const aftercareOrder=/^\/api\/admin\/orders\/(HJ[A-F0-9]{32})\/manual-aftercare$/.exec(path);
        if(aftercareOrder&&method==='POST'){
          requireRule(manualAftercare,'人工退款权益处理尚未配置',503);
          limit(req,'manual-aftercare',20);
          return json(res,200,await manualAftercare.recordCompleted(actor,aftercareOrder[1],await body(req),req));
        }
        if(path==='/api/admin/members'&&method==='GET')return json(res,200,{members:await core.managedMembers(actor)});
        if(path==='/api/admin/audit'&&method==='GET')return json(res,200,await core.managedAudit(actor,url.searchParams));
        const reviewedOrder=/^\/api\/admin\/orders\/(HJ[A-F0-9]{32})\/review$/.exec(path);
        if(reviewedOrder&&method==='POST')return json(res,200,{order:await core.reviewOrder(actor,reviewedOrder[1],await body(req))});
        if(content){
          const kinds=/^\/api\/admin\/(articles|resources|activities)$/.exec(path),singular={articles:'article',resources:'resource',activities:'activity'};
          if(kinds&&method==='GET')return json(res,200,{[kinds[1]]:await content.managed(actor,kinds[1])});
          if(kinds&&method==='POST')return json(res,201,{[singular[kinds[1]]]:await content.saveManaged(actor,kinds[1],await body(req),req.headers['idempotency-key'])});
          const deletion=/^\/api\/admin\/(articles|activities)\/([a-f0-9-]+)\/delete$/.exec(path);
          if(deletion&&method==='POST'){const input=await body(req);return json(res,200,await content.deleteDraft(actor,deletion[1],deletion[2],input.revision));}
          const managed=/^\/api\/admin\/(articles|resources|activities)\/([a-f0-9-]+)(?:\/(publish|unpublish))?$/.exec(path);
          if(managed&&method==='POST'){
            const input=await body(req),kind=managed[1],result=managed[3]?await content.transitionManaged(actor,kind,managed[2],managed[3],input.revision):await content.saveManaged(actor,kind,input,undefined,managed[2]);
            return json(res,200,{[singular[kind]]:result});
          }
          const document=/^\/api\/admin\/articles\/([a-f0-9-]+)\/document$/.exec(path);
          if(document&&method==='GET')return await content.managedDocument(actor,document[1],req,res);
          if(path==='/api/admin/posts'&&method==='GET')return json(res,200,{posts:await content.managedPosts(actor)});
          const post=/^\/api\/admin\/posts\/([a-f0-9-]+)\/review$/.exec(path);
          if(post&&method==='POST')return json(res,200,await content.moderatePost(actor,post[1],await body(req),req.headers['idempotency-key']));
        }
        const surveyFile=/^\/api\/admin\/surveys\/([a-f0-9-]+)\/file$/.exec(path);
        if(forms&&surveyFile&&method==='GET')return await forms.downloadSurveyMaterial(actor,surveyFile[1],res);
        if(forms&&path==='/api/admin/surveys'&&method==='GET')return json(res,200,await forms.listSurveys(actor,url.searchParams.get('before')??undefined,url.searchParams.get('survey')??undefined));
        if(forms&&path==='/api/admin/enterprise-intake'&&method==='GET')return json(res,200,await forms.listEnterpriseIntakes(actor,url.searchParams.get('before')??undefined));
        const file=/^\/api\/admin\/enterprise-intake\/([a-f0-9-]+)\/file$/.exec(path);
        if(forms&&file&&method==='GET')return await forms.downloadEnterpriseUpload(actor,file[1],res);
        if(support){
          const list=/^\/api\/admin\/feedback(?:\/before\/(\d+))?$/.exec(path);
          if(list&&method==='GET')return json(res,200,await support.list(actor,list[1],true));
          const ticket=/^\/api\/admin\/feedback\/([a-f0-9-]+)(?:\/(accept|reply))?$/.exec(path);
          if(ticket&&!ticket[2]&&method==='GET')return json(res,200,{ticket:await support.detail(actor,ticket[1],true)});
          if(ticket&&ticket[2]&&method==='POST')return json(res,200,{ticket:await support.action(actor,ticket[1],ticket[2],await body(req),req.headers['idempotency-key'],true)});
          if(path==='/api/admin/ambassadors'&&method==='GET')return json(res,200,await support.listAmbassadors(actor,url.searchParams.get('before')??undefined));
          const application=/^\/api\/admin\/ambassadors\/([a-f0-9-]+)$/.exec(path);
          if(application&&method==='POST')return json(res,200,{application:await support.followAmbassador(actor,application[1],await body(req))});
        }
        return json(res,404,{error:'此后台接口尚未接入迁移服务'});
      }
      requireRule(!req.headers.cookie,'原生迁移服务不接受网页会话',400);
      if(batch2&&method==='GET'){
        if(path==='/api/content-topics')return json(res,200,{topics:await batch2.publicTopics()});
        if(path==='/api/enterprises')return json(res,200,{enterprises:await batch2.publicEnterprises()});
        const logo=/^\/api\/enterprises\/([a-f0-9-]+)\/logo$/.exec(path);
        if(logo){const image=await batch2.publicLogo(logo[1]);res.writeHead(200,{'Content-Type':image.contentType,'Content-Length':image.bytes.length,'Cache-Control':'no-store','X-Content-Type-Options':'nosniff'});return res.end(image.bytes);}
        const company=/^\/api\/enterprises\/([a-f0-9-]+)$/.exec(path);
        if(company)return json(res,200,{enterprise:await batch2.publicEnterprise(company[1])});
      }

      if(path==='/api/health'&&method==='GET'){
        const review=reviewAccess?await reviewAccess.readiness():{enabled:false};
        return json(res,200,{status:'ok',storage:'postgres',formsStorage:'postgres',mode,releaseReady:false,paymentReady:ready,paymentChannel,profileReady:!!profile,contentMaintenanceReady:!!batch2,nativeAuth:{localTrial:false,wechat:wechat?.configured===true,legacyBinding:mode==='migration',review:review.enabled===true},
          ...(review.enabled===true?{reviewAccess:{appId:review.appId,appVersion:review.appVersion,readOnly:true}}:{}),nativeTransfer:false,memberPostPublication:content?.publicationPolicy??null});
      }
      if(path==='/api/legal'&&method==='GET')return json(res,200,{release:core.legal});
      if(path==='/api/plans'&&method==='GET')return json(res,200,{plans:Object.values(plans),paymentReady:ready,paymentChannel});
      if(path==='/api/campaign'&&method==='GET')return json(res,200,{campaign:campaignState()});
      if(method==='GET'&&(/^\/api\/legal\//.test(path)||/^\/api\/enterprise-intake\/template\//.test(path)||/^\/api\/application-templates\//.test(path))&&sendPublicDocument(res,path,core.legal))return;
      if(path==='/api/native/auth/login'&&method==='POST'){
        limit(req,'review-login',15);const input=await body(req);
        requireRule(input.authMode==='review','本地试用登录尚未开放',503);
        requireRule(reviewAccess,'审核只读体验尚未配置',503);
        return json(res,200,await reviewAccess.login(input));
      }
      if(path==='/api/native/auth/wechat'&&method==='POST'){
        requireRule(req.headers.authorization===undefined,'登录时不能混用会话',400);
        const credentials=await body(req);
        requireRule(mode!=='fresh'||(!credentials.existingAccount&&!credentials.transferCode),'历史会员接续暂未开放，请直接使用微信登录',503);
        return json(res,200,await admitLogin(req,()=>core.login(credentials,{
          configured:wechat?.configured,appId:wechat?.appId,
          async exchangeCode(code){
            const identity=await wechat.exchangeCode(code);
            requireRule(identity?.appId===core.appId&&typeof identity.openId==='string'&&/^[A-Za-z0-9_-]{1,128}$/.test(identity.openId),'微信身份返回异常',503);
            limit.bind(req,'wechat',JSON.stringify([identity.appId,identity.openId]));
            limit(req,'login',25);
            return identity;
          }
        }),res));
      }
      const survey=/^\/api\/surveys\/(supply|demand|singapore|salon|general-demand|general-supply)$/.exec(path);
      if(survey&&method==='GET')return json(res,200,{survey:surveys[survey[1]]});
      const surveyUpload=/^\/api\/surveys\/general-supply\/upload(?:\/([a-f0-9-]{36})\/part\/(\d{1,3}))?$/.exec(path);
      if(surveyUpload&&method==='POST'){
        requireRule(mode!=='fresh'||core.legal?.status==='approved','资料收集协议尚未配置',503);
        if(surveyUpload[1]){limit(req,'survey-file-part',1000);return json(res,200,uploads.append(surveyUpload[1],Number(surveyUpload[2]),await body(req)));}
        limit(req,'survey-file-start',10);const input=await body(req);requireRule(typeof input.filename==='string'&&/\.pdf$/i.test(input.filename),'仅支持单份PDF');
        return json(res,200,uploads.start({...input,templateVersion:intakeVersion},req.headers['idempotency-key'],core.legal));
      }
      if(survey&&method==='POST'){
        requireRule(mode!=='fresh'||core.legal?.status==='approved','资料收集协议尚未配置',503);limit(req,'survey',25);
        let input=await body(req,512*1024);
        if(input.fileUploadId!==undefined||input.fileUploadToken!==undefined){requireRule(survey[1]==='general-supply','本问卷不接收附件');input=uploads.resolve({...input,templateVersion:intakeVersion});}
        // Retain bounded staging until TTL so a lost response can safely retry the same receipt.
        return json(res,201,{receipt:await forms.submitSurvey(survey[1],input,req.headers['idempotency-key'],core.legal)});
      }
      if(path==='/api/enterprise-intake'&&method==='GET')return json(res,200,{...intakeConfig(enterpriseIntake),uploadTransport:'chunked-v1'});
      const uploadPart=/^\/api\/enterprise-intake\/upload\/([a-f0-9-]{36})\/part\/(\d{1,3})$/.exec(path);
      if((path==='/api/enterprise-intake/upload'||uploadPart)&&method==='POST'){
        requireRule(mode!=='fresh'||core.legal?.status==='approved','资料收集协议尚未配置',503);
        requireRule(enterpriseIntake,'企业资料收集暂未开放',503);
        if(uploadPart){limit(req,'enterprise-upload-part',1000);return json(res,200,uploads.append(uploadPart[1],Number(uploadPart[2]),await body(req)));}
        limit(req,'enterprise-upload-start',10);return json(res,200,uploads.start(await body(req),req.headers['idempotency-key'],core.legal));
      }
      if(path==='/api/enterprise-intake'&&method==='POST'){
        requireRule(mode!=='fresh'||core.legal?.status==='approved','资料收集协议尚未配置',503);
        requireRule(enterpriseIntake,'企业资料收集暂未开放',503);limit(req,'enterprise',5);
        const input=await body(req,Math.ceil(maxFileBytes/3)*4+16384);
        const staged=input.fileUploadId!==undefined||input.fileUploadToken!==undefined;
        const receipt=await forms.saveEnterpriseIntake(staged?uploads.resolve(input):input,req.headers['idempotency-key'],core.legal);
        if(staged)uploads.release(input.fileUploadId,input.fileUploadToken);
        return json(res,201,{receipt});
      }
      if(path==='/api/service-people'&&method==='GET'){
        requireRule(new URL(req.url,'http://localhost').search==='','人员介绍接口不接受额外参数');
        return json(res,200,publicServicePeople(),{'Cache-Control':'no-store'});
      }
      if(content&&method==='GET'){
        if(path==='/api/activities')return json(res,200,{activities:await content.activities()});
        const activity=/^\/api\/activities\/([a-f0-9-]+)(\/poster)?$/.exec(path);
        if(activity){if(activity[2])return await content.poster(activity[1],res);return json(res,200,{activity:await content.activity(activity[1])});}
        if(path==='/api/resources')return json(res,200,await content.resources(user));
        const resource=/^\/api\/resources\/([a-f0-9-]+)$/.exec(path);
        if(resource)return json(res,200,{resource:await content.resource(user,resource[1])});
        if(path==='/api/articles'){
          const query=new URL(req.url,'http://localhost').searchParams;
          requireRule([...query.keys()].every(key=>key==='after')&&query.getAll('after').length<=1,'资料列表参数不正确');
          return json(res,200,await content.articles(user,query.get('after')??undefined));
        }
        const article=/^\/api\/articles\/([a-f0-9-]+)(?:\/(document|preview))?$/.exec(path);
        if(article){if(article[2])return await content.document(user,article[1],article[2]==='preview',req,res);return json(res,200,{article:await content.article(user,article[1])});}
      }
      if(path==='/api/me'&&method==='GET'&&!req.headers.authorization)return json(res,200,{user:null,membership:null,paymentReady:ready,paymentChannel,manualPaymentReady:false,defaultReferralConfigured:false});
      requireRule(user,'请先登录',401);
      if(path.startsWith('/api/application-materials')){
        requireRule(user.role==='member','请使用本人账号提交材料',403);
        requireRule(applicationMaterials,'材料收集暂不可用',503);
        const query=new URL(req.url,'http://localhost').searchParams;
        if(path==='/api/application-materials'&&method==='GET')return json(res,200,await applicationMaterials.listMine(user,query.get('kind'),query.get('before')??undefined));
        const target=/^\/api\/application-materials\/(partner|organization)(?:\/upload(?:\/([a-f0-9-]{36})\/part\/(\d{1,3}))?)?$/.exec(path);
        requireRule(target&&method==='POST','材料入口不存在',404);
        requireRule(query.size===0,'提交不接受额外参数');
        if(target[2]){limit(req,'application-part',1000);return json(res,200,applicationUploads.append(user,target[1],target[2],Number(target[3]),await body(req)));}
        if(path.endsWith('/upload')){limit(req,'application-start',10);return json(res,200,applicationUploads.start(user,target[1],await body(req),req.headers['idempotency-key'],core.legal));}
        limit(req,'application-submit',10);
        const input=await body(req),key=req.headers['idempotency-key'];
        const receipt=await applicationMaterials.save(user,target[1],applicationUploads.resolve(user,target[1],input,key),key,core.legal);
        applicationUploads.release(user,target[1],input.fileUploadId,input.fileUploadToken);
        return json(res,201,receipt);
      }
      if(path==='/api/exclusive-contacts'&&method==='GET'){
        requireRule(user.role==='member','请使用本人会员账号',403);
        requireRule(new URL(req.url,'http://localhost').search==='','联系人接口不接受额外参数');
        const session=await core.me(user);
        const membership=session.effectiveEntitlements===undefined?session.membership:session.effectiveEntitlements.byPlan.find(item=>item.planId==='star');
        return json(res,200,exclusiveContactsForMembership(membership),{'Vary':'Authorization'});
      }
      if(path==='/api/profile'){
        requireRule(user.role==='member','请使用本人会员账号',403);
        requireRule(new URL(req.url,'http://localhost').search==='','资料接口不接受身份或地址参数');
        requireRule(profile,'资料功能正在更新，请稍后再试',503);
        if(method==='GET')return json(res,200,await profile.get(user));
        if(method==='POST'){limit(req,'profile-save',10);return json(res,200,await profile.save(user,await body(req,90000)));}
      }
      if(path==='/api/reminders'&&method==='GET'){
        requireRule(user.role==='member','请使用当前本人会员身份',403);
        requireRule(new URL(req.url,'http://localhost').search==='','提醒不接受客户端身份或任务参数');
        return json(res,200,reminders?await reminders.status(user):reminderUnavailable);
      }
      if(path==='/api/reminders/choices'&&method==='POST'){
        requireRule(user.role==='member','请使用当前本人会员身份',403);
        requireRule(reminders,reminderUnavailable.reason,503);limit(req,'reminder-choice',15);
        return json(res,200,await reminders.recordChoice(user,await body(req),req.headers['idempotency-key']));
      }
      if(path==='/api/rewards'&&method==='GET')return json(res,200,rewards?await rewards.summary(user):rewardUnavailable);
      if(path==='/api/rewards/statements'&&method==='GET'){
        requireRule(user.role==='member','请使用本人会员账号',403);
        const query=new URL(req.url,'http://localhost').searchParams;
        requireRule(query.size===1&&query.has('month'),'仅接受一个账单月份');
        const month=query.get('month');requireRule(/^\d{4}-(0[1-9]|1[0-2])$/.test(month)&&month>='1970-01'&&month<=new Date(Date.now()+8*3600000).toISOString().slice(0,7),'请选择已经开始的有效账单月份');
        return json(res,200,rewards?await rewards.monthlyStatement(user,{month}):rewardUnavailable);
      }
      if(path==='/api/rewards/withdrawals/status'&&method==='GET'){
        if(!rewards)return json(res,200,rewardUnavailable);
        const query=new URL(req.url,'http://localhost').searchParams;requireRule(query.size===1&&query.has('key'),'查询参数不正确');
        return json(res,200,await rewards.withdrawalStatus(user,query.get('key')));
      }
      if(path==='/api/rewards/withdrawals'&&method==='POST'){
        requireRule(rewards,rewardUnavailable.reason,503);limit(req,'reward-withdrawal',10);
        return json(res,201,{withdrawal:rewardResult(await rewards.requestWithdrawal(user,await body(req),req.headers['idempotency-key']))});
      }
      if(support){
        if(path==='/api/feedback/summary'&&method==='GET')return json(res,200,await support.summary(user));
        const list=/^\/api\/feedback(?:\/before\/(\d+))?$/.exec(path);
        if(list&&method==='GET')return json(res,200,await support.list(user,list[1]));
        if(path==='/api/feedback'&&method==='POST'){limit(req,'feedback',15);return json(res,201,{ticket:await support.create(user,await body(req),req.headers['idempotency-key'])});}
        const ticket=/^\/api\/feedback\/([a-f0-9-]+)(?:\/(followup|confirm|read))?$/.exec(path);
        if(ticket&&!ticket[2]&&method==='GET')return json(res,200,{ticket:await support.detail(user,ticket[1])});
        if(ticket&&ticket[2]&&method==='POST'){
          limit(req,'feedback-action',30);const input=await body(req);
          return json(res,200,ticket[2]==='read'?await support.read(user,ticket[1],input):{ticket:await support.action(user,ticket[1],ticket[2],input,req.headers['idempotency-key'])});
        }
        if(path==='/api/ambassador'&&method==='GET')return json(res,200,await support.ambassador(user));
        if(path==='/api/ambassador'&&method==='POST'){limit(req,'ambassador',10);return json(res,201,{application:await support.applyAmbassador(user,await body(req),req.headers['idempotency-key'])});}
      }
      if(path==='/api/referral'&&method==='POST')return json(res,200,{user:await core.captureReferral(user,await body(req))});
      if(content&&path==='/api/content'&&method==='GET')return json(res,200,{posts:await content.posts(user)});
      if(content&&path==='/api/posts'&&method==='GET')return json(res,200,{posts:await content.posts(user,true)});
      if(content&&path==='/api/posts'&&method==='POST'){limit(req,'post',15);return json(res,201,{post:await content.publish(user,await body(req),req.headers['idempotency-key'])});}
      const postRevision=/^\/api\/posts\/([a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12})\/revisions$/.exec(path);
      if(content&&postRevision&&method==='POST'){limit(req,'post-revision',15);return json(res,200,{post:await content.editPost(user,postRevision[1],await body(req),req.headers['idempotency-key'])});}
      if(path==='/api/invite-code'&&method==='GET'){
        requireRule(new URL(req.url,'https://'+req.headers.host).search==='','邀请码不接受客户端来源或环境参数');
        requireRule(inviteCode?.configured,'邀请扫码服务正在配置',503);limit(req,'invite-code',10);
        return json(res,200,await inviteCode.generate(user));
      }
      if(path==='/api/me'&&method==='GET')return json(res,200,{...await core.me(user),paymentReady:ready,paymentChannel,manualPaymentReady:false});
      if(path==='/api/native/auth/logout'&&method==='POST'){await body(req);await core.logout(token);return json(res,200,{ok:true});}
      if(path==='/api/orders'&&method==='GET')return json(res,200,{orders:await core.listOrders(user)});
      if(path==='/api/orders'&&method==='POST')return json(res,201,{order:await core.createOrder(user,await body(req),req.headers['idempotency-key'])});
      const order=/^\/api\/orders\/(HJ[A-F0-9]{32})(?:\/(payment|payment-status|legal-consent|cancel))?$/.exec(path);
      if(order){
        const id=order[1],action=order[2];
        if(!action&&method==='GET')return json(res,200,{order:await core.order(user,id)});
        if(action==='legal-consent'&&method==='POST')return json(res,200,await core.acceptPayment(user,id,await body(req)));
        if(action==='payment-status'&&method==='GET'){limit(req,'query',30);return json(res,200,{order:await sync(user,id),enabled:ready,paymentChannel,legal:core.legal,legalAccepted:await core.paymentAccepted(user,id)});}
        if(action==='payment'&&method==='POST'){
          requireRule(ready,'微信支付正在配置，暂未开放',503);limit(req,'prepay',10);const input=await body(req);
          if(paymentChannel==='virtual')return json(res,200,await virtualPayment.prepare(user,id,input));
          const {order,openId}=await core.preparePayment(user,id);const params=await payment.prepay(order,openId);
          if(!await core.prepayStillOpen(user,id)){await payment.close(id).catch(()=>{});requireRule(false,'订单已取消或正在关闭，请刷新订单',409);}
          return json(res,200,{paymentChannel:'ordinary',payment:params});
        }
        if(action==='cancel'&&method==='POST'){await body(req);return json(res,200,{order:paymentChannel==='virtual'&&ready?await virtualPayment.cancel(user,id):await core.cancelOrder(user,id,payment)});}
      }
      return json(res,404,{error:'此接口尚未接入迁移服务'});
    }catch(error){
      if(!error.status||error.status>=500){
        const path=(req.url||'').split('?')[0];
        const match=/^\/api\/orders\/HJ[A-F0-9]{32}(?:\/(payment-status|cancel))?$/.exec(path);
        const operation=path==='/api/orders'&&req.method==='GET'?'list':match?(match[1]||'read'):null;
        if(operation){
          const code=String(error.code||error.providerCode||'UNEXPECTED_ERROR');
          const allowed=['response','orderId','environment','orderAmount','status','orderType','paidAmount','remainingAmount','paidTotal','paidTime','transaction'];
          const mismatch=Array.isArray(error.mismatchFields)?error.mismatchFields.filter(field=>allowed.includes(field)):[];
          const queryState=mismatch.length&&error.queryState?{status:Number.isSafeInteger(error.queryState.status)&&error.queryState.status>=0&&error.queryState.status<=10?error.queryState.status:null,
            environment:Number.isSafeInteger(error.queryState.environment)&&error.queryState.environment>=0&&error.queryState.environment<=2?error.queryState.environment:null}:null;
          console.error(JSON.stringify({event:'order.operation.failed',operation,code:/^[A-Z0-9_]{1,60}$/.test(code)?code:'UNEXPECTED_ERROR',...(mismatch.length?{mismatch,queryState}:{} )}));
        }
      }
      if(!res.headersSent)json(res,error.status||500,{error:error.status?error.message:'服务暂时不可用，请稍后重试'});else res.destroy();
    }
  });
  server.requestTimeout=30000;server.headersTimeout=10000;
  let rewardMaintenanceBusy=false;
  const settleRewards=async()=>{
    if(rewardMaintenanceBusy)return;rewardMaintenanceBusy=true;
    try{await rewards.confirmMatured();}catch{/* No raw financial/configuration payloads in logs. */}
    finally{rewardMaintenanceBusy=false;}
  };
  const rewardMaintenance=rewards?.enabled===true?setInterval(()=>void settleRewards(),60000):null;
  rewardMaintenance?.unref();
  if(rewardMaintenance)void settleRewards();
  server.stopMaintenance=()=>{uploads.close();reportUploads.close();applicationUploads.close();if(rewardMaintenance)clearInterval(rewardMaintenance);};
  server.on('close',server.stopMaintenance);
  if(ready&&paymentChannel==='virtual'&&autoRecover){virtualPayment.startRecovery();server.on('close',()=>virtualPayment.stopRecovery());}
  return server;
}
