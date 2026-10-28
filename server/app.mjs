import {createNativePayments} from './native-payments.mjs';
import {issueNativeTransfer} from './native-transfer.mjs';
import { installLegalConsents, recordLegalConsent } from './legal-consents.mjs';
import {sendPublicDocument} from './public-documents.mjs';
import {installEnterpriseIntake,intakeConfig,saveEnterpriseIntake,listEnterpriseIntakes,downloadEnterpriseUpload,maxFileBytes} from './enterprise-intake.mjs';
import {createWebWechat,callbackPath,clearOAuthCookie} from './web-wechat.mjs';
import { publishMemberPost, moderateMemberPost } from './posts.mjs';
import { installManualPayments, manualPayment, submitManualPayment, reviewManualPayment } from './manual-payments.mjs';
import { installAmbassadors, ambassadorStatus, applyAmbassador, listAmbassadors, followAmbassador } from './ambassadors.mjs';
import { campaignState } from './campaign.mjs';
import { surveys, installSurveys, submitSurvey, listSurveys } from './surveys.mjs';
import {sendArticleDocument} from './article-documents.mjs';
import {listActivities,readActivity,saveActivity,transitionActivity} from './activities.mjs';
import { createWebPolicy } from './web-policy.mjs';
import { listManagedResources, createResource, updateResource, transitionResource, listReadableResources, readResource } from './resources.mjs';
import { createServer } from 'node:http';
import {readFileSync} from 'node:fs';
import { randomBytes, randomUUID } from 'node:crypto';
import { audit, transaction } from './db.mjs';
import { BusinessError, requireRule, digest, nowISO, hashPassword, checkPassword, validateCredentials,
  insertUser, publicUser, captureReferral, plans, membership, orderView, ownedOrder, createOrder,
  cancelOrder, reviewOrder, textField, validateKey } from './domain.mjs';
import { authError, hasSessionCookie, nativeIdentity, requireUnauthenticatedNativeLogin, trialLogin, wechatLogin } from './native-auth.mjs';
import { validateLanNetwork, isAllowedLanClient, isLocalLanClient } from './lan-network.mjs';
import { createRemotePolicy } from './remote-policy.mjs';
import { listManagedArticles, createArticle, updateArticle, transitionArticle, listReadableArticles, readArticle, requireFullArticle, requireArticlePreview } from './articles.mjs';
import { queryAudit } from './audit-query.mjs';
import { createFeedback, listFeedback, feedbackDetail, handleFeedback, memberFeedbackAction, markFeedbackRead, feedbackSummary } from './feedback.mjs';

const sessionDuration = 12 * 60 * 60 * 1000;
function json(res, status, value, extra = {}) {
  res.writeHead(status, { 'Content-Type':'application/json; charset=utf-8', 'Cache-Control':'no-store',
    'X-Content-Type-Options':'nosniff', ...extra });
  res.end(JSON.stringify(value));
}
async function readBody(req, maxBytes = 16384) {
  requireRule(req.headers['content-type']?.split(';')[0] === 'application/json', '请求必须使用 JSON', 415);
  const chunks = [];
  let bytes = 0;
  for await (const chunk of req) {
    chunks.push(chunk);
    bytes += chunk.length;
    requireRule(bytes <= maxBytes, '提交内容过长', 413);
  }
  try {
    const body = Buffer.concat(chunks).toString('utf8');
    const parsed = JSON.parse(body || '{}');
    requireRule(parsed && typeof parsed === 'object' && !Array.isArray(parsed), '请求格式不正确');
    return parsed;
  } catch { throw new BusinessError('请求格式不正确'); }
}
function postView(row) {
  return { id:row.id, userId:row.user_id, title:row.title, body:row.body, status:row.status,
    reason:row.reason, createdAt:row.created_at, reviewedAt:row.reviewed_at };
}

