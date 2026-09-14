import { createHash, randomBytes, randomUUID, scrypt, timingSafeEqual } from 'node:crypto';
import { promisify } from 'node:util';
import { audit, transaction } from './db.mjs';

const derive = promisify(scrypt);
export const plans = {
  basic: { id: 'basic', name: '基础会员', amountCents: 36500, review: false },
  star: { id: 'star', name: '星级会员', amountCents: 365000, review: false },
  organization: { id: 'organization', name: '机构及专业会员', amountCents: 3650000, review: true },
};
export class BusinessError extends Error {
  constructor(message, status = 400) { super(message); this.status = status; }
}
export function requireRule(condition, message, status = 400) {
  if (!condition) throw new BusinessError(message, status);
}
export const digest = value => createHash('sha256').update(value).digest('hex');
export const nowISO = () => new Date().toISOString();
export async function hashPassword(password) {
  const salt = randomBytes(16).toString('hex');
  const hash = await derive(password, salt, 64);
  return `${salt}:${hash.toString('hex')}`;
}
export async function checkPassword(password, encoded) {
  const [salt, expected] = encoded.split(':');
  const actual = await derive(password, salt, 64);
  return timingSafeEqual(actual, Buffer.from(expected, 'hex'));
}
export function textField(value, label, max, required = false) {
  requireRule(typeof value === 'string', `${label}格式不正确`);
  const trimmed = value.trim();
  requireRule(trimmed.length <= max && (!required || trimmed.length > 0), `请检查${label}（最多 ${max} 字）`);
  return trimmed;
}
export function validateCredentials(body) {
  requireRule(typeof body.username === 'string' && /^[a-zA-Z0-9_]{4,32}$/.test(body.username), '账号须为 4–32 位字母、数字或下划线');
  requireRule(typeof body.password === 'string' && body.password.length >= 10 && body.password.length <= 128, '密码须为 10–128 位');
  return body.username.toLowerCase();
}
export function insertUser(db, username, passwordHash, role = 'member') {
  const id = randomUUID();
  let referralCode;
  do { referralCode = randomBytes(3).toString('hex').toUpperCase(); }
  while (db.prepare('SELECT 1 FROM users WHERE referral_code=?').get(referralCode));
  db.prepare(`INSERT INTO users(id,username,password_hash,role,created_at,referral_code,consent_version)
    VALUES (?,?,?,?,?,?,?)`).run(id, username, passwordHash, role, nowISO(), referralCode, 'local-trial-v1');
  return db.prepare('SELECT * FROM users WHERE id=?').get(id);
}
export function publicUser(db, user) {
  const referrer = user.referrer_id ? db.prepare('SELECT referral_code FROM users WHERE id=?').get(user.referrer_id) : null;
  return { id: user.id, username: user.username, role: user.role, referralCode: user.referral_code,
    sourceCode: referrer?.referral_code ?? null, referralSource: user.referral_source,
    referralLockedAt: user.referral_locked_at, phoneVerified: false };
}

// First valid explicit source wins. A configured fallback never overwrites it.
// Referral capture records a relationship only; it does not establish reward eligibility.
export function captureReferral(db, userId, code = '') {
  const user = db.prepare('SELECT * FROM users WHERE id=?').get(userId);
  const normalized = textField(code, '推荐码', 6).toUpperCase();
  if (user.referral_locked_at || user.referral_source === 'explicit') return publicUser(db, user);
  const fallback = db.prepare("SELECT value FROM settings WHERE key='default_referral_code'").get()?.value;
  const candidate = normalized || (!user.referrer_id ? fallback : null);
  if (!candidate) return publicUser(db, user);
  requireRule(/^[A-Z0-9]{6}$/.test(candidate), '推荐码应为 6 位字母或数字');
  const owner = db.prepare("SELECT * FROM users WHERE referral_code=? AND role='member'").get(candidate);
  requireRule(owner, '推荐码无效，请核对或留空');
  if (!normalized && owner.id === userId) return publicUser(db, user);
  requireRule(owner.id !== userId, '不能使用自己的推荐码');
  // Prevent circular referral chains, including descendants of this user.
  const visited = new Set([userId]);
  let ancestor = owner;
  while (ancestor) {
    requireRule(!visited.has(ancestor.id), '该推荐关系存在循环，请核对来源');
    visited.add(ancestor.id);
    ancestor = ancestor.referrer_id ? db.prepare('SELECT * FROM users WHERE id=?').get(ancestor.referrer_id) : null;
  }
  const source = normalized ? 'explicit' : 'default';
  db.prepare('UPDATE users SET referrer_id=?,referral_source=?,referral_at=? WHERE id=?')
    .run(owner.id, source, nowISO(), userId);
  audit(db, userId, 'referral.captured', userId, { source, referrerId: owner.id });
  return publicUser(db, db.prepare('SELECT * FROM users WHERE id=?').get(userId));
}

