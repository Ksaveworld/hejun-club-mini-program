import { randomUUID } from 'node:crypto';
import { transaction, audit } from './db.mjs';
import { requireRule, membership, textField, validateKey, nowISO } from './domain.mjs';

export function publishMemberPost(db, user, body, key) {
  requireRule(user?.role === 'member' && membership(db, user.id)?.active, '开通且在有效期内的会员才能投稿', 403);
  validateKey(key);
  const title = textField(body.title, '标题', 60, true), content = textField(body.body, '正文', 2000, true);
  return transaction(db, () => {
    const previous = db.prepare('SELECT * FROM posts WHERE user_id=? AND idempotency_key=?').get(user.id, key);
    if (previous) {
      requireRule(previous.title === title && previous.body === content, '提交编号已用于其他内容', 409);
      return previous; // A repeated client request must never republish a removed post.
    }
    const id = randomUUID();
    db.prepare("INSERT INTO posts(id,user_id,title,body,status,created_at,idempotency_key) VALUES (?,?,?,?,'published',?,?)")
      .run(id, user.id, title, content, nowISO(), key);
    audit(db, user.id, 'post.published', id, { policy: 'member-direct-v1' });
    return db.prepare('SELECT * FROM posts WHERE id=?').get(id);
  });
}
export function moderateMemberPost(db, user, id, body) {
  requireRule(user?.role === 'admin', '需要管理员权限', 403);
  requireRule(['published', 'rejected'].includes(body.status), '审核状态不正确');
  const reason = textField(body.reason ?? '', '审核说明', 500, body.status === 'rejected');
  return transaction(db, () => {
    const post = db.prepare('SELECT * FROM posts WHERE id=?').get(id);
    requireRule(post, '投稿不存在', 404);
    if (post.status === body.status && (post.reason || '') === reason) return { ok: true };
    requireRule(post.status === 'pending' || (post.status === 'published' && body.status === 'rejected'), '稿件状态已变化，请刷新查看', 409);
    db.prepare('UPDATE posts SET status=?,reason=?,reviewed_by=?,reviewed_at=? WHERE id=?').run(body.status, reason, user.id, nowISO(), id);
    audit(db, user.id, body.status === 'rejected' ? 'post.removed' : 'post.published', id, { reason });
    return { ok: true };
  });
}
