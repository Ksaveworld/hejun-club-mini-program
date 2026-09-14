const config = require('../config');
const { createReferralContext, contextChanged } = require('./referral');

const statusLabels = { review: '待资质审核', pending: '待付款', paid: '已付款', cancelled: '已取消', rejected: '审核未通过' };
function baseUrl() {
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
function storageKey(scope = baseUrl()) { return 'club-native-session:' + scope; }
function clearSession(options = {}) {
  wx.removeStorageSync(storageKey()); sessionVersion++;
  if (options.logout) { referrals.clear(); wx.removeStorageSync('club-native-drafts:' + baseUrl()); } else referrals.invalidate();
}
function sessionStamp() {
  return { scope: baseUrl(), version: sessionVersion, token: (wx.getStorageSync(storageKey()) || {}).accessToken };
}
function isCurrentSession(stamp) {
  return baseUrl() === stamp.scope && sessionVersion === stamp.version
    && (wx.getStorageSync(storageKey(stamp.scope)) || {}).accessToken === stamp.token;
}
function currentSession() {
  const session = wx.getStorageSync(storageKey());
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
  wx.setStorageSync(storageKey(), { accessToken: result.accessToken, expiresAt: result.expiresAt, authMode: result.authMode });
  sessionVersion++;
  const drafts = wx.getStorageSync('club-native-drafts:' + baseUrl());
  if (drafts && drafts.owner !== result.user?.id) wx.removeStorageSync('club-native-drafts:' + baseUrl());
  if (result.user && result.user.id) referrals.identify(result.user);
}
function api(path, body, key) {
  if (typeof path !== 'string' || !/^\/[a-zA-Z0-9/_-]+$/.test(path)) return Promise.reject(new Error('接口地址不正确'));
  const session = currentSession();
  const stamp = sessionStamp();
  const isLogin = /^\/native\/auth\/(login|register|wechat)$/.test(path);
  const header = { 'Content-Type': 'application/json', 'X-Club-Request': '1' };
  if (session && !isLogin) header.Authorization = 'Bearer ' + session.accessToken;
  if (key) header['Idempotency-Key'] = key;
  return new Promise((resolve, reject) => wx.request({
    url: stamp.scope + path, method: body === undefined ? 'GET' : 'POST', header, timeout: 10000,
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
  }));
}
function captureReferral(query) { return referrals.capture(query); }
function removeReportFile(path){if(path&&wx.getFileSystemManager)wx.getFileSystemManager().unlink({filePath:path,fail(){}});}
function downloadArticle(id,preview){
  if(!/^[a-f0-9-]{36}$/.test(id))return Promise.reject(new Error('报告地址不正确'));
  const session=currentSession(),stamp=sessionStamp();
  return new Promise((resolve,reject)=>wx.downloadFile({
    url:stamp.scope+'/articles/'+id+(preview?'/preview':'/document'),
    header:session?{Authorization:'Bearer '+session.accessToken}:{},timeout:120000,
    success(result){
      currentSession();
      if(!isCurrentSession(stamp)){removeReportFile(result.tempFilePath);return reject(contextChanged());}
      if(result.statusCode!==200){removeReportFile(result.tempFilePath);return reject(new Error('报告已撤下或阅读权限已变化，请刷新后重试。'));}
      resolve(result.tempFilePath);
    },fail(){reject(new Error('报告下载未完成，请检查网络后重试。'));}
  }));
}
async function synchronizeReferral(user) {
  return referrals.synchronize(user, async code => (await api('/referral', { code })).user);
}
async function memberContext() {
  const session = await api('/me');
  if (!session.user) { clearSession(); return session; }
  const result = await synchronizeReferral(session.user);
  return Object.assign({}, session, { user: result.user, referralNotice: result.notice });
}
async function authenticate(path, body) {
  const result = await api(path, body);
  saveSession(result);
  try {
    const synced = await synchronizeReferral(result.user);
    result.user = synced.user;
    result.referralNotice = synced.notice;
  } catch (error) {
    if (error.status === 401 || error.code === 'CONTEXT_CHANGED') throw error;
    // Identity succeeded. Keep candidates for the application page's retry.
    result.referralPending = true;
  }
  return result;
}
function loginLocal({ username, password, register = false }) {
  return authenticate('/native/auth/' + (register ? 'register' : 'login'), { username, password, consent: true });
}
async function loginWechat() {
  const stamp = sessionStamp();
  const code = await new Promise((resolve, reject) => wx.login({
    timeout: 10000,
    success(result) { result.code ? resolve(result.code) : reject(new Error('未取得微信登录凭证，请重试。')); },
    fail() { reject(new Error('微信登录未完成，可稍后重试。')); }
  }));
  if (!isCurrentSession(stamp)) throw contextChanged();
  return authenticate('/native/auth/wechat', { code, consent: true });
}
function newKey() { return 'native-' + Date.now().toString(36) + '-' + Math.random().toString(36).slice(2) + '-' + Math.random().toString(36).slice(2); }
function money(cents) { return (Number(cents || 0) / 100).toFixed(2); }
module.exports = { api, saveSession, clearSession, hasSession, loginWechat, loginLocal, downloadArticle, removeReportFile,
  captureReferral, memberContext, sessionStamp, isCurrentSession, newKey, money, statusLabels };
