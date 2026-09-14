import { publishMemberPost, moderateMemberPost } from './posts.mjs';
import { installAmbassadors, ambassadorStatus, applyAmbassador, listAmbassadors, followAmbassador } from './ambassadors.mjs';
import { campaignState } from './campaign.mjs';
import { surveys, installSurveys, submitSurvey, listSurveys } from './surveys.mjs';
import {sendArticleDocument} from './article-documents.mjs';
import {listActivities,readActivity,saveActivity,transitionActivity} from './activities.mjs';
import { createWebPolicy } from './web-policy.mjs';
import { listManagedResources, createResource, updateResource, transitionResource, listReadableResources, readResource } from './resources.mjs';
import { createServer } from 'node:http';
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
  installSurveys(db);
  installAmbassadors(db);
  const web = options.webTrial ? createWebPolicy(options.webTrial) : null;
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
  function limit(req, scope = 'auth') {
    const time = Date.now();
    for (const [key,value] of attempts) if (value.until <= time) attempts.delete(key);
    const key = scope + ':' + (req.trialClientIp ?? req.socket.remoteAddress);
    requireRule(attempts.has(key) || attempts.size < 10000, '服务繁忙，请稍后重试', 429);
    const item = attempts.get(key) ?? { count:0, until:time+60000 };
    item.count++;
    attempts.set(key, item);
    requireRule(item.count <= 25, '操作过于频繁，请一分钟后重试', 429);
  }
  return createServer(async (req,res) => {
    try {
      if (lanNetwork) requireRule(isAllowedLanClient(req.socket.remoteAddress, lanNetwork), '仅允许同一局域网的测试设备访问', 403);
      requireRule(allowedHosts.has(req.headers.host), '访问地址不受支持', 403);
      const url = new URL(req.url, 'http://127.0.0.1');
      const path = url.pathname;
      const method = req.method;
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
      requireRule(!req.headers['sec-fetch-site'] || req.headers['sec-fetch-site'] !== 'cross-site', '不允许跨站请求', 403);
      if (method !== 'GET') {
        requireRule(req.headers['x-club-request'] === '1', '缺少请求校验标记', 403);
      }
      const native = nativeIdentity(db, req, allowNativeTrialAuth);
      if (remote && native) {
        const identity = db.prepare('SELECT app_id AS appId,open_id AS openId FROM wechat_identities WHERE user_id=? AND app_id=?').get(native.user.id, remote.appId);
        if (!nativeAuth.wechat || !remote.allowsIdentity(identity))
          throw authError('测试访问资格已失效', 403, 'TRIAL_NOT_INVITED');
      }
      if (path === '/api/campaign' && method === 'GET') return json(res,200,{campaign:campaignState()});
      const surveyRoute = /^\/api\/surveys\/(supply|demand)$/.exec(path);
      if (surveyRoute && method === 'GET') return json(res, 200, { survey: surveys[surveyRoute[1]] });
      if (surveyRoute && method === 'POST') {
        limit(req, 'survey');
        requireRule(campaignState().active, '本次活动问卷已结束，感谢关注', 410);
        return json(res, 201, { receipt: submitSurvey(db, surveyRoute[1], await readBody(req, 512 * 1024), req.headers['idempotency-key']) });
      }
      if (path === '/api/health' && method === 'GET') return json(res,200,{ status:'ok', storage:'sqlite', mode, paymentReady:false, nativeAuth });
      if (path === '/api/plans' && method === 'GET') return json(res,200,{ plans:Object.values(plans), paymentReady:false });
      if (['/api/native/auth/login','/api/native/auth/register','/api/native/auth/wechat'].includes(path) && method === 'POST') {
        requireUnauthenticatedNativeLogin(req);
        if (!path.endsWith('/wechat') && !allowNativeTrialAuth) throw new BusinessError('接口不存在', 404);
        if (remote && !nativeAuth.wechat) throw authError('微信测试登录尚未开放', 503, 'WECHAT_NOT_CONFIGURED');
        limit(req);
        const body = await readBody(req);
        const registered = path.endsWith('/register');
        const result = path.endsWith('/wechat') ? await wechatLogin(db, body, options.wechat, remote?.allowsIdentity)
          : await trialLogin(db, body, registered, dummyHash);
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
          requireRule(body.consent === true, '请同意内测资料保存说明');
          const passwordHash = await hashPassword(body.password);
          const user = transaction(db, () => {
            requireRule(!db.prepare('SELECT 1 FROM users WHERE username=?').get(username), '账号已被使用', 409);
            const created = insertUser(db, username, passwordHash);
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
        membership:user ? membership(db,user.id) : null, paymentReady:false,
        defaultReferralConfigured:!!db.prepare("SELECT 1 FROM settings WHERE key='default_referral_code'").get() });
      requireRule(user, '请先登录', 401);
      if (path === '/api/content' && method === 'GET') return json(res,200,{ posts:db.prepare("SELECT * FROM posts WHERE status='published' ORDER BY created_at DESC LIMIT 100").all().map(postView) });
      if(web && method!=='GET') requireRule(req.headers['x-club-actor']===user.id,'登录账号已变化，请刷新后重新操作',409);
      if (path.startsWith('/api/admin/')) requireRule(user.role === 'admin', '需要管理员权限', 403);
      if (path === '/api/admin/surveys' && method === 'GET') return json(res, 200, listSurveys(db, user, url.searchParams.get('before') ?? undefined));
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
        return json(res,201,{ order:createOrder(db,user.id,await readBody(req),req.headers['idempotency-key']) });
      }
      const orderMatch = /^\/api\/orders\/([A-Z0-9]+)(?:\/(cancel|payment))?$/.exec(path);
      if (orderMatch) {
        const row = ownedOrder(db,user.id,orderMatch[1]);
        if (method === 'GET' && !orderMatch[2]) return json(res,200,{ order:orderView(db,row) });
        if (method === 'POST' && orderMatch[2] === 'cancel') return json(res,200,{ order:cancelOrder(db,user.id,row.id) });
        if (method === 'POST' && orderMatch[2] === 'payment') {
          requireRule(!plans[row.plan_id]?.registrationOnly,'机构及专业会员目前仅接受预报名，暂不收费',409);
          requireRule(row.status === 'pending','此订单当前不能付款',409);
          throw new BusinessError('微信支付尚未接通，订单已保存；当前不会收款或开通会员',503);
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
