import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, existsSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve, sep, basename } from 'node:path';
import { randomUUID } from 'node:crypto';
import { DatabaseSync } from 'node:sqlite';
import { openDatabase } from '../../server/db.mjs';
import { insertUser, createOrder, cancelOrder } from '../../server/domain.mjs';
import { createBackup, verifyBackup, inspectDatabase } from '../../scripts/backup.mjs';
import { installSurveys } from '../../server/surveys.mjs';
import { installAmbassadors } from '../../server/ambassadors.mjs';

function directory(t) {
  const path = mkdtempSync(join(tmpdir(), 'club-backup-'));
  t.after(() => {
    const target = resolve(path);
    assert.ok(target.startsWith(resolve(tmpdir()) + sep) && basename(target).startsWith('club-backup-'));
    rmSync(target, { recursive: true, force: true });
  });
  return path;
}

test('a live WAL database can be backed up and restored without replacing the running data', t => {
  const root = directory(t), path = join(root, 'live.sqlite');
  const db = openDatabase(path);
  try {
    const user = insertUser(db, 'backupmember', 'unused-test-hash');
    const order = createOrder(db, user.id, { planId: 'basic', consent: true, form: { name: '隔离备份测试', phone: '13800000000', city: '虚构城市' } }, randomUUID());
    const backup = createBackup({ sourcePath: path, outputRoot: join(root, 'backups') });
    assert.equal(backup.counts.orders, 1); assert.equal(backup.counts.memberships, 0);
    cancelOrder(db, user.id, order.id);
    const restored = verifyBackup({ backupPath: backup.backupPath, restoreRoot: join(root, 'checks') });
    assert.notEqual(restored.restoredPath, path); assert.notEqual(restored.restoredPath, backup.backupPath);
    assert.equal(restored.writableTransactionRolledBack, true);
    assert.equal(restored.contentDigest, backup.contentDigest);
    assert.equal(inspectDatabase(backup.backupPath).contentDigest, backup.contentDigest);
    const copy = new DatabaseSync(restored.restoredPath, { readOnly: true });
    try {
      assert.equal(copy.prepare('SELECT status FROM orders WHERE id=?').get(order.id).status, 'pending');
      assert.equal(copy.prepare("SELECT COUNT(*) n FROM sqlite_master WHERE name='__restore_write_probe'").get().n, 0);
    } finally { copy.close(); }
    assert.equal(db.prepare('SELECT status FROM orders WHERE id=?').get(order.id).status, 'cancelled');
  } finally { db.close(); }
});

test('missing source never creates an empty database or a misleading backup directory', t => {
  const root = directory(t), missing = join(root, 'missing.sqlite'), outputRoot = join(root, 'backups');
  assert.throws(() => createBackup({ sourcePath: missing, outputRoot }), /不存在/);
  assert.equal(existsSync(missing), false); assert.equal(existsSync(outputRoot), false);
});

test('survey and ambassador data participate in backup restore verification and missing tables are rejected', t => {
  const root = directory(t), path = join(root, 'new-tables.sqlite'), db = openDatabase(path);
  try {
    installSurveys(db); installAmbassadors(db);
    const user = insertUser(db, 'backupnewmember', 'unused-test-hash');
    db.prepare('INSERT INTO survey_submissions(id,survey_id,version,answers_json,submitted_at,idempotency_key,request_hash) VALUES (?,?,?,?,?,?,?)')
      .run('survey-test','demand','test','{"q1":"test"}',new Date().toISOString(),'survey-key','test');
    db.prepare("INSERT INTO ambassador_applications(id,user_id,contact,introduction,status,created_at,updated_at,idempotency_key,request_hash) VALUES (?,?,?,?,'pending',?,?,?,?)")
      .run('ambassador-test',user.id,'test-contact','test',new Date().toISOString(),new Date().toISOString(),'ambassador-key','test');
    const backup = createBackup({ sourcePath: path, outputRoot: join(root, 'backups') });
    assert.equal(backup.counts.survey_submissions, 1); assert.equal(backup.counts.ambassador_applications, 1);
    assert.equal(verifyBackup({ backupPath: backup.backupPath, restoreRoot: join(root, 'restore') }).contentDigest, backup.contentDigest);
    db.exec("UPDATE ambassador_applications SET contact='changed'");
    assert.notEqual(inspectDatabase(path).contentDigest, backup.contentDigest);
    db.exec('DROP TABLE ambassador_applications');
    assert.throws(() => inspectDatabase(path), /新增业务数据表缺失/);
  } finally { db.close(); }
});

test('a corrupt backup is rejected before creating a restore directory', t => {
  const root = directory(t), backupPath = join(root, 'corrupt.sqlite'), restoreRoot = join(root, 'checks');
  writeFileSync(backupPath, 'not a SQLite database', 'utf8');
  assert.throws(() => verifyBackup({ backupPath, restoreRoot }));
  assert.equal(existsSync(restoreRoot), false);
});
