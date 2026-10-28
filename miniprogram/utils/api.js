const config = require('../config');
const { createReferralContext, contextChanged } = require('./referral');

const statusLabels = { review: '待资质审核', pending: '待付款', paid: '已付款', cancelled: '已取消', rejected: '审核未通过' };
function cloudConfig() {
  if (config.transport !== 'cloud') return null;
  const cloud = config.cloud || {};
  if (!/^[a-zA-Z0-9_-]{3,100}$/.test(cloud.env || '') || !/^[a-zA-Z0-9][a-zA-Z0-9_-]{0,62}$/.test(cloud.service || '')
    || !/^https:\/\/[a-z0-9][a-z0-9.-]*\.[a-z]{2,}\/api$/.test(cloud.downloadBaseUrl || ''))
    throw new Error('云服务配置未完成，请先核对环境、服务和文件域名。');
  return cloud;
}
let initializedCloud = '';
function initCloud() {
  const cloud = cloudConfig();
  if (!cloud) return;
  if (!wx.cloud || typeof wx.cloud.init !== 'function' || typeof wx.cloud.callContainer !== 'function')
    throw new Error('当前微信版本不支持云服务，请更新微信后重试。');
  if (initializedCloud !== cloud.env) {
    wx.cloud.init({env: cloud.env, traceUser: false});
    initializedCloud = cloud.env;
  }
}
function baseUrl() {
  const cloud = cloudConfig();
  if (cloud) return 'cloud://' + cloud.env + '/' + cloud.service + '/api';
  const app = getApp();
  const override = app && app.globalData && app.globalData.apiBaseUrl;
  // The integration harness may select its isolated loopback server; never send
  // a stored credential to an arbitrary runtime-provided endpoint.
  if (override && /^http:\/\/127\.0\.0\.1:(5187|5197)\/api$/.test(override)) return override;
  return config.apiBaseUrl;
}
const referrals = createReferralContext({ getScope: baseUrl, read: key => wx.getStorageSync(key),
  write: (key, value) => wx.setStorageSync(key, value), remove: key => wx.removeStorageSync(key) });
