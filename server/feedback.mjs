import { randomUUID } from 'node:crypto';
import { transaction, audit } from './db.mjs';
import { requireRule, textField, validateKey, digest, nowISO } from './domain.mjs';

function view(row) {
  return { id: row.id, title: row.title, category: row.category, status: row.status, revision: row.revision,
    confirmedAt: row.confirmed_at || null, relatedOrderId: row.related_order_id || null, unread: Number(row.latest_staff_seq || 0) > row.member_read_seq, createdAt: row.created_at, updatedAt: row.updated_at };
}
function access(actor, admin) { requireRule(actor?.role === (admin ? 'admin' : 'member'), admin ? '需要管理员权限' : '请使用会员账号提交和查看反馈', 403); }
export function feedbackDetail(db, actor, id, admin = false) {
  access(actor, admin);
  const row = db.prepare("SELECT *, (SELECT MAX(seq) FROM feedback_events WHERE ticket_id=feedback_tickets.id AND author_kind='staff') latest_staff_seq FROM feedback_tickets WHERE id=?").get(id);
  requireRule(row && (admin || row.user_id === actor.id), '反馈记录不存在', 404);
  const events = db.prepare('SELECT seq,action,body,status,created_at,author_kind FROM feedback_events WHERE ticket_id=? ORDER BY seq').all(id)
    .map(event => ({ id: event.seq, authorKind: event.author_kind, action: event.action, body: event.body, status: event.status, createdAt: event.created_at }));
  return { ...view(row), body: row.body, events };
}
export function listFeedback(db, actor, admin = false, before) {
  access(actor, admin);
  requireRule(before === undefined || (/^[1-9]\d*$/.test(before) && Number.isSafeInteger(Number(before))), '翻页位置不正确');
  const where = [], values = [];
  if (!admin) { where.push('user_id=?'); values.push(actor.id); }
  if (before) { where.push('seq<?'); values.push(Number(before)); }
  const rows = db.prepare("SELECT *, (SELECT MAX(seq) FROM feedback_events WHERE ticket_id=feedback_tickets.id AND author_kind='staff') latest_staff_seq FROM feedback_tickets" + (where.length ? ' WHERE ' + where.join(' AND ') : '') + ' ORDER BY seq DESC LIMIT 31').all(...values);
  return { tickets: rows.slice(0, 30).map(view), nextCursor: rows.length > 30 ? String(rows[29].seq) : null };
}
export function createFeedback(db, actor, input, key) {
  access(actor, false); validateKey(key);
  const title = textField(input.title, '问题标题', 60, true), body = textField(input.body, '问题描述', 2000, true);
  requireRule(['account', 'order', 'content', 'other'].includes(input.category), '反馈分类不正确');
  const relatedOrderId = input.relatedOrderId || null;
  if (relatedOrderId) requireRule(typeof relatedOrderId === 'string' && db.prepare('SELECT id FROM orders WHERE id=? AND user_id=?').get(relatedOrderId, actor.id), '关联订单不存在', 404);
  const hash = digest(JSON.stringify({ title, body, category: input.category, ...(relatedOrderId ? {relatedOrderId} : {}) }));
  return transaction(db, () => {
    const prior = db.prepare('SELECT id,request_hash FROM feedback_tickets WHERE user_id=? AND idempotency_key=?').get(actor.id, key);
    if (prior) { requireRule(prior.request_hash === hash, '提交编号已用于其他反馈', 409); return feedbackDetail(db, actor, prior.id); }
    const id = randomUUID(), now = nowISO();
    db.prepare("INSERT INTO feedback_tickets(id,user_id,title,body,category,status,revision,created_at,updated_at,idempotency_key,request_hash) VALUES (?,?,?,?,?,'open',1,?,?,?,?)")
      .run(id, actor.id, title, body, input.category, now, now, key, hash);
    if (relatedOrderId) db.prepare('UPDATE feedback_tickets SET related_order_id=? WHERE id=?').run(relatedOrderId,id);
    audit(db, actor.id, 'feedback.created', id, { category: input.category });
    return feedbackDetail(db, actor, id);
  });
}
export function handleFeedback(db, actor, id, action, input, key) {
  access(actor, true); validateKey(key); requireRule(['accept', 'reply'].includes(action), '反馈操作不正确');
  const body = action === 'reply' ? textField(input.body, '回复内容', 2000, true) : '';
  const status = action === 'accept' ? 'processing' : input.status;
  requireRule(['processing', 'resolved'].includes(status), '反馈状态不正确');
  requireRule(Number.isSafeInteger(input.revision) && input.revision > 0, '反馈版本不正确');
  const hash = digest(JSON.stringify({ id, action, body, status, revision: input.revision }));
  return transaction(db, () => {
    const prior = db.prepare('SELECT ticket_id,request_hash FROM feedback_events WHERE actor_id=? AND idempotency_key=?').get(actor.id, key);
    if (prior) { requireRule(prior.request_hash === hash, '操作编号已用于其他回复', 409); return feedbackDetail(db, actor, prior.ticket_id, true); }
    const ticket = feedbackDetail(db, actor, id, true);
    requireRule(ticket.revision === input.revision, '反馈已有新处理，请刷新后核对', 409);
    requireRule(ticket.status !== 'resolved' && (action !== 'accept' || ticket.status === 'open'), '当前状态不能执行此操作', 409);
    const now = nowISO();
    db.prepare('INSERT INTO feedback_events(ticket_id,actor_id,action,body,status,created_at,idempotency_key,request_hash) VALUES (?,?,?,?,?,?,?,?)')
      .run(id, actor.id, action, body, status, now, key, hash);
    db.prepare('UPDATE feedback_tickets SET status=?,revision=revision+1,updated_at=? WHERE id=?').run(status, now, id);
    audit(db, actor.id, 'feedback.' + action, id, { revision: ticket.revision + 1, status });
    return feedbackDetail(db, actor, id, true);
  });
}

