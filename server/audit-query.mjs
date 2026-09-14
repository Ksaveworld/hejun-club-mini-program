import { requireRule } from './domain.mjs';

const groups = ['account', 'referral', 'order', 'application', 'payment', 'post', 'article', 'resource', 'feedback'];
const labels = { 'resource.created': '创建服务草稿', 'resource.updated': '修改服务草稿', 'resource.publish': '发布服务', 'resource.unpublish': '撤下服务', 'feedback.created': '提交帮助反馈', 'feedback.accept': '受理帮助反馈', 'feedback.followup': '用户补充问题', 'feedback.confirm': '用户确认解决', 'feedback.reply': '回复帮助反馈', 'account.registered': '注册账号', 'account.wechat_registered': '微信账号建立', 'referral.captured': '保存推荐来源',
  'order.created': '创建订单', 'order.cancelled': '取消订单', 'application.approve': '资质审核通过', 'application.reject': '资质审核驳回',
  'post.submitted': '提交文字稿', 'post.published': '投稿审核通过', 'post.rejected': '投稿审核驳回',
  'article.created': '创建内容草稿', 'article.updated': '修改内容草稿', 'article.publish': '发布内容', 'article.unpublish': '撤下内容' };
function details(row) {
  let value; try { value = JSON.parse(row.detail); } catch { return {}; }
  if (!value || typeof value !== 'object') return {};
  const result = {};
  const note = row.action.startsWith('application.') ? value.note : row.action.startsWith('post.') ? value.reason : undefined;
  if (typeof note === 'string') result.note = note.slice(0, 500);
  if ((row.action.startsWith('article.') || row.action.startsWith('resource.')) && Number.isSafeInteger(value.revision) && value.revision > 0) result.revision = value.revision;
  return result; // Do not serialize arbitrary audit payloads, payment identifiers or future secret fields.
}
export function queryAudit(db, actor, params) {
  requireRule(actor?.role === 'admin', '需要管理员权限', 403);
  for (const key of params.keys()) requireRule(['group', 'target', 'before'].includes(key) && params.getAll(key).length === 1, '查询参数不正确');
  const group = params.get('group') || 'all', target = (params.get('target') || '').trim(), before = params.get('before');
  requireRule(group === 'all' || groups.includes(group), '操作分类不正确');
  requireRule(target.length <= 80, '记录编号过长');
  requireRule(before === null || (/^[1-9]\d*$/.test(before) && Number.isSafeInteger(Number(before))), '翻页位置不正确');
  const conditions = [], values = [];
  if (group !== 'all') { conditions.push('a.action LIKE ?'); values.push(group + '.%'); }
  if (target) { conditions.push('a.target_id=?'); values.push(target); }
  if (before) { conditions.push('a.id<?'); values.push(Number(before)); }
  const rows = db.prepare(`SELECT a.id,a.action,a.target_id,a.created_at,a.detail,a.actor_id,u.username
    FROM audit_log a LEFT JOIN users u ON u.id=a.actor_id ${conditions.length ? 'WHERE ' + conditions.join(' AND ') : ''}
    ORDER BY a.id DESC LIMIT 31`).all(...values);
  const visible = rows.slice(0, 30);
  return { records: visible.map(row => ({ id: row.id, action: row.action, label: labels[row.action] || '其他操作',
    targetId: row.target_id, createdAt: row.created_at, actor: row.actor_id ? row.username || '已停用账号' : '系统', ...details(row) })),
    nextCursor: rows.length > 30 ? String(visible.at(-1).id) : null };
}
