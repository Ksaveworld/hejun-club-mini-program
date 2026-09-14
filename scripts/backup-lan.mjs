import { writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { join } from 'node:path';
import { createBackup, verifyBackup } from './backup.mjs';

// Fixed workspace paths: never borrow the old local environment or point the phone at a restore copy.
const directory = fileURLToPath(new URL('../work/lan-test/', import.meta.url));
const backup = createBackup({ sourcePath: join(directory, 'club.sqlite'), outputRoot: join(directory, 'backups') });
const restored = verifyBackup({ backupPath: backup.backupPath, restoreRoot: join(directory, 'restore-checks') });
const record = { status: 'passed', scope: '内测库一致快照、独立副本恢复和回滚写入检查；未切换运行服务', backup, restored };
const recordPath = join(directory, 'backup-restore-check.json');
writeFileSync(recordPath, JSON.stringify(record, null, 2) + '\n', { encoding: 'utf8', mode: 0o600 });
console.log(JSON.stringify({ status: record.status, recordPath, backupPath: backup.backupPath, restoredPath: restored.restoredPath, counts: restored.counts }));
