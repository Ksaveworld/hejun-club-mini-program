import {verifyReportFile} from './import-reports.mjs';
import { resolve, join, dirname } from 'node:path';
import { mkdirSync, existsSync, lstatSync, mkdtempSync, copyFileSync, constants, writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { createHash, randomUUID } from 'node:crypto';
import { DatabaseSync } from 'node:sqlite';

const tables = { survey_submissions:'seq', ambassador_applications:'seq', activities:'id', report_previews:'article_id', article_documents: 'article_id', schema_version: 'version', users: 'id', sessions: 'token_hash', native_sessions: 'token_hash',
  wechat_identities: 'app_id,open_id', settings: 'key', orders: 'id', memberships: 'user_id',
  payment_receipts: 'transaction_id', posts: 'id', audit_log: 'id', articles: 'id', service_resources: 'id', feedback_tickets: 'seq', feedback_events: 'seq' };
function existingFile(path) {
  const file = resolve(path);
  if (!existsSync(file) || !lstatSync(file).isFile()) throw new Error('数据库文件不存在或不是普通文件');
  return file;
}
export function inspectDatabase(path) {
  const db = new DatabaseSync(existingFile(path), { readOnly: true });
  try {
    if (db.prepare('PRAGMA integrity_check').all().some(row => row.integrity_check !== 'ok')) throw new Error('数据库完整性检查失败');
    if (db.prepare('PRAGMA foreign_key_check').all().length) throw new Error('数据库关联关系检查失败');
    const counts = {}, digest = createHash('sha256');
    for (const [table, order] of Object.entries(tables)) {
      const introduced = { survey_submissions: 9, ambassador_applications: 10 }[table];
      if (introduced && !db.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name=?").get(table)) {
        if (db.prepare('SELECT MAX(version) version FROM schema_version').get().version >= introduced) throw new Error('新增业务数据表缺失：' + table);
        continue;
      }
      if(table==='activities'&&!db.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name='activities'").get()){if(db.prepare('SELECT MAX(version) version FROM schema_version').get().version>=8)throw new Error('活动表缺失');continue;}
      if(table==='report_previews'&&!db.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name='report_previews'").get()){if(db.prepare('SELECT MAX(version) version FROM schema_version').get().version>=7)throw new Error('报告试看表缺失');continue;}
      if(table==='article_documents'&&!db.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name='article_documents'").get()){if(db.prepare('SELECT MAX(version) version FROM schema_version').get().version>=6)throw new Error('报告附件表缺失');continue;}
      if (table === 'service_resources' && !db.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name='service_resources'").get()) {
        if (db.prepare('SELECT MAX(version) version FROM schema_version').get().version >= 5) throw new Error('服务资源数据表缺失');
        continue;
      }
      if (table === 'articles' && !db.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name='articles'").get()) {
        if (db.prepare('SELECT MAX(version) version FROM schema_version').get().version >= 2) throw new Error('内容数据表缺失');
        continue; // Older snapshots predate the additive content migration.
      }
      if (table.startsWith('feedback_') && !db.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name=?").get(table)) {
        if (db.prepare('SELECT MAX(version) version FROM schema_version').get().version >= 3) throw new Error('反馈数据表缺失');
        continue;
      }
      if (table.startsWith('feedback_') && db.prepare('SELECT MAX(version) version FROM schema_version').get().version >= 4) {
        const required = table === 'feedback_tickets' ? ['member_read_seq','confirmed_at','related_order_id'] : ['author_kind'];
        const columns = new Set(db.prepare('PRAGMA table_info(' + table + ')').all().map(row => row.name));
        if (required.some(column => !columns.has(column))) throw new Error('反馈跟进字段缺失');
      }
      counts[table] = 0; digest.update(table + '\n');
      for (const row of db.prepare(`SELECT * FROM ${table} ORDER BY ${order}`).iterate()) {
        counts[table]++; digest.update(JSON.stringify(row) + '\n');
      }
    }
    return { counts, contentDigest: digest.digest('hex') };
  } finally { db.close(); }
}

function reportFiles(path){const db=new DatabaseSync(path,{readOnly:true});try{const files=[];for(const table of ['article_documents','report_previews'])if(db.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name=?").get(table))files.push(...db.prepare('SELECT sha256,byte_size AS bytes FROM '+table).all());return files;}finally{db.close();}}
export function createBackup({ sourcePath, outputRoot, documentsRoot }) {
  const source = existingFile(sourcePath), directory = resolve(outputRoot);
  mkdirSync(directory, { recursive: true });
  const backupPath = join(directory, 'club-' + new Date().toISOString().replace(/[:.]/g, '-') + '-' + randomUUID() + '.sqlite');
  const db = new DatabaseSync(source, { readOnly: true });
  try { db.prepare('VACUUM INTO ?').run(backupPath); } finally { db.close(); }
  const result = { createdAt: new Date().toISOString(), sourcePath: source, backupPath, ...inspectDatabase(backupPath) };
  const files=reportFiles(backupPath);
  if(files.length){const target=backupPath+'.files';mkdirSync(target,{mode:0o700});for(const file of files){const source=join(documentsRoot||join(dirname(sourcePath),'report-files'),file.sha256+'.pdf');verifyReportFile(source,file);copyFileSync(source,join(target,file.sha256+'.pdf'),constants.COPYFILE_EXCL);}result.documentCount=files.length;}
  writeFileSync(backupPath + '.json', JSON.stringify(result, null, 2) + '\n', { encoding: 'utf8', flag: 'wx', mode: 0o600 });
  return result;
}
export function verifyBackup({ backupPath, restoreRoot }) {
  const source = existingFile(backupPath), expected = inspectDatabase(source);
  const directory = resolve(restoreRoot);
  mkdirSync(directory, { recursive: true });
  const restoreDirectory = mkdtempSync(join(directory, 'restore-'));
  const restoredPath = join(restoreDirectory, 'club.sqlite');
  copyFileSync(source, restoredPath, constants.COPYFILE_EXCL);
  const restored = new DatabaseSync(restoredPath);
  try {
    // Prove that the restored copy accepts a transaction without retaining fake business records.
    restored.exec('BEGIN IMMEDIATE');
    try { restored.exec('CREATE TABLE __restore_write_probe (value INTEGER); INSERT INTO __restore_write_probe VALUES (1);'); }
    finally { restored.exec('ROLLBACK'); }
  } finally { restored.close(); }
  const files=reportFiles(restoredPath);if(files.length){const directory=join(restoreDirectory,'report-files');mkdirSync(directory,{mode:0o700});for(const file of files){const path=join(directory,file.sha256+'.pdf');copyFileSync(join(source+'.files',file.sha256+'.pdf'),path,constants.COPYFILE_EXCL);verifyReportFile(path,file);}}
  const actual = inspectDatabase(restoredPath);
  if (actual.contentDigest !== expected.contentDigest) throw new Error('恢复副本的业务记录与备份不一致');
  return { verifiedAt: new Date().toISOString(), backupPath: source, restoredPath, ...actual, writableTransactionRolledBack: true, documentCount: files.length };
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const result = createBackup({ sourcePath: process.env.CLUB_DB_PATH || 'work/data/club.sqlite', outputRoot: process.env.CLUB_BACKUP_DIR || 'work/backups' });
  console.log('备份已创建并检查：' + result.backupPath);
}
