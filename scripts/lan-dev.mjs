import { spawn } from 'node:child_process';
import { mkdirSync, writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { validateLanBinding } from '../server/lan-network.mjs';

const root = fileURLToPath(new URL('../', import.meta.url));
if (process.argv.length !== 6 || process.argv[2] !== '--address' || process.argv[4] !== '--prefix-length') throw new Error('须提供明确局域网地址和掩码');
const address = process.argv[3], prefixLength = Number(process.argv[5]);
validateLanBinding(address, prefixLength);
if (process.env.NODE_ENV === 'production') throw new Error('LAN 启动器不能用于生产环境');
const children = [];
let stopping = false;
function stop(code = 0) {
  if (stopping) return;
  stopping = true;
  for (const child of children) child.kill();
  process.exitCode = code;
}
try {
for (const [args, env] of [
  [['server/lan-index.mjs', '--address', address, '--prefix-length', String(prefixLength)], process.env],
  [['node_modules/vite/bin/vite.js', '--host', '127.0.0.1', '--port', '5196', '--strictPort'], { ...process.env, CLUB_API_TARGET: 'http://' + address + ':5198' }],
]) {
  const child = spawn(process.execPath, args, { cwd: root, stdio: 'inherit', windowsHide: true, env });
  children.push(child);
  child.on('error', error => { console.error(error.message); stop(1); });
  child.on('exit', code => { if (!stopping) stop(code || 0); });
}
mkdirSync(new URL('../work/lan-test/', import.meta.url), { recursive: true });
writeFileSync(new URL('../work/lan-test/runtime.json', import.meta.url), JSON.stringify({
  pid: process.pid, children: children.map(child => child.pid), startedAt: new Date().toISOString(),
  address, prefixLength, apiUrl: 'http://' + address + ':5198/api', adminUrl: 'http://127.0.0.1:5196/#/admin'
}, null, 2) + '\n', 'utf8');
} catch (error) { stop(1); console.error('LAN 启动记录保存失败：' + error.message); }
process.on('SIGINT', () => stop());
process.on('SIGTERM', () => stop());