export function createApplication(db, options = {}) {
  installEnterpriseIntake(db);
  installSurveys(db);
  installAmbassadors(db);
  installManualPayments(db);
  if(options.legalRelease) installLegalConsents(db);
  const legal=options.legalRelease ?? null;
  const payments=createNativePayments(db,options.wechatPay);
  const paymentReady=!options.webTrial && options.wechatPay?.configured===true && options.wechatPay.appId===options.wechat?.appId;
  if(options.wechatPay?.configured && !paymentReady)throw new Error('微信支付必须与原生小程序身份配置一致');
  const forms=options.formsRepository ?? {
    storage:'sqlite',
    saveEnterpriseIntake:(body,key,release)=>saveEnterpriseIntake(db,body,key,release),
    listEnterpriseIntakes:(user,before)=>listEnterpriseIntakes(db,user,before),
    downloadEnterpriseUpload:(user,id,res)=>downloadEnterpriseUpload(db,user,id,res),
    submitSurvey:(side,body,key,release)=>submitSurvey(db,side,body,key,release ? id=>audit(db,null,'survey.legal_accepted',id,{releaseId:release.id,documents:release.documents,accepted:true,hongKongAccepted:body.legalConsent?.hongKongAccepted===true}) : undefined),
    listSurveys:(user,before,side)=>listSurveys(db,user,before,side)
  };
  function requireLegal(body){requireRule(body?.accepted===true && body.releaseId===legal.id && (!legal.requireHongKongConsent || body.hongKongAccepted===true),'请阅读当前协议并确认适用的存储安排',409);}
  function paymentAccepted(userId,orderId){return !legal || !!db.prepare("SELECT 1 FROM legal_consents WHERE user_id=? AND scope='payment' AND target_id=? AND release_id=?").get(userId,orderId,legal.id);}
  const web = options.webTrial ? createWebPolicy(options.webTrial) : null;
  const webWechat=web?createWebWechat(db,options.webWechat,{origin:options.webTrial.origin,legal,fetchImpl:options.webWechatFetch}):null;
  if(web && (options.remoteTrial || options.lanNetwork || options.allowNativeTrialAuth || options.wechat)) throw new Error('网页体验不可混用其他身份环境');
  const remote = options.remoteTrial ? createRemotePolicy(options.remoteTrial) : null;
  if (remote && options.lanNetwork) throw new Error('远程测试不能混用 LAN 网络配置');
  const cookieName = web ? 'club_web_session' : remote ? 'club_remote_session' : options.cookieName ?? 'club_session';
  if (!['club_session', 'club_lan_session', 'club_remote_session','club_web_session'].includes(cookieName)) throw new Error('不支持的会话 Cookie 名称');
  const cookiePath = web?.cookiePath ?? '/api';
  const cookieSecurity = (web || remote) ? '; Secure' : '';
  const sessionCookiePattern = new RegExp(`(?:^|;\\s*)${cookieName}=([a-f0-9]{64})(?:;|$)`);
  const lanNetwork = options.lanNetwork ? validateLanNetwork(options.lanNetwork.address, options.lanNetwork.prefixLength) : null;
  const mode = web ? 'web-trial' : remote ? 'remote-trial' : options.mode === 'lan-trial' && lanNetwork ? 'lan-trial' : 'local-trial';
  const allowNativeTrialAuth = !remote && options.allowNativeTrialAuth === true && process.env.NODE_ENV !== 'production';
  if (remote && options.wechat?.configured && options.wechat.appId !== remote.appId) throw new Error('微信适配器与远程 AppID 不一致');
  const nativeAuth = { localTrial: allowNativeTrialAuth, wechat: options.wechat?.configured === true && (!remote || remote.invited) };
  const allowedOrigins = new Set(web?.origins ?? remote?.origins ?? options.origins ?? ['http://127.0.0.1:5186','http://localhost:5186']);
  const allowedHosts = new Set(web?.hosts ?? remote?.hosts ?? options.hosts ?? ['127.0.0.1:5186','localhost:5186','127.0.0.1:5187']);
  const attempts = new Map();
  let enterpriseUploadsInFlight=0;
  // Matching password work for unknown users avoids a cheap username timing probe.
  const dummyHash = hashPassword(randomBytes(32).toString('hex'));
  function currentUser(req) {
    const token = sessionCookiePattern.exec(req.headers.cookie ?? '')?.[1];
    if (!token) return null;
    return db.prepare(`SELECT users.* FROM sessions JOIN users ON users.id=sessions.user_id
      WHERE token_hash=? AND expires_at>?`).get(digest(token), nowISO()) ?? null;
  }
  function session(userId) {
    db.prepare('DELETE FROM sessions WHERE expires_at<=?').run(nowISO());
    const token = randomBytes(32).toString('hex');
    db.prepare('INSERT INTO sessions VALUES (?,?,?)').run(digest(token), userId, new Date(Date.now()+sessionDuration).toISOString());
    return { 'Set-Cookie':`${cookieName}=${token}; HttpOnly; SameSite=Strict; Path=${cookiePath}; Max-Age=${sessionDuration/1000}${cookieSecurity}` };
  }
  function limit(req, scope = 'auth', maximum = 25) {
    const time = Date.now();
    for (const [key,value] of attempts) if (value.until <= time) attempts.delete(key);
    const key = scope + ':' + (req.trialClientIp ?? req.socket.remoteAddress);
    requireRule(attempts.has(key) || attempts.size < 10000, '服务繁忙，请稍后重试', 429);
    const item = attempts.get(key) ?? { count:0, until:time+60000 };
    item.count++;
    attempts.set(key, item);
    requireRule(item.count <= maximum, '操作过于频繁，请一分钟后重试', 429);
  }
  return createServer(async (req,res) => {
    try {
      if (lanNetwork) requireRule(isAllowedLanClient(req.socket.remoteAddress, lanNetwork), '仅允许同一局域网的测试设备访问', 403);
      requireRule(allowedHosts.has(req.headers.host), '访问地址不受支持', 403);
      const url = new URL(req.url, 'http://127.0.0.1');
      const path = url.pathname;
      const method = req.method;
      if(path==='/api/payments/wechat/notify'&&method==='POST'&&paymentReady){
        requireRule(!req.headers.authorization&&!req.headers.cookie,'支付通知不能携带用户会话',400);
        const chunks=[];let size=0;
        for await(const chunk of req){size+=chunk.length;requireRule(size<=65536,'支付通知过长',413);chunks.push(chunk);}
        await payments.notify(req.headers,Buffer.concat(chunks).toString('utf8'));
        res.writeHead(204);res.end();return;
      }
      const webRequest=web?.checkRequest(req,path);
      if(webRequest)req.trialClientIp=webRequest.clientIp;
      const remoteRequest = remote?.checkRequest(req, path);
      if (remoteRequest) {
        req.trialClientIp = remoteRequest.clientIp;
        if (hasSessionCookie(req) && !remoteRequest.isAdmin) throw new BusinessError('网页登录凭据不能用于会员接口', 403);
      }
      if (lanNetwork && (path.startsWith('/api/auth/') || path.startsWith('/api/admin/')))
        requireRule(isLocalLanClient(req.socket.remoteAddress, lanNetwork.address), '网页登录及管理后台仅允许本机访问', 403);
      if (req.headers.origin) requireRule(allowedOrigins.has(req.headers.origin), '请求来源不受支持', 403);
      requireRule((webWechat&&path===callbackPath&&method==='GET')||!req.headers['sec-fetch-site'] || req.headers['sec-fetch-site'] !== 'cross-site', '不允许跨站请求', 403);
      if (method !== 'GET') {
        requireRule(req.headers['x-club-request'] === '1', '缺少请求校验标记', 403);
      }
      const native = nativeIdentity(db, req, allowNativeTrialAuth);
      if(path==='/api/auth/native-transfer/status'&&method==='GET')return json(res,200,{enabled:!!options.nativeTransferAppId});
      if(path==='/api/auth/native-transfer'&&method==='POST'){
        requireRule(!native,'请从原网页登录账号获取接续码',400);
        const user=currentUser(req);
        requireRule(user?.role==='member','请先登录原会员账号',401);
        requireRule(req.headers['x-club-actor']===user.id,'登录账号已变化，请刷新后重试',409);
        limit(req,'native-transfer',5);const body=await readBody(req);
        requireRule(body.confirm===true,'请确认将原账号关联到本人小程序微信');
        return json(res,200,issueNativeTransfer(db,user,options.nativeTransferAppId));
      }
      if(path==='/api/auth/wechat/status'&&method==='GET')return json(res,200,{enabled:!!webWechat,linked:!!(webWechat&&currentUser(req)&&db.prepare('SELECT 1 FROM wechat_identities WHERE app_id=? AND user_id=?').get(options.webWechat.appId,currentUser(req).id))});
      if(path==='/api/auth/wechat/start'&&method==='POST'){
        requireRule(webWechat,'微信登录暂未开放',503);limit(req,'web-wechat');
        const user=currentUser(req);
        if(user)requireRule(req.headers['x-club-actor']===user.id,'登录账号已变化，请刷新后重试',409);
        const result=webWechat.start(await readBody(req),user);
        return json(res,200,{url:result.url},{'Set-Cookie':result.cookie});
      }
      if(path===callbackPath&&method==='GET'&&webWechat){
        try{
          limit(req,'web-wechat-callback');
          const result=await webWechat.finish(url.searchParams,req.headers.cookie);
          res.writeHead(303,{'Location':'/hejun-club/#'+result.route,'Set-Cookie':[session(result.userId)['Set-Cookie'],clearOAuthCookie],'Cache-Control':'no-store','Referrer-Policy':'no-referrer'});res.end();
        }catch{
          res.writeHead(303,{'Location':'/hejun-club/#/account?wechat=failed','Set-Cookie':clearOAuthCookie,'Cache-Control':'no-store','Referrer-Policy':'no-referrer'});res.end();
        }
        return;
      }
      if (remote && native) {
        const identity = db.prepare('SELECT app_id AS appId,open_id AS openId FROM wechat_identities WHERE user_id=? AND app_id=?').get(native.user.id, remote.appId);
        if (!nativeAuth.wechat || !remote.allowsIdentity(identity))
          throw authError('测试访问资格已失效', 403, 'TRIAL_NOT_INVITED');
      }
      if (path === '/api/campaign' && method === 'GET') return json(res,200,{campaign:campaignState()});
      if(method==='GET' && sendPublicDocument(res,path,legal,db))return;
      if(path==='/api/enterprise-intake'&&method==='GET')return json(res,200,intakeConfig(options.enterpriseIntake===true));
      if(path==='/api/enterprise-intake'&&method==='POST'){
        requireRule(options.enterpriseIntake===true,'企业资料收集暂未开放，请稍后再试',503);limit(req,'enterprise-upload',5);
        requireRule(enterpriseUploadsInFlight<2,'同时上传人数较多，请稍后重试',429);enterpriseUploadsInFlight++;
        try{
          const body=await readBody(req,Math.ceil(maxFileBytes/3)*4+16384);
          return json(res,201,{receipt:await forms.saveEnterpriseIntake(body,req.headers['idempotency-key'],legal)});
        }finally{enterpriseUploadsInFlight--;}
      }
      const surveyRoute = /^\/api\/surveys\/(supply|demand|singapore|salon)$/.exec(path);
      if (surveyRoute && method === 'GET') return json(res, 200, { survey: surveys[surveyRoute[1]] });
      if (surveyRoute && method === 'POST') {
        limit(req, 'survey');
        const body=await readBody(req,512*1024);if(legal)requireLegal(body.legalConsent);
        return json(res, 201, { receipt: await forms.submitSurvey(surveyRoute[1],body,req.headers['idempotency-key'],legal) });
      }
      if (path === '/api/legal' && method === 'GET') return json(res,200,{release:legal});
      if (path === '/api/health' && method === 'GET') return json(res,200,{ status:'ok', storage:'sqlite', formsStorage:forms.storage, mode, paymentReady:paymentReady, nativeAuth,nativeTransfer:options.nativeTransferAppId===options.wechat?.appId && !!options.nativeTransferAppId,
        nativeManualPayment:options.manualPayment===true && options.nativeManualPayment===true });
      if (path === '/api/plans' && method === 'GET') return json(res,200,{ plans:Object.values(plans), paymentReady:paymentReady });
      if (['/api/native/auth/login','/api/native/auth/register','/api/native/auth/wechat'].includes(path) && method === 'POST') {
        requireUnauthenticatedNativeLogin(req);
        if (!path.endsWith('/wechat') && !allowNativeTrialAuth) throw new BusinessError('接口不存在', 404);
        if (remote && !nativeAuth.wechat) throw authError('微信测试登录尚未开放', 503, 'WECHAT_NOT_CONFIGURED');
        limit(req);
        const body = await readBody(req);
        const registered = path.endsWith('/register');
        if(legal)requireLegal(body.legalConsent);
        const onAuthenticated=legal ? userId=>recordLegalConsent(db,{userId,scope:'registration',targetId:userId,body:body.legalConsent,release:legal,withinTransaction:true}) : undefined;
        const result = path.endsWith('/wechat') ? await wechatLogin(db, body, options.wechat, remote?.allowsIdentity,onAuthenticated,dummyHash,options.nativeTransferAppId)
          : await trialLogin(db, body, registered, dummyHash,onAuthenticated);
        return json(res, registered ? 201 : 200, result);
      }
      if (path === '/api/native/auth/logout' && method === 'POST') {
        if (!native) throw authError('请先登录小程序账号', 401, 'AUTH_REQUIRED');
        await readBody(req);
        db.prepare('DELETE FROM native_sessions WHERE token_hash=?').run(native.tokenHash);
        return json(res, 200, { ok: true });
      }
      if (['/api/auth/register','/api/auth/login'].includes(path) && method === 'POST') {
        if (remote && path.endsWith('/register')) throw new BusinessError('接口不存在', 404);
        if (native) throw authError('请勿混用网页登录与小程序登录凭据', 400, 'AUTH_AMBIGUOUS');
        limit(req);
        const body = await readBody(req);
        const username = validateCredentials(body);
        if (path.endsWith('register')) {
          requireRule(body.consent === true, legal ? '请阅读并同意协议' : '请同意内测资料保存说明');
          if(legal) requireLegal(body.legalConsent);
          const passwordHash = await hashPassword(body.password);
          const user = transaction(db, () => {
            requireRule(!db.prepare('SELECT 1 FROM users WHERE username=?').get(username), '账号已被使用', 409);
            const created = insertUser(db, username, passwordHash);
            if(legal){recordLegalConsent(db,{userId:created.id,scope:'registration',targetId:created.id,body:body.legalConsent,release:legal,withinTransaction:true});db.prepare('UPDATE users SET consent_version=? WHERE id=?').run(legal.id,created.id);}
            captureReferral(db, created.id, body.referral ?? '');
            audit(db,created.id,'account.registered',created.id);
            return db.prepare('SELECT * FROM users WHERE id=?').get(created.id);
          });
          return json(res,201,{ user:publicUser(db,user) },session(user.id));
        }
        const user = db.prepare('SELECT * FROM users WHERE username=?').get(username);
        const valid = await checkPassword(body.password, user?.password_hash ?? await dummyHash);
        requireRule(user && valid && (!remote || user.role === 'admin'), '账号或密码不正确', 401);
        if (user.role === 'member' && body.referral && !db.prepare("SELECT 1 FROM orders WHERE user_id=? AND status IN ('review','pending')").get(user.id)) {
          transaction(db,()=>captureReferral(db,user.id,body.referral));
        }
        return json(res,200,{ user:publicUser(db,db.prepare('SELECT * FROM users WHERE id=?').get(user.id)) },session(user.id));
      }
      const user = native?.user ?? currentUser(req);
      if (remote && user && !native && user.role !== 'admin') throw new BusinessError('请使用微信测试登录', 403);
      if (path === '/api/resources' && method === 'GET') return json(res, 200, listReadableResources(db, user));
      const resourceMatch = /^\/api\/resources\/([a-f0-9-]+)$/.exec(path);
      if (resourceMatch && method === 'GET') return json(res, 200, { resource: readResource(db, user, resourceMatch[1]) });
      const articleFile = /^\/api\/(admin\/)?articles\/([a-f0-9-]+)\/(document|preview)$/.exec(path);
      if(articleFile && method==='GET'){
        if(articleFile[1]){requireRule(user?.role==='admin','需要管理员权限',403);requireRule(db.prepare('SELECT id FROM articles WHERE id=?').get(articleFile[2]),'内容不存在',404);}
        else if(articleFile[3]==='preview')requireArticlePreview(db,articleFile[2]);
        else requireFullArticle(db,user,articleFile[2]);
        return await sendArticleDocument(db,articleFile[2],options.documentsDirectory,req,res,articleFile[3]==='preview');
      }
      if (path === '/api/articles' && method === 'GET') return json(res, 200, listReadableArticles(db, user));
      if(path==='/api/activities'&&method==='GET')return json(res,200,{activities:listActivities(db,user)});
      const activityRead=/^\/api\/activities\/([a-f0-9-]+)$/.exec(path);
      if(activityRead&&method==='GET')return json(res,200,{activity:readActivity(db,activityRead[1])});
      const articleMatch = /^\/api\/articles\/([a-f0-9-]+)$/.exec(path);
      if (articleMatch && method === 'GET') return json(res, 200, { article: readArticle(db, user, articleMatch[1]) });
      if (path === '/api/me' && method === 'GET') return json(res,200,{ user:user ? publicUser(db,user) : null,
        membership:user ? membership(db,user.id) : null, paymentReady:paymentReady, manualPaymentReady:options.manualPayment===true,
        defaultReferralConfigured:!!db.prepare("SELECT 1 FROM settings WHERE key='default_referral_code'").get() });
      requireRule(user, '请先登录', 401);
      if (path === '/api/content' && method === 'GET') return json(res,200,{ posts:db.prepare("SELECT * FROM posts WHERE status='published' ORDER BY created_at DESC LIMIT 100").all().map(postView) });
      if(web && method!=='GET') requireRule(req.headers['x-club-actor']===user.id,'登录账号已变化，请刷新后重新操作',409);
      if (path.startsWith('/api/admin/')) requireRule(user.role === 'admin', '需要管理员权限', 403);
      if(path==='/api/admin/enterprise-intake'&&method==='GET')return json(res,200,await forms.listEnterpriseIntakes(user,url.searchParams.get('before')??undefined));
      const enterpriseFile=/^\/api\/admin\/enterprise-intake\/([a-f0-9-]+)\/file$/.exec(path);
      if(enterpriseFile&&method==='GET')return await forms.downloadEnterpriseUpload(user,enterpriseFile[1],res);
      if (path === '/api/admin/surveys' && method === 'GET') return json(res, 200, await forms.listSurveys(user,url.searchParams.get('before')??undefined,url.searchParams.get('survey')??undefined));
      if (path === '/api/ambassador' && method === 'GET') return json(res,200,ambassadorStatus(db,user));
      if (path === '/api/ambassador' && method === 'POST') return json(res,201,{application:applyAmbassador(db,user,await readBody(req),req.headers['idempotency-key'])});
      if (path === '/api/admin/ambassadors' && method === 'GET') return json(res,200,listAmbassadors(db,user,url.searchParams.get('before') ?? undefined));
      const ambassadorMatch = /^\/api\/admin\/ambassadors\/([a-f0-9-]+)$/.exec(path);
      if (ambassadorMatch && method === 'POST') return json(res,200,{application:followAmbassador(db,user,ambassadorMatch[1],await readBody(req))});
      if (path === '/api/feedback/summary' && method === 'GET') return json(res, 200, feedbackSummary(db,user));
      const memberFeedbackRoute = /^\/api\/feedback\/([a-f0-9-]+)\/(followup|confirm|read)$/.exec(path);
      if (memberFeedbackRoute && method === 'POST') {
        const input=await readBody(req);
        return json(res,200,memberFeedbackRoute[2]==='read' ? markFeedbackRead(db,user,memberFeedbackRoute[1],input)
          : {ticket:memberFeedbackAction(db,user,memberFeedbackRoute[1],memberFeedbackRoute[2],input,req.headers['idempotency-key'])});
      }
      const feedbackList = /^\/api\/(admin\/)?feedback(?:\/before\/(\d+))?$/.exec(path);
      if (feedbackList && method === 'GET') return json(res, 200, listFeedback(db, user, !!feedbackList[1], feedbackList[2]));
      if (path === '/api/feedback' && method === 'POST') return json(res, 201, { ticket: createFeedback(db, user, await readBody(req), req.headers['idempotency-key']) });
      const feedbackRoute = /^\/api\/(admin\/)?feedback\/([a-f0-9-]+)(?:\/(accept|reply))?$/.exec(path);
      if (feedbackRoute && !feedbackRoute[3] && method === 'GET') return json(res, 200, { ticket: feedbackDetail(db, user, feedbackRoute[2], !!feedbackRoute[1]) });
      if (feedbackRoute?.[1] && feedbackRoute[3] && method === 'POST') return json(res, 200, { ticket: handleFeedback(db, user, feedbackRoute[2], feedbackRoute[3], await readBody(req), req.headers['idempotency-key']) });
      if (path === '/api/admin/audit' && method === 'GET') return json(res, 200, queryAudit(db, user, url.searchParams));
      if (path === '/api/admin/resources' && method === 'GET') return json(res, 200, { resources: listManagedResources(db, user) });
      if (path === '/api/admin/resources' && method === 'POST') return json(res, 201, { resource: createResource(db, user, await readBody(req), req.headers['idempotency-key']) });
      const managedResource = /^\/api\/admin\/resources\/([a-f0-9-]+)(?:\/(publish|unpublish))?$/.exec(path);
      if (managedResource && method === 'POST') {
        const body = await readBody(req);
        const resource = managedResource[2] ? transitionResource(db, user, managedResource[1], managedResource[2], body.revision)
          : updateResource(db, user, managedResource[1], body);
        return json(res, 200, { resource });
      }
      if (path === '/api/admin/articles' && method === 'GET') return json(res, 200, { articles: listManagedArticles(db, user) });
      if(path==='/api/admin/activities'&&method==='GET')return json(res,200,{activities:listActivities(db,user,true)});
      if(path==='/api/admin/activities'&&method==='POST')return json(res,201,{activity:saveActivity(db,user,await readBody(req),req.headers['idempotency-key'])});
      const activityWrite=/^\/api\/admin\/activities\/([a-f0-9-]+)(?:\/(publish|unpublish))?$/.exec(path);
      if(activityWrite&&method==='POST'){const body=await readBody(req);return json(res,200,{activity:activityWrite[2]?transitionActivity(db,user,activityWrite[1],activityWrite[2],body.revision):saveActivity(db,user,body,undefined,activityWrite[1])});}
      if (path === '/api/admin/articles' && method === 'POST') return json(res, 201, { article: createArticle(db, user, await readBody(req), req.headers['idempotency-key']) });
      const managedArticle = /^\/api\/admin\/articles\/([a-f0-9-]+)(?:\/(publish|unpublish))?$/.exec(path);
      if (managedArticle && method === 'POST') {
        const body = await readBody(req);
        const article = managedArticle[2] ? transitionArticle(db, user, managedArticle[1], managedArticle[2], body.revision)
          : updateArticle(db, user, managedArticle[1], body);
        return json(res, 200, { article });
      }
      if (path === '/api/auth/logout' && method === 'POST') {
        if (native) throw authError('请使用小程序退出登录入口', 400, 'AUTH_AMBIGUOUS');
        const token = sessionCookiePattern.exec(req.headers.cookie ?? '')?.[1];
        if (token) db.prepare('DELETE FROM sessions WHERE token_hash=?').run(digest(token));
        return json(res,200,{ ok:true },{ 'Set-Cookie':`${cookieName}=; HttpOnly; SameSite=Strict; Path=${cookiePath}; Max-Age=0${cookieSecurity}` });
      }
      if (path === '/api/referral' && method === 'POST') {
        const body = await readBody(req);
        const result = transaction(db, () => {
          requireRule(!db.prepare("SELECT 1 FROM orders WHERE user_id=? AND status IN ('review','pending')").get(user.id), '订单已保存推荐来源，请先处理现有订单', 409);
          return captureReferral(db,user.id,body.code ?? '');
        });
        return json(res,200,{ user:result });
      }
      if (path === '/api/orders' && method === 'GET') return json(res,200,{ orders:db.prepare('SELECT * FROM orders WHERE user_id=? ORDER BY created_at DESC').all(user.id).map(row=>orderView(db,row)) });
      if (path === '/api/orders' && method === 'POST') {
        requireRule(user.role === 'member','管理员账号不能申请会员',403);
        const body=await readBody(req);if(legal) requireLegal(body.legalConsent);
        return json(res,201,{ order:createOrder(db,user.id,body,req.headers['idempotency-key'],legal ? id=>recordLegalConsent(db,{userId:user.id,scope:'order',targetId:id,body:body.legalConsent,release:legal,withinTransaction:true}) : undefined) });
      }
      const orderMatch = /^\/api\/orders\/([A-Z0-9]+)(?:\/(cancel|payment))?$/.exec(path);
      const paymentLegal=/^\/api\/orders\/([A-Z0-9]+)\/legal-consent$/.exec(path);
      if(paymentLegal&&method==='POST'){
        requireRule(legal,'当前无需此操作',409);const order=ownedOrder(db,user.id,paymentLegal[1]);
        requireRule(user.role==='member'&&order.status==='pending'&&['basic','star'].includes(order.plan_id),'当前订单不能进入付款',409);
        const body=await readBody(req);requireLegal(body);requireRule(body.detailsConfirmed===true,'请先核对订单的真实联系资料');
        recordLegalConsent(db,{userId:user.id,scope:'payment',targetId:order.id,body,release:legal});return json(res,200,{accepted:true});
      }
      const paymentStatus=/^\/api\/orders\/([A-Z0-9]+)\/payment-status$/.exec(path);
      if(paymentStatus&&method==='GET'){
        requireRule(native&&user.role==='member','请使用小程序微信身份',403);
        const order=paymentReady ? await payments.status(user,paymentStatus[1]) : orderView(db,ownedOrder(db,user.id,paymentStatus[1]));
        return json(res,200,{order,enabled:paymentReady,legal,legalAccepted:paymentAccepted(user.id,order.id)});
      }
      const manualMatch = /^\/api\/orders\/([A-Z0-9]+)\/manual-payment$/.exec(path);
      if (manualMatch) {
        requireRule(!native || options.nativeManualPayment===true,'小程序付款说明入口尚未开放',403);
        const claim=manualPayment(db,user,manualMatch[1]);
        if(method==='GET')return json(res,200,{enabled:options.manualPayment===true,claim,legal,legalAccepted:paymentAccepted(user.id,manualMatch[1])});
        requireRule(options.manualPayment===true,'收款码付款尚未开放',503);
        if(method==='POST')requireRule(!payments.attempted(manualMatch[1]),'已发起微信支付，请刷新支付结果，勿改用人工付款',409);
        if(method==='POST'&&legal) requireRule(paymentAccepted(user.id,manualMatch[1]),'请先阅读当前协议并确认订单资料',409);
        if(method==='POST')return json(res,200,{claim:submitManualPayment(db,user,manualMatch[1],await readBody(req))});
      }
      const collectionImage=/^\/api\/orders\/([A-Z0-9]+)\/collection-image$/.exec(path);
      if(collectionImage && method==='GET'){
        requireRule(options.manualPayment===true && (!native || options.nativeManualPayment===true),'收款码付款尚未开放',503);
        const order=ownedOrder(db,user.id,collectionImage[1]);
        requireRule(!payments.attempted(order.id),'已发起微信支付，请勿重复付款',409);
        requireRule(user.role==='member' && order.status==='pending' && ['basic','star'].includes(order.plan_id),'当前订单不能进入付款',409);
        requireRule(paymentAccepted(user.id,order.id),'请先阅读当前协议并确认订单资料',409);
        const claim=manualPayment(db,user,order.id);
        requireRule(!claim || claim.status==='rejected','付款说明已提交，请勿重复付款',409);
        const bytes=readFileSync(new URL('../public/images/club-wechat-collection.jpg',import.meta.url));
        res.writeHead(200,{'Content-Type':'image/jpeg','Content-Length':bytes.length,'Cache-Control':'no-store','X-Content-Type-Options':'nosniff'});
        return res.end(bytes);
      }
      if(path==='/api/admin/manual-payments'&&method==='GET') {
        const status=url.searchParams.get('status')??'pending', after=url.searchParams.get('after')??'0';
        requireRule(['pending','rejected','confirmed','all'].includes(status),'付款说明状态不正确');
        requireRule(/^\d+$/.test(after)&&Number.isSafeInteger(Number(after)),'分页位置不正确');
        // Immutable insertion position prevents reviews/removals from shifting later pages.
        const rows=db.prepare(`SELECT m.rowid AS position,m.*,o.amount_cents AS expected_cents,o.plan_id,o.status AS order_status
          FROM manual_payments m JOIN orders o ON o.id=m.order_id
          WHERE m.rowid>? AND (?='all' OR m.status=?) ORDER BY m.rowid ASC LIMIT 51`).all(Number(after),status,status);
        const more=rows.length>50, claims=rows.slice(0,50);
        return json(res,200,{claims,next:more?String(claims.at(-1).position):null});
      }
      const manualReview=/^\/api\/admin\/manual-payments\/([A-Z0-9]+)$/.exec(path);
      if(manualReview&&method==='POST')return json(res,200,{claim:reviewManualPayment(db,user,manualReview[1],await readBody(req))});
      if (orderMatch) {
        const row = ownedOrder(db,user.id,orderMatch[1]);
        if (method === 'GET' && !orderMatch[2]) return json(res,200,{ order:orderView(db,row) });
        if (method === 'POST' && orderMatch[2] === 'cancel') {
          requireRule(!db.prepare("SELECT 1 FROM manual_payments WHERE order_id=? AND status='pending'").get(row.id),'付款说明正在核对，请联系工作人员处理，勿重复付款',409);
          if(payments.attempted(row.id)){requireRule(paymentReady,'请等待支付核实后取消订单',409);await payments.close(user,row.id);}
          return json(res,200,{ order:cancelOrder(db,user.id,row.id) });
        }
        if (method === 'POST' && orderMatch[2] === 'payment') {
          requireRule(!plans[row.plan_id]?.registrationOnly,'机构及专业会员目前仅接受预报名，暂不收费',409);
          requireRule(row.status === 'pending','此订单当前不能付款',409);
          requireRule(paymentReady,'微信支付正在配置，订单已保存；当前不会收款或开通会员',503);
          requireRule(native&&user.role==='member','请使用小程序微信身份付款',403);
          requireRule(paymentAccepted(user.id,row.id),'请先阅读当前协议并确认订单资料',409);
          limit(req,'wechat-prepay',10);await readBody(req);
          return json(res,200,{payment:await payments.prepay(user,row.id)});
        }
      }
      if (path === '/api/admin/orders' && method === 'GET') return json(res,200,{ orders:db.prepare('SELECT * FROM orders ORDER BY created_at DESC').all().map(row=>orderView(db,row)) });
      if (path === '/api/admin/members' && method === 'GET') return json(res,200,{ members:db.prepare("SELECT * FROM users WHERE role='member' ORDER BY created_at DESC").all().map(row=>({ ...publicUser(db,row),membership:membership(db,row.id) })) });
      if (path === '/api/admin/audit' && method === 'GET') return json(res,200,{ events:db.prepare('SELECT id,actor_id,action,target_id,detail,created_at FROM audit_log ORDER BY id DESC LIMIT 200').all() });
      const reviewMatch = /^\/api\/admin\/orders\/([A-Z0-9]+)\/review$/.exec(path);
      if (reviewMatch && method === 'POST') return json(res,200,{ order:reviewOrder(db,user.id,reviewMatch[1],await readBody(req)) });
      if (path === '/api/posts' && method === 'GET') return json(res,200,{ posts:db.prepare('SELECT * FROM posts WHERE user_id=? ORDER BY created_at DESC').all(user.id).map(postView) });
      if (path === '/api/posts' && method === 'POST') return json(res,201,{post:postView(publishMemberPost(db,user,await readBody(req),req.headers['idempotency-key']))});
      if (path === '/api/admin/posts' && method === 'GET') return json(res,200,{ posts:db.prepare('SELECT * FROM posts ORDER BY created_at DESC').all().map(postView) });
      const postMatch = /^\/api\/admin\/posts\/([a-f0-9-]+)\/review$/.exec(path);
      if (postMatch && method === 'POST') return json(res,200,moderateMemberPost(db,user,postMatch[1],await readBody(req)));
      throw new BusinessError('接口不存在',404);
    } catch (error) {
      if (!(error instanceof BusinessError)) console.error('API error:',error.message);
      if (!res.headersSent) json(res,error instanceof BusinessError ? error.status : 500,
        { error:error instanceof BusinessError ? error.message : '服务暂时不可用，请稍后重试',
          ...(error instanceof BusinessError && error.code ? { code: error.code } : {}) });
    }
  });
}
