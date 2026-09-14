import { randomUUID } from 'node:crypto';
import { audit, transaction } from './db.mjs';
import { requireRule, textField, validateKey, membership, plans, digest, nowISO } from './domain.mjs';

function accessPolicy(value = { visibility: 'unconfigured', planIds: [] }) {
  requireRule(value && typeof value === 'object' && !Array.isArray(value), '请明确服务使用范围');
  requireRule(['unconfigured', 'public', 'plans'].includes(value.visibility), '使用范围不正确');
  requireRule(Array.isArray(value.planIds) && value.planIds.every(id => Object.hasOwn(plans, id)), '会员档位不正确');
  const planIds = [...new Set(value.planIds)].sort();
  requireRule(value.visibility === 'plans' ? planIds.length > 0 : planIds.length === 0, '请为所选使用范围配置对应档位');
  return { visibility: value.visibility, planIds };
}
function resourceAction(value = { type: 'unconfigured' }) {
  requireRule(value && typeof value === 'object' && !Array.isArray(value), '使用入口格式不正确');
  requireRule(['unconfigured','miniProgram','phone'].includes(value.type), '请选择使用入口类型');
  if (value.type === 'unconfigured') return { type: value.type };
  if (value.type === 'phone') {
    const phoneNumber = textField(value.phoneNumber, '服务电话', 24, true);
    requireRule(/^\+?[0-9][0-9 -]{4,22}[0-9]$/.test(phoneNumber), '服务电话格式不正确');
    return { type: value.type, phoneNumber };
  }
  const appId = textField(value.appId, '目标小程序 AppID', 18, true);
  requireRule(/^wx[a-f0-9]{16}$/.test(appId), '目标小程序 AppID 格式不正确');
  const path = textField(value.path ?? '', '小程序页面路径', 1024);
  requireRule(!path || (/^\/?[a-zA-Z0-9_-]+(?:\/[a-zA-Z0-9_-]+)*(?:\?[^\s#]*)?$/.test(path) && !/[\x00-\x1f\x7f]/.test(path)), '请填写小程序内部页面路径');
  return { type: value.type, appId, path };
}

function content(input) {
  requireRule(input && typeof input === 'object', '服务格式不正确');
  requireRule(['translation', 'lectures', 'directory', 'visits'].includes(input.category), '请选择服务分类');
  return { title: textField(input.title, '标题', 80, true), summary: textField(input.summary ?? '', '摘要', 180),
    body: textField(input.body ?? '', '正文', 4000), category: input.category, access: accessPolicy(input.access), action: resourceAction(input.action) };
}
function adminView(row) {
  return { id: row.id, title: row.title, summary: row.summary, body: row.body, category: row.category,
    action: JSON.parse(row.action_json), access: JSON.parse(row.access_json), status: row.status, revision: row.revision,
    createdAt: row.created_at, updatedAt: row.updated_at, publishedAt: row.published_at };
}
function requireEditor(actor) { requireRule(actor?.role === 'admin', '需要服务管理权限', 403); }
function ownedRevision(db, id, revision) {
  const row = db.prepare('SELECT * FROM service_resources WHERE id=?').get(id);
  requireRule(row, '服务不存在', 404);
  requireRule(Number.isSafeInteger(revision) && row.revision === revision, '服务已变化，请刷新后重新操作', 409);
  return row;
}
export function listManagedResources(db, actor) {
  requireEditor(actor);
  return db.prepare('SELECT * FROM service_resources ORDER BY updated_at DESC,id').all().map(adminView);
}
export function createResource(db, actor, input, key) {
  requireEditor(actor); validateKey(key);
  const fields = content(input), hash = digest(JSON.stringify(fields));
  return transaction(db, () => {
    const prior = db.prepare('SELECT * FROM service_resources WHERE created_by=? AND idempotency_key=?').get(actor.id, key);
    if (prior) { requireRule(prior.creation_hash === hash, '提交编号已用于其他服务', 409); return adminView(prior); }
    const id = randomUUID(), now = nowISO();
    db.prepare(`INSERT INTO service_resources(id,title,summary,body,category,access_json,action_json,status,revision,created_by,updated_by,created_at,updated_at,idempotency_key,creation_hash)
      VALUES (?,?,?,?,?,?,?,'draft',1,?,?,?,?,?,?)`).run(id, fields.title, fields.summary, fields.body, fields.category,
      JSON.stringify(fields.access), JSON.stringify(fields.action), actor.id, actor.id, now, now, key, hash);
    audit(db, actor.id, 'resource.created', id, { revision: 1, category: fields.category });
    return adminView(db.prepare('SELECT * FROM service_resources WHERE id=?').get(id));
  });
}
export function updateResource(db, actor, id, input) {
  requireEditor(actor); const fields = content(input);
  return transaction(db, () => {
    const row = ownedRevision(db, id, input.revision);
    requireRule(row.status === 'draft', '请先撤下服务，再修改并重新发布', 409);
    db.prepare(`UPDATE service_resources SET title=?,summary=?,body=?,category=?,access_json=?,action_json=?,revision=revision+1,updated_by=?,updated_at=? WHERE id=?`)
      .run(fields.title, fields.summary, fields.body, fields.category, JSON.stringify(fields.access), JSON.stringify(fields.action), actor.id, nowISO(), id);
    audit(db, actor.id, 'resource.updated', id, { revision: row.revision + 1 });
    return adminView(db.prepare('SELECT * FROM service_resources WHERE id=?').get(id));
  });
}
export function transitionResource(db, actor, id, action, revision) {
  requireEditor(actor); requireRule(['publish', 'unpublish'].includes(action), '操作不正确');
  return transaction(db, () => {
    const row = ownedRevision(db, id, revision);
    requireRule(row.status === (action === 'publish' ? 'draft' : 'published'), '服务状态已变化，请刷新', 409);
    if (action === 'publish') {
      requireRule(accessPolicy(JSON.parse(row.access_json)).visibility !== 'unconfigured', '请先明确使用范围');
      requireRule(row.body.trim().length > 0, '请先填写服务说明');
      requireRule(resourceAction(JSON.parse(row.action_json)).type !== 'unconfigured', '请先配置使用入口');
    }
    const now = nowISO();
    db.prepare('UPDATE service_resources SET status=?,revision=revision+1,updated_by=?,updated_at=?,published_at=? WHERE id=?')
      .run(action === 'publish' ? 'published' : 'draft', actor.id, now, action === 'publish' ? now : row.published_at, id);
    audit(db, actor.id, 'resource.' + action, id, { revision: row.revision + 1, access: JSON.parse(row.access_json) });
    return adminView(db.prepare('SELECT * FROM service_resources WHERE id=?').get(id));
  });
}
function canRead(row, actor, member) {
  if (row.status !== 'published') return false;
  let access;
  try { access = accessPolicy(JSON.parse(row.access_json)); } catch { return false; }
  return access.visibility === 'public' || (access.visibility === 'plans' && actor?.role === 'member'
    && member?.active && access.planIds.includes(member.planId));
}
function summary(row) {
  return { id: row.id, title: row.title, summary: row.summary, category: row.category, publishedAt: row.published_at };
}
export function listReadableResources(db, actor) {
  const member = actor ? membership(db, actor.id) : null;
  const rows = db.prepare("SELECT id,title,summary,category,published_at,status,access_json FROM service_resources WHERE status='published' ORDER BY published_at DESC,id").all()
    .filter(row => canRead(row, actor, member));
  return { resources: rows.slice(0, 100).map(summary), hasMore: rows.length > 100 };
}
export function readResource(db, actor, id) {
  const row = db.prepare('SELECT * FROM service_resources WHERE id=?').get(id);
  const member = actor ? membership(db, actor.id) : null;
  requireRule(row && canRead(row, actor, member), '服务不存在或当前不可使用', 404);
  return { ...summary(row), body: row.body, action: JSON.parse(row.action_json), revision: row.revision };
}