export function feedbackSummary(db, actor) {
  access(actor, false);
  return { unreadCount: db.prepare("SELECT COUNT(*) n FROM feedback_tickets t WHERE user_id=? AND EXISTS(SELECT 1 FROM feedback_events e WHERE e.ticket_id=t.id AND e.author_kind='staff' AND e.seq>t.member_read_seq)").get(actor.id).n };
}
export function markFeedbackRead(db, actor, id, input) {
  access(actor, false); feedbackDetail(db, actor, id);
  requireRule(Number.isSafeInteger(input.eventId) && input.eventId >= 0, '阅读位置不正确');
  if(input.eventId) requireRule(db.prepare('SELECT seq FROM feedback_events WHERE ticket_id=? AND seq=?').get(id,input.eventId),'阅读位置不正确');
  db.prepare('UPDATE feedback_tickets SET member_read_seq=MAX(member_read_seq,?) WHERE id=? AND user_id=?').run(input.eventId,id,actor.id);
  return {ok:true};
}
export function memberFeedbackAction(db, actor, id, action, input, key) {
  access(actor,false); validateKey(key); requireRule(['followup','confirm'].includes(action),'反馈操作不正确');
  const body = action==='confirm' ? '我确认问题已解决。' : textField(input.body,'补充说明',2000,true);
  requireRule(Number.isSafeInteger(input.revision) && input.revision>0,'反馈版本不正确');
  const hash=digest(JSON.stringify({id,action,body,revision:input.revision}));
  return transaction(db,()=>{
    const previous=db.prepare('SELECT ticket_id,request_hash FROM feedback_events WHERE actor_id=? AND idempotency_key=?').get(actor.id,key);
    if(previous){requireRule(previous.request_hash===hash,'操作编号已用于其他内容',409);return feedbackDetail(db,actor,previous.ticket_id);}
    const ticket=feedbackDetail(db,actor,id);
    requireRule(ticket.revision===input.revision,'反馈已有新处理，请刷新后核对',409);
    requireRule(!ticket.confirmedAt && (action!=='confirm'||ticket.status==='resolved'),'当前状态不能执行此操作',409);
    const status=action==='confirm'?'resolved':'processing', now=nowISO();
    db.prepare("INSERT INTO feedback_events(ticket_id,actor_id,action,body,status,created_at,idempotency_key,request_hash,author_kind) VALUES (?,?,'reply',?,?,?,?,?,?)").run(id,actor.id,body,status,now,key,hash,'member_'+action);
    db.prepare('UPDATE feedback_tickets SET status=?,revision=revision+1,updated_at=?,confirmed_at=? WHERE id=?').run(status,now,action==='confirm'?now:null,id);
    audit(db,actor.id,'feedback.'+action,id,{status,revision:ticket.revision+1});
    return feedbackDetail(db,actor,id);
  });
}