export function membership(db, userId, now = nowISO()) {
  const row = db.prepare('SELECT * FROM memberships WHERE user_id=?').get(userId);
  return row ? { planId: row.plan_id, orderId: row.order_id, startsAt: row.starts_at,
    expiresAt: row.expires_at, active: row.starts_at <= now && row.expires_at > now } : null;
}
export function orderView(db, row) {
  const sourceCode = row.referrer_id ? db.prepare('SELECT referral_code FROM users WHERE id=?').get(row.referrer_id)?.referral_code : null;
  return { id: row.id, userId: row.user_id, planId: row.plan_id, amountCents: row.amount_cents,
    actualPaidCents: row.actual_paid_cents, currency: row.currency, status: row.status,
    form: JSON.parse(row.profile_json), createdAt: row.created_at, paidAt: row.paid_at,
    expiresAt: row.expires_at, reviewNote: row.review_note, reviewedAt: row.reviewed_at,
    sourceCode, referralSource: row.referral_source };
}
export function ownedOrder(db, userId, id) {
  const row = db.prepare('SELECT * FROM orders WHERE id=? AND user_id=?').get(id, userId);
  requireRule(row, '找不到这笔订单', 404);
  return row;
}
export function validateKey(key) {
  requireRule(typeof key === 'string' && /^[a-zA-Z0-9-]{12,80}$/.test(key), '缺少有效提交编号，请刷新后重试');
}
export function createOrder(db, userId, body, key) {
  validateKey(key);
  requireRule(Object.hasOwn(plans, body.planId), '请选择有效会员方案');
  requireRule(body.consent === true, '请先阅读并同意内测资料保存说明');
  const plan = plans[body.planId];
  const input = body.form ?? {};
  const form = {};
  for (const [field, label, max, required] of [
    ['name','称呼',60,true], ['phone','手机号码',11,true], ['city','所在城市',60,true],
    ['company','企业或机构名称',100,plan.review], ['industry','行业',60,false],
    ['need','跨境需求',300,false], ['organizationType','申请类型',10,plan.review],
  ]) form[field] = textField(input[field] ?? '', label, max, required);
  requireRule(/^1\d{10}$/.test(form.phone), '请填写 11 位手机号码');
  if (plan.review) requireRule(['机构会员','专业会员'].includes(form.organizationType), '请选择机构或专业会员');
  const referral = textField(input.referral ?? '', '推荐码', 6).toUpperCase();
  const requestHash = digest(JSON.stringify({ planId: plan.id, form, referral }));
  return transaction(db, () => {
    const previous = db.prepare('SELECT * FROM orders WHERE user_id=? AND idempotency_key=?').get(userId, key);
    if (previous) {
      requireRule(previous.request_hash === requestHash, '提交编号已用于其他内容，请刷新后重试', 409);
      return orderView(db, previous);
    }
    requireRule(!db.prepare('SELECT 1 FROM memberships WHERE user_id=?').get(userId), '已有会员记录，续费和升级入口将在规则核对及开发完成后开放', 409);
    requireRule(!db.prepare("SELECT 1 FROM orders WHERE user_id=? AND status IN ('pending','review')").get(userId), '你已有待处理订单，请在“我的订单”继续或取消后重选', 409);
    captureReferral(db, userId, referral);
    const user = db.prepare('SELECT * FROM users WHERE id=?').get(userId);
    const id = `HJ${randomUUID().replaceAll('-','').toUpperCase()}`;
    db.prepare(`INSERT INTO orders(id,user_id,plan_id,amount_cents,status,profile_json,created_at,
      referrer_id,referral_source,idempotency_key,request_hash) VALUES (?,?,?,?,?,?,?,?,?,?,?)`)
      .run(id, userId, plan.id, plan.amountCents, plan.review ? 'review' : 'pending', JSON.stringify(form),
        nowISO(), user.referrer_id, user.referral_source, key, requestHash);
    audit(db, userId, 'order.created', id, { planId: plan.id, amountCents: plan.amountCents });
    return orderView(db, ownedOrder(db, userId, id));
  });
}
export function cancelOrder(db, userId, id) {
  return transaction(db, () => {
    const row = ownedOrder(db, userId, id);
    if (row.status === 'cancelled') return orderView(db, row);
    requireRule(['pending','review'].includes(row.status), '当前状态不能取消', 409);
    db.prepare("UPDATE orders SET status='cancelled' WHERE id=?").run(id);
    audit(db, userId, 'order.cancelled', id);
    return orderView(db, ownedOrder(db, userId, id));
  });
}
export function reviewOrder(db, adminId, id, body) {
  requireRule(db.prepare('SELECT role FROM users WHERE id=?').get(adminId)?.role === 'admin', '需要管理员权限', 403);
  requireRule(['approve','reject'].includes(body.decision), '审核决定不正确');
  const note = textField(body.note ?? '', '审核说明', 500, true);
  return transaction(db, () => {
    const row = db.prepare('SELECT * FROM orders WHERE id=?').get(id);
    requireRule(row, '申请不存在', 404);
    requireRule(row.plan_id === 'organization' && row.status === 'review', '申请已处理，请刷新查看', 409);
    db.prepare('UPDATE orders SET status=?,reviewed_by=?,reviewed_at=?,review_note=? WHERE id=?')
      .run(body.decision === 'approve' ? 'pending' : 'rejected', adminId, nowISO(), note, id);
    audit(db, adminId, `application.${body.decision}`, id, { note });
    return orderView(db, db.prepare('SELECT * FROM orders WHERE id=?').get(id));
  });
}

