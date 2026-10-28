import { readFileSync } from 'node:fs';
import { randomUUID } from 'node:crypto';
import { requireRule, digest, validateKey, nowISO } from './domain.mjs';
import { campaignState } from './campaign.mjs';
import { transaction, audit } from './db.mjs';

export const surveys = JSON.parse(readFileSync(new URL('../miniprogram/data/surveys.json', import.meta.url), 'utf8'));
export function surveyOpen(schema, now=Date.now()) { return schema.enabled !== false && (!schema.campaignBound || campaignState(now).active); }
export function installSurveys(db) {
  transaction(db, () => {
    db.exec(`CREATE TABLE IF NOT EXISTS survey_submissions (
      seq INTEGER PRIMARY KEY AUTOINCREMENT, id TEXT NOT NULL UNIQUE,
      survey_id TEXT NOT NULL, version TEXT NOT NULL, answers_json TEXT NOT NULL,
      submitted_at TEXT NOT NULL, idempotency_key TEXT NOT NULL UNIQUE, request_hash TEXT NOT NULL
    ); INSERT OR IGNORE INTO schema_version VALUES (9);`);
  });
}
export function prepareSurvey(side, body, key) {
  requireRule(Object.hasOwn(surveys, side), '问卷不存在', 404);
  validateKey(key);
  const schema = surveys[side];
  requireRule(surveyOpen(schema), '本次活动问卷已结束，感谢关注', 410);
  requireRule(body.version === schema.version, '问卷已更新，请刷新后核对内容', 409);
  requireRule(body.consent === true, '请同意将信息用于对接撮合与活动安排');
  requireRule(body.answers && typeof body.answers === 'object' && !Array.isArray(body.answers), '问卷格式不正确');
  const answers = {};
  for (const field of schema.fields) {
    const value = body.answers[field.id] ?? (field.type === 'multi' ? [] : '');
    if (field.type === 'multi') {
      requireRule(Array.isArray(value) && value.length <= field.options.length && value.every(v => field.options.includes(v)), `请检查第${field.number}题选项`);
      answers[field.id] = [...new Set(value)];
    } else {
      requireRule(typeof value === 'string' && value.length <= 3000, `请检查第${field.number}题（最多3000字）`);
      answers[field.id] = value.trim();
      if (field.type === 'single' && value) requireRule(field.options.includes(value), `请检查第${field.number}题选项`);
    }
    requireRule(!field.required || answers[field.id].length > 0, `请填写第${field.number}题：${field.label}`);
    const note = body.answers[field.id + 'Note'] ?? '';
    requireRule(typeof note === 'string' && note.length <= 1000, `第${field.number}题补充说明最多1000字`);
    if (note.trim()) answers[field.id + 'Note'] = note.trim();
  }
  if(schema.emailField)requireRule(/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(answers[schema.emailField]), '请填写有效邮箱');
  for(const field of schema.fields.filter(f=>f.type==='tel' && answers[f.id]))requireRule(/^\+?[0-9 ()-]{6,24}$/.test(answers[field.id]) && answers[field.id].replace(/\D/g,'').length>=6, '请填写有效手机号，可包含国际区号');
  requireRule(!schema.requireAnswer || Object.values(answers).some(v=>v.length>0), '请至少填写一项反馈后提交');
  const hash = digest(JSON.stringify({ side, version: schema.version, answers }));
  return { schema, answers, hash };
}
export function submitSurvey(db, side, body, key, onCreated) {
  const {schema,answers,hash}=prepareSurvey(side,body,key);
  return transaction(db, () => {
    const previous = db.prepare('SELECT id,request_hash FROM survey_submissions WHERE idempotency_key=?').get(key);
    if (previous) {
      requireRule(previous.request_hash === hash, '本次提交内容已变化，请生成新的提交记录', 409);
      return { id: previous.id, duplicate: true };
    }
    const id = randomUUID();
    db.prepare('INSERT INTO survey_submissions(id,survey_id,version,answers_json,submitted_at,idempotency_key,request_hash) VALUES (?,?,?,?,?,?,?)')
      .run(id, side, schema.version, JSON.stringify(answers), nowISO(), key, hash);
    if(onCreated)onCreated(id);
    audit(db, null, 'survey.submitted', id, { side, version: schema.version });
    return { id, duplicate: false };
  });
}
export function listSurveys(db, user, before, side) {
  requireRule(user?.role === 'admin', '需要管理员权限', 403);
  const cursor = before === undefined ? Number.MAX_SAFE_INTEGER : Number(before);
  requireRule(Number.isSafeInteger(cursor) && cursor > 0, '分页编号不正确');
  requireRule(!side || Object.hasOwn(surveys, side), '问卷不存在', 404);
  const rows = db.prepare('SELECT seq,id,survey_id,version,answers_json,submitted_at FROM survey_submissions WHERE seq<? AND (? IS NULL OR survey_id=?) ORDER BY seq DESC LIMIT 100').all(cursor,side||null,side||null);
  audit(db, user.id, 'survey.exported', 'survey', { count: rows.length });
  return { submissions: rows.map(({ answers_json, ...row }) => ({ ...row, answers: JSON.parse(answers_json) })), schemas: surveys, next: rows.length === 100 ? rows.at(-1).seq : null };
}
