import { randomUUID } from 'node:crypto';
import { transaction, audit } from './db.mjs';
import { requireRule, membership, textField, validateKey, digest, nowISO } from './domain.mjs';

export function installAmbassadors(db) {
  transaction(db, () => db.exec(`CREATE TABLE IF NOT EXISTS ambassador_applications (
    seq INTEGER PRIMARY KEY AUTOINCREMENT, id TEXT NOT NULL UNIQUE, user_id TEXT NOT NULL UNIQUE REFERENCES users(id),
    contact TEXT NOT NULL, introduction TEXT NOT NULL, status TEXT NOT NULL CHECK(status IN ('pending','contacted')),
    staff_note TEXT NOT NULL DEFAULT '', created_at TEXT NOT NULL, updated_at TEXT NOT NULL,
    revision INTEGER NOT NULL DEFAULT 1, idempotency_key TEXT NOT NULL, request_hash TEXT NOT NULL
  ); INSERT OR IGNORE INTO schema_version VALUES (10);`));
}
function view(row) { if (!row) return null; const { id, contact, introduction, status, staff_note, created_at, updated_at, revision } = row; return { id, contact, introduction, status, staffNote: staff_note, createdAt: created_at, updatedAt: updated_at, revision }; }
export function ambassadorStatus(db, user) {
  requireRule(user?.role === 'member', '请使用会员账号查看推荐大使申请', 403);
  return { canApply: !!membership(db, user.id)?.active, application: view(db.prepare('SELECT * FROM ambassador_applications WHERE user_id=?').get(user.id)) };
}
export function applyAmbassador(db, user, body, key) {
  requireRule(user?.role === 'member', '请使用会员账号申请', 403);
  validateKey(key);
  requireRule(body.consent === true, '请同意保存申请信息以便联系');
  const contact = textField(body.contact, '联系微信或电话', 100, true), introduction = textField(body.introduction ?? '', '推荐意向', 500);
  const hash = digest(JSON.stringify({ contact, introduction }));
  return transaction(db, () => {
    const previous = db.prepare('SELECT * FROM ambassador_applications WHERE user_id=?').get(user.id);
    if (previous) { requireRule(previous.request_hash === hash, '已有申请，请查看办理进度', 409); return view(previous); }
    requireRule(membership(db, user.id)?.active, '有效付费会员可以申请推荐大使', 403);
    const id = randomUUID(), now = nowISO();
    db.prepare("INSERT INTO ambassador_applications(id,user_id,contact,introduction,status,created_at,updated_at,idempotency_key,request_hash) VALUES (?,?,?,?,'pending',?,?,?,?)")
      .run(id, user.id, contact, introduction, now, now, key, hash);
    audit(db, user.id, 'ambassador.applied', id, { policy: 'application-only-v1' });
    return view(db.prepare('SELECT * FROM ambassador_applications WHERE id=?').get(id));
  });
}
export function listAmbassadors(db, user, before) {
  requireRule(user?.role === 'admin', '需要管理员权限', 403);
  const cursor = before === undefined ? Number.MAX_SAFE_INTEGER : Number(before);
  requireRule(Number.isSafeInteger(cursor) && cursor > 0, '分页编号不正确');
  const rows = db.prepare('SELECT * FROM ambassador_applications WHERE seq<? ORDER BY seq DESC LIMIT 100').all(cursor);
  return { applications: rows.map(row => ({ ...view(row), userId: row.user_id })), next: rows.length === 100 ? rows.at(-1).seq : null };
}
export function followAmbassador(db, user, id, body) {
  requireRule(user?.role === 'admin', '需要管理员权限', 403);
  const note = textField(body.note, '跟进说明', 500, true);
  requireRule(Number.isSafeInteger(body.revision), '缺少记录版本');
  return transaction(db, () => {
    const row = db.prepare('SELECT * FROM ambassador_applications WHERE id=?').get(id);
    requireRule(row, '申请不存在', 404);
    if (row.status === 'contacted' && row.staff_note === note && row.revision === body.revision + 1) return view(row);
    requireRule(row.revision === body.revision, '记录已变化，请刷新后重试', 409);
    db.prepare("UPDATE ambassador_applications SET status='contacted',staff_note=?,revision=revision+1,updated_at=? WHERE id=?").run(note, nowISO(), id);
    audit(db, user.id, 'ambassador.contacted', id, { note });
    return view(db.prepare('SELECT * FROM ambassador_applications WHERE id=?').get(id));
  });
}