// Calendar-year term in UTC; Feb 29 is clamped to Feb 28 in a non-leap year.
export function yearAfter(iso) {
  const date = new Date(iso);
  const month = date.getUTCMonth();
  date.setUTCFullYear(date.getUTCFullYear() + 1);
  if (date.getUTCMonth() !== month) date.setUTCDate(0);
  return date.toISOString();
}

// INTERNAL ONLY: future provider adapter must verify signature, decrypt and query
// the provider before calling this function. There is deliberately no HTTP success endpoint.
export function applyVerifiedPayment(db, receipt, expected, now = nowISO()) {
  requireRule(expected?.merchantId && expected?.appId, '支付商户校验配置未完成', 503);
  requireRule(receipt.merchantId === expected.merchantId && receipt.appId === expected.appId, '支付主体不匹配');
  requireRule(receipt.currency === 'CNY' && Number.isSafeInteger(receipt.amountCents) && receipt.amountCents > 0, '支付金额或币种不正确');
  requireRule(typeof receipt.transactionId === 'string' && receipt.transactionId.length >= 6 && receipt.transactionId.length <= 100, '支付流水号不正确');
  requireRule(['SUCCESS','FAILED','CANCELLED'].includes(receipt.status), '支付状态不正确');
  const parsed = Date.parse(receipt.paidAt);
  if (receipt.status === 'SUCCESS') requireRule(Number.isFinite(parsed) && parsed <= Date.parse(now) + 300000, '支付时间不正确');
  const canonical = { transactionId: receipt.transactionId, orderId: receipt.orderId, merchantId: receipt.merchantId,
    appId: receipt.appId, currency: receipt.currency, amountCents: receipt.amountCents, status: receipt.status,
    paidAt: receipt.status === 'SUCCESS' ? new Date(parsed).toISOString() : null };
  const hash = digest(JSON.stringify(canonical));
  return transaction(db, () => {
    const existing = db.prepare('SELECT * FROM payment_receipts WHERE transaction_id=?').get(receipt.transactionId);
    if (existing) {
      requireRule(existing.payload_hash === hash, '重复流水内容不一致', 409);
      return { outcome: existing.outcome, duplicate: true };
    }
    const order = db.prepare('SELECT * FROM orders WHERE id=?').get(receipt.orderId);
    requireRule(order, '订单不存在', 404);
    requireRule(receipt.amountCents === order.amount_cents, '支付金额与订单不一致');
    let outcome = 'not_paid';
    if (receipt.status === 'SUCCESS') {
      requireRule(parsed >= Date.parse(order.created_at), '支付时间早于订单');
      outcome = order.status === 'pending' && !db.prepare('SELECT 1 FROM memberships WHERE user_id=?').get(order.user_id)
        ? 'activated' : 'needs_reconciliation';
      if (outcome === 'activated') {
        const expiresAt = yearAfter(canonical.paidAt);
        // The source is frozen on the order before payment; a later fallback is never retroactively rewarded.
        db.prepare("UPDATE orders SET status='paid',actual_paid_cents=?,paid_at=?,expires_at=? WHERE id=?")
          .run(receipt.amountCents, canonical.paidAt, expiresAt, order.id);
        db.prepare('INSERT INTO memberships(user_id,order_id,plan_id,starts_at,expires_at) VALUES (?,?,?,?,?)')
          .run(order.user_id, order.id, order.plan_id, canonical.paidAt, expiresAt);
        db.prepare('UPDATE users SET referrer_id=?,referral_source=?,referral_locked_at=? WHERE id=?')
          .run(order.referrer_id, order.referral_source, now, order.user_id);
      }
    }
    db.prepare('INSERT INTO payment_receipts(transaction_id,order_id,payload_hash,received_at,outcome) VALUES (?,?,?,?,?)')
      .run(receipt.transactionId, order.id, hash, now, outcome);
    audit(db, null, `payment.${outcome}`, order.id, { transactionId: receipt.transactionId }, now);
    return { outcome, duplicate: false };
  });
}
