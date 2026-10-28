import {readNativeTransfer,consumeNativeTransfer} from './native-transfer.mjs';
import { randomBytes } from 'node:crypto';
import { audit, transaction } from './db.mjs';
import { BusinessError, digest, nowISO, publicUser, insertUser, hashPassword,
  checkPassword, validateCredentials, captureReferral } from './domain.mjs';

const sessionDuration = 12 * 60 * 60 * 1000;
export function authError(message, status, code) {
  return Object.assign(new BusinessError(message, status), { code });
}
export function hasSessionCookie(req) {
  return /(?:^|;\s*)(?:club_session|club_lan_session|club_remote_session|club_web_session)=/.test(req.headers.cookie ?? '');
}
export function requireUnauthenticatedNativeLogin(req) {
  if (hasSessionCookie(req) || req.headers.authorization !== undefined)
    throw authError('请勿混用网页登录与小程序登录凭据', 400, 'AUTH_AMBIGUOUS');
}
export function nativeIdentity(db, req, allowNativeTrialAuth = false) {
  if (req.headers.authorization === undefined) return null;
  if (hasSessionCookie(req)) throw authError('请勿同时发送 Cookie 与 Bearer 凭据', 400, 'AUTH_AMBIGUOUS');
  const token = /^Bearer ([a-f0-9]{64})$/i.exec(req.headers.authorization)?.[1];
  if (!token) throw authError('登录凭据格式不正确，请重新登录', 401, 'AUTH_REQUIRED');
  const tokenHash = digest(token);
  const session = db.prepare('SELECT * FROM native_sessions WHERE token_hash=?').get(tokenHash);
  if (!session) throw authError('登录已失效，请重新登录', 401, 'AUTH_REQUIRED');
  if (session.auth_mode === 'local-trial' && allowNativeTrialAuth !== true)
    throw authError('内测登录已关闭，请使用当前开放的登录方式', 401, 'AUTH_REQUIRED');
  if (session.expires_at <= nowISO()) throw authError('登录已过期，请重新登录', 401, 'SESSION_EXPIRED');
  const user = db.prepare('SELECT * FROM users WHERE id=?').get(session.user_id);
  if (!user || user.role !== 'member') throw authError('小程序登录仅供会员使用', 403, 'FORBIDDEN');
  return { user, tokenHash };
}
function issueSession(db, user, authMode) {
  if (user.role !== 'member') throw authError('小程序登录仅供会员使用', 403, 'FORBIDDEN');
  const accessToken = randomBytes(32).toString('hex');
  const expiresAt = new Date(Date.now() + sessionDuration).toISOString();
  db.prepare('DELETE FROM native_sessions WHERE expires_at<=?').run(nowISO());
  db.prepare('INSERT INTO native_sessions(token_hash,user_id,expires_at,auth_mode) VALUES (?,?,?,?)')
    .run(digest(accessToken), user.id, expiresAt, authMode);
  return { user: publicUser(db, user), accessToken, tokenType: 'Bearer', expiresAt, authMode };
}
function captureLoginReferral(db, user, referral) {
  if (referral && !db.prepare("SELECT 1 FROM orders WHERE user_id=? AND status IN ('review','pending')").get(user.id))
    captureReferral(db, user.id, referral);
  return db.prepare('SELECT * FROM users WHERE id=?').get(user.id);
}
export async function trialLogin(db, body, register, dummyHash, onAuthenticated) {
  const username = validateCredentials(body);
  if (register) {
    if (body.consent !== true) throw authError('请同意内测资料保存说明', 400, 'INVALID_REQUEST');
    const passwordHash = await hashPassword(body.password);
    return transaction(db, () => {
      if (db.prepare('SELECT 1 FROM users WHERE username=?').get(username))
        throw authError('账号已被使用', 409, 'ACCOUNT_CONFLICT');
      const user = insertUser(db, username, passwordHash);
      captureReferral(db, user.id, body.referral ?? '');
      audit(db, user.id, 'account.registered', user.id);
      if (onAuthenticated) onAuthenticated(user.id);
      return issueSession(db, db.prepare('SELECT * FROM users WHERE id=?').get(user.id), 'local-trial');
    });
  }
  const user = db.prepare('SELECT * FROM users WHERE username=?').get(username);
  const valid = await checkPassword(body.password, user?.password_hash ?? await dummyHash);
  if (!user || !valid) throw authError('账号或密码不正确', 401, 'INVALID_CREDENTIALS');
  if (user.role !== 'member') throw authError('小程序登录仅供会员使用', 403, 'FORBIDDEN');
  return transaction(db, () => {
    if (onAuthenticated) onAuthenticated(user.id);
    return issueSession(db, captureLoginReferral(db, user, body.referral), 'local-trial');
  });
}
export async function wechatLogin(db, body, adapter, allowsIdentity = () => true, onAuthenticated, dummyHash, transferAppId) {
  if (!adapter?.configured) throw authError('微信登录尚未配置，请使用当前已开放的登录方式', 503, 'WECHAT_NOT_CONFIGURED');
  if (typeof body.code !== 'string' || !body.code.length || body.code.length > 512 || /\s/.test(body.code))
    throw authError('微信登录凭证不正确，请重试', 400, 'INVALID_REQUEST');
  if (body.consent !== true) throw authError('请先阅读并同意资料保存说明', 400, 'INVALID_REQUEST');
  let legacyUser=null;
  if(body.transferCode!==undefined){
    if(transferAppId!==adapter.appId || body.existingAccount!==undefined)throw authError('会员接续暂不可用或提交方式冲突',400,'INVALID_REQUEST');
    legacyUser=readNativeTransfer(db,body.transferCode,adapter.appId).user;
  }
  if(body.existingAccount !== undefined){
    if(!body.existingAccount || typeof body.existingAccount!=='object' || Array.isArray(body.existingAccount))
      throw authError('原账号资料格式不正确',400,'INVALID_REQUEST');
    const username=validateCredentials(body.existingAccount);
    legacyUser=db.prepare('SELECT * FROM users WHERE username=?').get(username);
    const valid=await checkPassword(body.existingAccount.password,legacyUser?.password_hash ?? await (dummyHash ?? hashPassword(randomBytes(64).toString('hex'))));
    if(!legacyUser || !valid || legacyUser.role!=='member')throw authError('原会员账号或密码不正确',401,'INVALID_CREDENTIALS');
  }
  let identity;
  try { identity = await adapter.exchangeCode(body.code); }
  catch (error) {
    if (error instanceof BusinessError) throw error;
    throw authError('微信登录暂时不可用，请稍后重试', 503, 'WECHAT_UNAVAILABLE');
  }
  if (!identity || identity.appId !== adapter.appId || typeof identity.openId !== 'string'
    || !/^[a-zA-Z0-9_-]{1,128}$/.test(identity.openId))
    throw authError('微信登录结果不完整，请重试', 503, 'WECHAT_UNAVAILABLE');
  if (!allowsIdentity(identity)) throw authError('当前仅向受邀测试人员开放', 403, 'TRIAL_NOT_INVITED');
  // Hash outside the transaction, then recheck the identity inside it for concurrent first logins.
  const existing = db.prepare('SELECT user_id FROM wechat_identities WHERE app_id=? AND open_id=?').get(identity.appId, identity.openId);
  const passwordHash = existing || legacyUser ? null : await hashPassword(randomBytes(64).toString('hex'));
  return transaction(db, () => {
    if (!allowsIdentity(identity)) throw authError('当前仅向受邀测试人员开放', 403, 'TRIAL_NOT_INVITED');
    const linked = db.prepare('SELECT user_id FROM wechat_identities WHERE app_id=? AND open_id=?').get(identity.appId, identity.openId);
    let user;
    if(body.transferCode!==undefined)legacyUser=consumeNativeTransfer(db,body.transferCode,adapter.appId);
    if(legacyUser){
      user=db.prepare('SELECT * FROM users WHERE id=?').get(legacyUser.id);
      if(!user || user.role!=='member' || user.password_hash!==legacyUser.password_hash)
        throw authError('原账号状态已变化，请重新验证',409,'ACCOUNT_CONFLICT');
      const other=db.prepare('SELECT open_id FROM wechat_identities WHERE app_id=? AND user_id=?').get(identity.appId,user.id);
      if(linked && linked.user_id!==user.id || other && other.open_id!==identity.openId)
        throw authError('微信或原账号已有其他关联，请联系工作人员核对，不能自动合并',409,'ACCOUNT_CONFLICT');
      if(!linked){
        db.prepare('INSERT INTO wechat_identities(app_id,open_id,user_id,created_at) VALUES (?,?,?,?)').run(identity.appId,identity.openId,user.id,nowISO());
        audit(db,user.id,'account.native_wechat_linked',user.id,{appId:identity.appId});
      }
    } else if (linked) {
      user = db.prepare('SELECT * FROM users WHERE id=?').get(linked.user_id);
      if (user.role !== 'member') throw authError('小程序登录仅供会员使用', 403, 'FORBIDDEN');
      user = captureLoginReferral(db, user, body.referral);
    } else {
      // Random internal username is unrelated to OpenID; never merge by a client-supplied field.
      user = insertUser(db, `wx_${randomBytes(14).toString('hex')}`, passwordHash);
      db.prepare('INSERT INTO wechat_identities(app_id,open_id,user_id,created_at) VALUES (?,?,?,?)')
        .run(identity.appId, identity.openId, user.id, nowISO());
      captureReferral(db, user.id, body.referral ?? '');
      audit(db, user.id, 'account.wechat_registered', user.id);
      user = db.prepare('SELECT * FROM users WHERE id=?').get(user.id);
    }
    if (onAuthenticated) onAuthenticated(user.id);
    return issueSession(db, user, 'wechat');
  });
}
