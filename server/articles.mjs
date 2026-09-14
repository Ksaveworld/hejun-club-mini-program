import { randomUUID } from 'node:crypto';
import { documentInfo } from './article-documents.mjs';
import { audit, transaction } from './db.mjs';
import { requireRule, textField, validateKey, membership, plans, digest, nowISO } from './domain.mjs';

function accessPolicy(value = { visibility: 'unconfigured', planIds: [] }) {
  requireRule(value && typeof value === 'object' && !Array.isArray(value), '请明确内容阅读范围');
  requireRule(['unconfigured', 'public', 'plans'].includes(value.visibility), '阅读范围不正确');
  requireRule(Array.isArray(value.planIds) && value.planIds.every(id => Object.hasOwn(plans, id)), '会员档位不正确');
  const planIds = [...new Set(value.planIds)].sort();
  requireRule(value.visibility === 'plans' ? planIds.length > 0 : planIds.length === 0, '请为所选阅读范围配置对应档位');
  requireRule(value.previewPages === undefined || value.previewPages === 0 || (value.previewPages === 10 && value.visibility === 'plans'), '试看仅支持会员报告的前10页');
  return { visibility: value.visibility, planIds, ...(value.previewPages === 10 ? {previewPages:10} : {}) };
}
function content(input) {
  requireRule(input && typeof input === 'object', '内容格式不正确');
  requireRule(['news', 'knowledge'].includes(input.category), '请选择资讯或知识分类');
  return { title: textField(input.title, '标题', 80, true), summary: textField(input.summary ?? '', '摘要', 180),
    body: textField(input.body ?? '', '正文', 4000), category: input.category, access: accessPolicy(input.access) };
}
function adminView(db,row) {
  return { id: row.id, title: row.title, summary: row.summary, body: row.body, category: row.category,
    access: JSON.parse(row.access_json), status: row.status, revision: row.revision,
    createdAt: row.created_at, updatedAt: row.updated_at, publishedAt: row.published_at, document:documentInfo(db,row.id) };
}
function requireEditor(actor) { requireRule(actor?.role === 'admin', '需要内容管理权限', 403); }
function ownedRevision(db, id, revision) {
  const row = db.prepare('SELECT * FROM articles WHERE id=?').get(id);
  requireRule(row, '内容不存在', 404);
  requireRule(Number.isSafeInteger(revision) && row.revision === revision, '内容已变化，请刷新后重新操作', 409);
  return row;
}
export function listManagedArticles(db, actor) {
  requireEditor(actor);
  return db.prepare('SELECT * FROM articles ORDER BY updated_at DESC,id').all().map(row=>adminView(db,row));
}
export function createArticle(db, actor, input, key) {
  requireEditor(actor); validateKey(key);
  const fields = content(input), hash = digest(JSON.stringify(fields));
  return transaction(db, () => {
    const prior = db.prepare('SELECT * FROM articles WHERE created_by=? AND idempotency_key=?').get(actor.id, key);
    if (prior) { requireRule(prior.creation_hash === hash, '提交编号已用于其他内容', 409); return adminView(db,prior); }
    const id = randomUUID(), now = nowISO();
    db.prepare(`INSERT INTO articles(id,title,summary,body,category,access_json,status,revision,created_by,updated_by,created_at,updated_at,idempotency_key,creation_hash)
      VALUES (?,?,?,?,?,?,'draft',1,?,?,?,?,?,?)`).run(id, fields.title, fields.summary, fields.body, fields.category,
      JSON.stringify(fields.access), actor.id, actor.id, now, now, key, hash);
    audit(db, actor.id, 'article.created', id, { revision: 1, category: fields.category });
    return adminView(db,db.prepare('SELECT * FROM articles WHERE id=?').get(id));
  });
}
export function updateArticle(db, actor, id, input) {
  requireEditor(actor); const fields = content(input);
  return transaction(db, () => {
    const row = ownedRevision(db, id, input.revision);
    requireRule(row.status === 'draft', '请先撤下内容，再修改并重新发布', 409);
    if(fields.access.previewPages)requireRule(documentInfo(db,id)?.previewPages>0,'请先生成报告试看文件');
    db.prepare(`UPDATE articles SET title=?,summary=?,body=?,category=?,access_json=?,revision=revision+1,updated_by=?,updated_at=? WHERE id=?`)
      .run(fields.title, fields.summary, fields.body, fields.category, JSON.stringify(fields.access), actor.id, nowISO(), id);
    audit(db, actor.id, 'article.updated', id, { revision: row.revision + 1 });
    return adminView(db,db.prepare('SELECT * FROM articles WHERE id=?').get(id));
  });
}
export function transitionArticle(db, actor, id, action, revision) {
  requireEditor(actor); requireRule(['publish', 'unpublish'].includes(action), '操作不正确');
  return transaction(db, () => {
    const row = ownedRevision(db, id, revision);
    requireRule(row.status === (action === 'publish' ? 'draft' : 'published'), '内容状态已变化，请刷新', 409);
    if (action === 'publish') {
      requireRule(accessPolicy(JSON.parse(row.access_json)).visibility !== 'unconfigured', '请先明确阅读范围');
      requireRule(row.body.trim().length > 0, '请先填写正文');
      if(JSON.parse(row.access_json).previewPages)requireRule(documentInfo(db,id)?.previewPages>0,'报告试看文件未准备好');
    }
    const now = nowISO();
    db.prepare('UPDATE articles SET status=?,revision=revision+1,updated_by=?,updated_at=?,published_at=? WHERE id=?')
      .run(action === 'publish' ? 'published' : 'draft', actor.id, now, action === 'publish' ? now : row.published_at, id);
    audit(db, actor.id, 'article.' + action, id, { revision: row.revision + 1, access: JSON.parse(row.access_json) });
    return adminView(db,db.prepare('SELECT * FROM articles WHERE id=?').get(id));
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
function canPreview(db,row){
  if(row?.status!=='published')return false;
  try{const access=accessPolicy(JSON.parse(row.access_json));return access.visibility==='plans'&&access.previewPages===10&&documentInfo(db,row.id)?.previewPages>0;}catch{return false;}
}
export function requireFullArticle(db,actor,id){
  const row=db.prepare('SELECT * FROM articles WHERE id=?').get(id);
  requireRule(row&&canRead(row,actor,actor?membership(db,actor.id):null),'内容不存在或当前不可阅读',404);
}
export function requireArticlePreview(db,id){
  requireRule(canPreview(db,db.prepare('SELECT * FROM articles WHERE id=?').get(id)),'试看不存在或已撤下',404);
}
export function listReadableArticles(db, actor) {
  const member = actor ? membership(db, actor.id) : null;
  const rows = db.prepare("SELECT id,title,summary,category,published_at,status,access_json FROM articles WHERE status='published' ORDER BY published_at DESC,id").all()
    .filter(row => canRead(row, actor, member)||canPreview(db,row));
  return { articles: rows.slice(0, 100).map(row=>({...summary(row),fullAccess:canRead(row,actor,member),document:documentInfo(db,row.id)})), hasMore: rows.length > 100 };
}
export function readArticle(db, actor, id) {
  const row = db.prepare('SELECT * FROM articles WHERE id=?').get(id);
  const member = actor ? membership(db, actor.id) : null;
  const fullAccess=row&&canRead(row,actor,member);
  requireRule(row && (fullAccess||canPreview(db,row)), '内容不存在或当前不可阅读', 404);
  return { ...summary(row), body: fullAccess?row.body:'', fullAccess:!!fullAccess, document:documentInfo(db,row.id) };
}
