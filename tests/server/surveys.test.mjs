import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { openDatabase } from '../../server/db.mjs';
import { insertUser } from '../../server/domain.mjs';
import { surveys, installSurveys, submitSurvey, listSurveys } from '../../server/surveys.mjs';

function fixture(t) { const db = openDatabase(':memory:'); installSurveys(db); t.after(() => db.close()); return db; }
function body(side) {
  const s = surveys[side], answers = {};
  for (const f of s.fields) if (f.required) answers[f.id] = f.type === 'multi' ? [f.options[0]] : f.type === 'single' ? f.options[0] : '隔离测试';
  answers.q9 = 'isolated@example.test';
  return { version: s.version, consent: true, answers };
}
test('source questionnaire completeness and repeat-safe saving for both sides', t => {
  const db = fixture(t);
  assert.equal(surveys.supply.fields.length, 45); assert.equal(surveys.demand.fields.length, 18);
  for (const side of ['supply', 'demand']) {
    const key = randomUUID(), input = body(side), saved = submitSurvey(db, side, input, key);
    assert.equal(submitSurvey(db, side, input, key).id, saved.id);
    input.answers.q1 = '内容变化';
    assert.throws(() => submitSurvey(db, side, input, key), /内容已变化/);
  }
  installSurveys(db);
  assert.equal(db.prepare('SELECT count(*) n FROM survey_submissions').get().n, 2);
});
test('required fields, consent, version and injected options fail without saving', t => {
  const db = fixture(t), input = body('demand');
  for (const bad of [{ ...input, consent: false }, { ...input, version: 'old' }, { ...input, answers: {} },
    { ...input, answers: { ...input.answers, q10: ['invalid option'] } }, { ...input, answers: { ...input.answers, q9: 'not an email' } }]) {
    assert.throws(() => submitSurvey(db, 'demand', bad, randomUUID()));
  }
  assert.equal(db.prepare('SELECT count(*) n FROM survey_submissions').get().n, 0);
});
test('only administrators can export contact data and export is audited', t => {
  const db = fixture(t), member = insertUser(db, 'survey_member', 'unused'), admin = insertUser(db, 'survey_admin', 'unused', 'admin');
  submitSurvey(db, 'demand', body('demand'), randomUUID());
  assert.throws(() => listSurveys(db, null), /管理员/);
  assert.throws(() => listSurveys(db, member), /管理员/);
  assert.throws(() => listSurveys(db, admin, '-1'), /分页/);
  const result = listSurveys(db, admin);
  assert.equal(result.submissions[0].answers.q9, 'isolated@example.test');
  assert.equal(result.next, null);
  assert.equal(db.prepare("SELECT count(*) n FROM audit_log WHERE action='survey.exported'").get().n, 1);
});