let sessionVersion = 0;
const unavailableSessionScopes = new Map();
const sessionListeners = new Set();
function subscribeSession(listener) { sessionListeners.add(listener); return () => sessionListeners.delete(listener); }
function notifySession() { for (const listener of sessionListeners) { try { listener(); } catch (error) {} } }
// Enterprise text uses its own user + environment + form storage namespace.
function enterpriseDraftScope(scope, owner) { return scope + ':user:' + encodeURIComponent(owner) + ':form:enterprise-intake'; }
function draftOwnerKey(scope) { return 'club-native-draft-owner:' + scope; }
function removeOwnerDrafts(scope, owner) {
  if (owner) wx.removeStorageSync('club-native-drafts:' + enterpriseDraftScope(scope, owner));
  const record = wx.getStorageSync('club-native-drafts:' + scope);
  if (!owner || record?.owner === owner) wx.removeStorageSync('club-native-drafts:' + scope);
}
function identifyDraftOwner(owner, stamp) {
  if (!owner || !isCurrentSession(stamp)) return false;
  const previous = wx.getStorageSync(draftOwnerKey(stamp.scope)) || wx.getStorageSync('club-native-drafts:' + stamp.scope)?.owner;
  if (previous && previous !== owner) removeOwnerDrafts(stamp.scope, previous);
  wx.setStorageSync(draftOwnerKey(stamp.scope), owner);
  return true;
}
function storageKey(scope = baseUrl()) { return 'club-native-session:' + scope; }
function blockSessionStorage(scope) {
  if (unavailableSessionScopes.has(scope)) return;
  const fromVersion = sessionVersion;
  unavailableSessionScopes.set(scope, {fromVersion, version: ++sessionVersion});
  // Refuse the persisted credential until an explicit new authentication or a
  // verified cleanup. A storage failure must not leave old private pages live.
  notifySession();
}
function readSessionStorage(scope = baseUrl()) {
  if (unavailableSessionScopes.has(scope)) return null;
  try {return wx.getStorageSync(storageKey(scope));}
  catch (error) {blockSessionStorage(scope); return null;}
}
function clearSession(options = {}) {
  const scope = options.stamp?.scope || baseUrl();
  const unavailable = unavailableSessionScopes.get(scope), stamp = options.stamp;
  let current = !stamp || (baseUrl() === scope && (sessionVersion === stamp.version || (unavailable?.fromVersion === stamp.version && unavailable.version === sessionVersion)));
  let session, readable = true;
  if (current) {
    try {session = wx.getStorageSync(storageKey(scope));}
    catch (error) {readable = false;}
    if (readable && stamp && !unavailable && session?.accessToken !== stamp.token) current = false;
  }
  let draftsCleared = true;
  if (options.logout) {
    try {
      const owner = options.owner || options.stamp?.ownerId || (current ? session?.userId || wx.getStorageSync(draftOwnerKey(scope)) || wx.getStorageSync('club-native-drafts:' + scope)?.owner : '');
      if (current || owner) {
        removeOwnerDrafts(scope, owner);
        if (!owner || wx.getStorageSync(draftOwnerKey(scope)) === owner) wx.removeStorageSync(draftOwnerKey(scope));
      }
    } catch (error) { draftsCleared = false; }
  }
  // An expired old page may clear its own drafts, but cannot revoke a new login.
  if (!current) return draftsCleared;
  let sessionCleared = readable;
  try {wx.removeStorageSync(storageKey(scope)); if (wx.getStorageSync(storageKey(scope))) sessionCleared = false;}
  catch (error) {sessionCleared = false;}
  if (sessionCleared) {unavailableSessionScopes.delete(scope); sessionVersion++;}
  else blockSessionStorage(scope);
  try {if (options.logout) referrals.clear(); else referrals.invalidate();}
  catch (error) {draftsCleared = false;}
  finally {notifySession();}
  return draftsCleared && sessionCleared;
}
function sessionStamp() {
  const scope = baseUrl(), session = readSessionStorage(scope) || {};
  return { scope, downloadBaseUrl: cloudConfig()?.downloadBaseUrl || scope, version: sessionVersion, token: session.accessToken,authMode:session.authMode,expiresAt:session.expiresAt,ownerId:session.userId,storageUnavailable:unavailableSessionScopes.has(scope) };
}
function isCurrentSession(stamp) {
  if (!stamp || baseUrl() !== stamp.scope || sessionVersion !== stamp.version) return false;
  const session = readSessionStorage(stamp.scope) || {};
  return sessionVersion === stamp.version && session.accessToken === stamp.token;
}
function currentSession() {
  const session = readSessionStorage();
  if (!session || !/^[a-f0-9]{64}$/.test(session.accessToken || '') || Date.parse(session.expiresAt) <= Date.now() || !Number.isFinite(Date.parse(session.expiresAt))) {
    if (session) clearSession();
    return null;
  }
  return session;
}
function hasSession() { return !!currentSession(); }
function saveSession(result) {
  if (!result || result.tokenType !== 'Bearer' || !/^[a-f0-9]{64}$/.test(result.accessToken || '') || !(Date.parse(result.expiresAt) > Date.now())) {
    throw new Error('登录返回异常，请重新登录。');
  }
  wx.setStorageSync(storageKey(), { accessToken: result.accessToken, expiresAt: result.expiresAt, authMode: result.authMode, userId: result.user?.id });
  unavailableSessionScopes.delete(baseUrl());
  sessionVersion++;
  try {
    if (result.user?.id) identifyDraftOwner(result.user.id, sessionStamp());
    const drafts = wx.getStorageSync('club-native-drafts:' + baseUrl());
    if (drafts && drafts.owner !== result.user?.id) wx.removeStorageSync('club-native-drafts:' + baseUrl());
    if (result.user && result.user.id) referrals.identify(result.user);
  } finally {notifySession();}
}
function requestPath(value){
  // Mini-program runtimes need not provide URL/URLSearchParams. Split only the
  // raw query delimiter, validate the pathname first, then encode each decoded
  // component once. Query data can never become a host, fragment or pathname.
  if(typeof value!=='string'||value.length>4096||/[\x00-\x20\x7f-\x9f#\\]/.test(value))throw new Error('接口地址不正确');
  const split=value.indexOf('?'),pathname=split<0?value:value.slice(0,split);
  if(!/^\/[a-zA-Z0-9_-]+(?:\/[a-zA-Z0-9_-]+)*\/?$/.test(pathname)||value.indexOf('?',split+1)!==-1)throw new Error('接口地址不正确');
  if(split<0)return {pathname,path:pathname};
  const raw=value.slice(split+1);if(!raw)throw new Error('接口地址不正确');
  const names=new Set(),encode=text=>encodeURIComponent(text).replace(/[!'()*]/g,c=>'%'+c.charCodeAt(0).toString(16).toUpperCase());
  const query=raw.split('&').map(part=>{
    const equal=part.indexOf('=');if(equal<=0)throw new Error('接口地址不正确');
    let name,data;try{name=decodeURIComponent(part.slice(0,equal).replace(/\+/g,' '));data=decodeURIComponent(part.slice(equal+1).replace(/\+/g,' '));}catch{throw new Error('接口地址不正确');}
    if(!/^[a-zA-Z][a-zA-Z0-9_-]*$/.test(name)||names.has(name)||/[\x00-\x1f\x7f-\x9f\u200b-\u200f\u2028-\u202e\u2060-\u206f\ufeff]/.test(data))throw new Error('接口地址不正确');
    names.add(name);try{return encode(name)+'='+encode(data);}catch{throw new Error('接口地址不正确');}
  }).join('&');
  return {pathname,path:pathname+'?'+query};
}
function api(path, body, key) {
  let target;try{target=requestPath(path);}catch(error){return Promise.reject(error);}
  path=target.path;
  try { initCloud(); } catch (error) { return Promise.reject(error); }
  const session = currentSession();
  const stamp = sessionStamp();
  const isLogin = /^\/native\/auth\/(login|register|wechat)$/.test(target.pathname);
  const header = { 'Content-Type': 'application/json', 'X-Club-Request': '1' };
  if (session && !isLogin) header.Authorization = 'Bearer ' + session.accessToken;
  if (key) header['Idempotency-Key'] = key;
  return new Promise((resolve, reject) => {
   const options = {
    url: stamp.scope + path, method: body === undefined ? 'GET' : 'POST', header, timeout: target.pathname === '/enterprise-intake' && body !== undefined ? 120000 : 10000,
    ...(body === undefined ? {} : { data: body }),
    success(response) {
      if (!isCurrentSession(stamp)) return reject(contextChanged());
      if (response.statusCode >= 200 && response.statusCode < 300 && response.data && typeof response.data === 'object') return resolve(response.data);
      const error = new Error(response.data && response.data.error || '服务返回异常，请稍后重试。');
      error.status = response.statusCode;
      error.code = response.data && response.data.code;
      if (response.statusCode === 401 && !isLogin) clearSession();
      reject(error);
    },
    fail() { reject(isCurrentSession(stamp) ? new Error('暂时连接不上数据服务，请确认网络后重试。') : contextChanged()); }
   };
   const cloud = cloudConfig();
   if (!cloud) return wx.request(options);
   // SDK Promise result uses the same statusCode/data contract as wx.request.
   const {url, success, fail, ...request} = options;
   Promise.resolve().then(() => wx.cloud.callContainer({...request, config: {env: cloud.env},
     path: '/api' + path, header: {...header, 'X-WX-SERVICE': cloud.service}})).then(success, fail);
  });
}
function captureReferral(query) { return currentSession()?.authMode==='review'?referrals.snapshot():referrals.capture(query); }
function removeReportFile(path){if(path&&wx.getFileSystemManager)wx.getFileSystemManager().unlink({filePath:path,fail(){}});}
// Native cloud files stay on the associated service. Download large PDFs in
// bounded chunks, checking identity and immutable content on every response.
async function downloadCloudFile(path,fileType='pdf',authenticated=false,maxBytes=128*1024*1024){
  initCloud();
  const cloud=cloudConfig(),session=currentSession(),stamp=sessionStamp();
  if(!cloud||!wx.getFileSystemManager||!wx.env?.USER_DATA_PATH)throw new Error('当前微信环境不能读取文件，请更新微信后重试。');
  const fs=wx.getFileSystemManager(),chunk=1024*1024,max=maxBytes;
  const filePath=wx.env.USER_DATA_PATH+'/club-document-'+newKey()+'.'+fileType;
  const header={'X-WX-SERVICE':cloud.service,'X-Club-Request':'1'};
  if(authenticated&&session)header.Authorization='Bearer '+session.accessToken;
  let offset=0,total,etag;
  const ensureCurrent=()=>{currentSession();if(!isCurrentSession(stamp))throw contextChanged();};
  try{
    do{
      ensureCurrent();
      const response=await wx.cloud.callContainer({config:{env:cloud.env},path:'/api'+path,method:'GET',responseType:'arraybuffer',timeout:120000,
        header:{...header,Range:'bytes='+offset+'-'+(offset+chunk-1),...(etag?{'If-Match':etag}:{})}});
      ensureCurrent();
      if(![200,206].includes(response.statusCode)||!(response.data instanceof ArrayBuffer))throw new Error('文件已变化或当前不可读取，请刷新后重试。');
      const headers=Object.fromEntries(Object.entries(response.header||{}).map(([key,value])=>[key.toLowerCase(),String(value)]));
      const length=response.data.byteLength;
      if(!length||length>max)throw new Error('文件大小不正确，请稍后重试。');
      if(response.statusCode===206){
        const range=/^bytes (\d+)-(\d+)\/(\d+)$/.exec(headers['content-range']||'');
        if(!range||Number(range[1])!==offset||Number(range[2])+1!==offset+length||length>chunk||Number(range[3])>max||Number(range[3])<offset+length
          ||(total!==undefined&&total!==Number(range[3]))||!/^"[a-f0-9]{64}"$/.test(headers.etag||'')||(etag&&etag!==headers.etag))throw new Error('文件内容已变化，请刷新后重试。');
        total=Number(range[3]);etag=headers.etag;
      }else{
        if(offset!==0)throw new Error('文件传输已变化，请重试。');total=length;
      }
      await new Promise((resolve,reject)=>fs[offset?'appendFile':'writeFile']({filePath,data:response.data,success:resolve,fail:()=>reject(new Error('文件保存失败，请清理微信存储后重试。'))}));
      ensureCurrent();offset+=length;
    }while(offset<total);
    return filePath;
  }catch(error){removeReportFile(filePath);if(error.code==='CONTEXT_CHANGED')throw error;throw new Error('文件读取未完成，请刷新并检查网络后重试。');}
}
// Blank application templates are small fixed DOCX assets. Validate the whole
// response before saving, including HTTP-200 error pages returned by a gateway.
async function downloadApplicationTemplate(path){
  initCloud();
  const cloud=cloudConfig(),stamp=sessionStamp();
  if(!wx.getFileSystemManager||!wx.env?.USER_DATA_PATH)throw new Error('当前微信环境不能读取文件，请更新微信后重试。');
  const filePath=wx.env.USER_DATA_PATH+'/club-document-'+newKey()+'.docx';
  try{
    const response=cloud?await wx.cloud.callContainer({config:{env:cloud.env},path:'/api'+path,method:'GET',responseType:'arraybuffer',timeout:120000,header:{'X-WX-SERVICE':cloud.service,'X-Club-Request':'1'}})
      :await new Promise((resolve,reject)=>wx.request({url:stamp.downloadBaseUrl+path,method:'GET',responseType:'arraybuffer',timeout:120000,success:resolve,fail:reject}));
    if(!isCurrentSession(stamp))throw contextChanged();
    const headers=Object.fromEntries(Object.entries(response.header||{}).map(([key,value])=>[key.toLowerCase(),String(value)]));
    const bytes=response.data instanceof ArrayBuffer?new Uint8Array(response.data):null;
    const mime=headers['content-type']?.split(';')[0].trim().toLowerCase();
    if(response.statusCode!==200||!bytes||bytes.length<4||bytes.length>1024*1024
      ||bytes[0]!==0x50||bytes[1]!==0x4b||bytes[2]!==3||bytes[3]!==4
      ||(headers['content-length']!==undefined&&(!/^\d+$/.test(headers['content-length'])||Number(headers['content-length'])!==bytes.length))
      ||(mime!==undefined&&mime!=='application/vnd.openxmlformats-officedocument.wordprocessingml.document'))throw new Error('申请表文件格式或长度不正确，请稍后重试。');
    await new Promise((resolve,reject)=>wx.getFileSystemManager().writeFile({filePath,data:response.data,success:resolve,fail:reject}));
    if(!isCurrentSession(stamp))throw contextChanged();
    return filePath;
  }catch(error){removeReportFile(filePath);if(error.code==='CONTEXT_CHANGED')throw error;throw new Error('申请表未能完整下载，请检查网络后重试。');}
}
function downloadPublicDocument(path,fileType){
  if(!/^\/(legal\/(privacy|terms)\/document|enterprise-intake\/template\/(docx|pdf)|application-templates\/(partner|organization)\/docx)$/.test(path)||!['pdf','docx'].includes(fileType)
    ||(path.startsWith('/application-templates/')&&fileType!=='docx'))return Promise.reject(new Error('文件地址不正确'));
  if(path.startsWith('/application-templates/'))return downloadApplicationTemplate(path);
  if(cloudConfig())return downloadCloudFile(path,fileType);
  const stamp=sessionStamp();
  return new Promise((resolve,reject)=>wx.downloadFile({url:stamp.downloadBaseUrl+path,timeout:120000,
    success(result){if(!isCurrentSession(stamp)||result.statusCode!==200){removeReportFile(result.tempFilePath);return reject(new Error('文件暂时无法读取，请刷新后重试。'));}resolve(result.tempFilePath);},
    fail(){reject(new Error('下载未完成，请检查网络后重试'));}}));
}
function downloadArticle(id,preview){
  if(!/^[a-f0-9-]{36}$/.test(id))return Promise.reject(new Error('报告地址不正确'));
  if(cloudConfig())return downloadCloudFile('/articles/'+id+(preview?'/preview':'/document'),'pdf',true);
  const session=currentSession(),stamp=sessionStamp();
  return new Promise((resolve,reject)=>wx.downloadFile({
    url:stamp.downloadBaseUrl+'/articles/'+id+(preview?'/preview':'/document'),
    header:session?{Authorization:'Bearer '+session.accessToken}:{},timeout:120000,
    success(result){
      currentSession();
      if(!isCurrentSession(stamp)){removeReportFile(result.tempFilePath);return reject(contextChanged());}
      if(result.statusCode!==200){removeReportFile(result.tempFilePath);return reject(new Error('报告已撤下或阅读权限已变化，请刷新后重试。'));}
      resolve(result.tempFilePath);
    },fail(){reject(new Error('报告下载未完成，请检查网络后重试。'));}
  }));
}
function reviewContext(value){return value?.authMode==='review'||value?.role==='reviewer'||value?.user?.authMode==='review'||value?.user?.role==='reviewer'||value?.reviewAccess?.readOnly===true;}
async function synchronizeReferral(user,context) {
  // An opaque review token/actor never establishes production provenance. Do
  // not invent a locked/explicit source to make the normal synchronizer stop.
  if(currentSession()?.authMode==='review'||reviewContext(user)||reviewContext(context))return {user,notice:'审核只读体验不登记推荐来源。'};
  return referrals.synchronize(user, async code => (await api('/referral', { code })).user);
}
async function memberContext() {
  const session = await api('/me');
  if (!session.user) { clearSession(); return session; }
  const result = await synchronizeReferral(session.user,session);
  return Object.assign({}, session, { user: result.user, referralNotice: result.notice });
}
async function authenticate(path, body) {
  const result = await api(path, body);
  saveSession(result);
  try {
    const synced = await synchronizeReferral(result.user,result);
    result.user = synced.user;
    result.referralNotice = synced.notice;
  } catch (error) {
    if (error.status === 401 || error.code === 'CONTEXT_CHANGED') throw error;
    // Identity succeeded. Keep candidates for the application page's retry.
    result.referralPending = true;
  }
  return result;
}
function loginLocal({ username, password, register = false, referral = '', legalConsent }) {
  return authenticate('/native/auth/' + (register ? 'register' : 'login'), { username, password, consent: true, legalConsent, ...(register ? {referral} : {}) });
}
async function loginWechat(legalConsent, existingAccount, transferCode) {
  const stamp = sessionStamp();
  const code = await new Promise((resolve, reject) => wx.login({
    timeout: 10000,
    success(result) { result.code ? resolve(result.code) : reject(new Error('未取得微信登录凭证，请重试。')); },
    fail() { reject(new Error('微信登录未完成，可稍后重试。')); }
  }));
  if (!isCurrentSession(stamp)) throw contextChanged();
  return authenticate('/native/auth/wechat', { code, consent: true, legalConsent,existingAccount,transferCode });
}
async function paymentLoginCode(isActive) {
  if (!hasSession()) throw new Error('请先登录后付款。');
  const stamp=sessionStamp();
  const active=()=>isCurrentSession(stamp)&&(!isActive||isActive());
  if(!active())throw contextChanged();
  const code=await new Promise((resolve,reject)=>wx.login({timeout:10000,
    success(result){typeof result.code==='string'&&result.code?resolve(result.code):reject(new Error('未取得微信支付登录凭证，请重试。'));},
    fail(){reject(new Error('微信支付登录凭证未取得，请稍后重试。'));}}));
  if(!active())throw contextChanged();
  return code; // This does not log in again, replace the app session, or save session_key.
}
function newKey() { return 'native-' + Date.now().toString(36) + '-' + Math.random().toString(36).slice(2) + '-' + Math.random().toString(36).slice(2); }
function downloadCollectionImage(orderId){
  if(!/^[A-Z0-9]+$/.test(orderId))return Promise.reject(new Error('订单编号不正确'));
  const session=currentSession(),stamp=sessionStamp();
  if(!session)return Promise.reject(new Error('请先登录'));
  return new Promise((resolve,reject)=>wx.downloadFile({
    url:stamp.downloadBaseUrl+'/orders/'+orderId+'/collection-image',
    header:{Authorization:'Bearer '+session.accessToken},timeout:30000,
    success(result){
      currentSession();
      if(!isCurrentSession(stamp) || result.statusCode!==200){removeReportFile(result.tempFilePath);reject(new Error('收款码暂不可读，请刷新订单并核对协议和付款进度'));return;}
      resolve(result.tempFilePath);
    },fail(){reject(new Error('收款码下载未完成，请稍后重试'));}
  }));
}
function activityPosterUrl(id) {return /^[a-f0-9-]{36}$/.test(id) ? sessionStamp().downloadBaseUrl + '/activities/' + id + '/poster' : '';}
function downloadActivityPoster(id,posterUrl){
  if(!/^[a-f0-9-]{36}$/.test(id)||!/^images\/[a-z0-9-]+\.(jpg|png|webp)$/.test(posterUrl||''))return Promise.reject(new Error('活动原图地址不正确'));
  if(!cloudConfig())return Promise.resolve(activityPosterUrl(id));
  return downloadCloudFile('/activities/'+id+'/poster',posterUrl.split('.').pop(),false,5*1024*1024);
}
async function submitEnterpriseIntake(body,key,onProgress,isActive){
  if(!cloudConfig())return api('/enterprise-intake',body,key);
  const encoded=body.fileBase64;
  if(typeof encoded!=='string'||!encoded.length||encoded.length%4!==0)throw new Error('文件内容不正确，请重新选择材料');
  const byteSize=encoded.length/4*3-(encoded.endsWith('==')?2:encoded.endsWith('=')?1:0);
  if(byteSize>5*1024*1024)throw new Error('文件不能超过5MB');
  const stamp=sessionStamp();
  const ensureCurrent=()=>{if(!isCurrentSession(stamp)||(isActive&&isActive()===false))throw contextChanged();};
  ensureCurrent();
  const capabilities=await api('/enterprise-intake');ensureCurrent();
  if(capabilities.uploadTransport!=='chunked-v1')throw new Error('材料上传服务正在更新，请保留所选文件并稍后重试。');
  const upload=await api('/enterprise-intake/upload',{filename:body.filename,byteSize,templateVersion:body.templateVersion,consent:body.consent,legalConsent:body.legalConsent},key);
  const chunk=30*1024/3*4,total=Math.ceil(encoded.length/chunk);
  if(!/^[a-f0-9-]{36}$/.test(upload.id)||!/^[a-f0-9]{64}$/.test(upload.token)||upload.chunkBytes!==30*1024||!Number.isSafeInteger(upload.nextIndex)||upload.nextIndex<0||upload.nextIndex>total)throw new Error('材料上传初始化异常，请重试');
  for(let index=upload.nextIndex;index<total;index++){
    ensureCurrent();
    const part=await api('/enterprise-intake/upload/'+upload.id+'/part/'+index,{token:upload.token,dataBase64:encoded.slice(index*chunk,(index+1)*chunk)});
    if(part.nextIndex!==index+1)throw new Error('材料上传进度异常，请重新提交');
    ensureCurrent();if(onProgress)onProgress(Math.floor((index+1)/total*100));
  }
  ensureCurrent();
  const input={...body,fileUploadId:upload.id,fileUploadToken:upload.token};delete input.fileBase64;
  return api('/enterprise-intake',input,key);
}
function money(cents) { return (Number(cents || 0) / 100).toFixed(2); }
module.exports = { api, initCloud, saveSession, clearSession, hasSession, subscribeSession, enterpriseDraftScope, identifyDraftOwner, loginWechat, paymentLoginCode, loginLocal, downloadArticle, downloadPublicDocument, removeReportFile, activityPosterUrl,downloadCollectionImage,
  captureReferral, memberContext, sessionStamp, isCurrentSession, downloadActivityPoster, submitEnterpriseIntake, newKey, money, statusLabels };
