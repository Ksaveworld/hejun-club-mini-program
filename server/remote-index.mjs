import { dirname, isAbsolute, join, relative, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import { existsSync, lstatSync, mkdirSync, readFileSync, readdirSync, realpathSync, writeFileSync } from 'node:fs';
import { randomBytes } from 'node:crypto';
import { openDatabase, transaction } from './db.mjs';
import { hashPassword, insertUser } from './domain.mjs';
import { createApplication } from './app.mjs';
import { createWechatAdapter } from './wechat.mjs';
import { createRemotePolicy } from './remote-policy.mjs';

const workspace = resolve(dirname(fileURLToPath(import.meta.url)), '..');
function under(parent, child) {
  const part = relative(parent, child);
  return part === '' || (!part.startsWith('..' + sep) && part !== '..' && !isAbsolute(part));
}
function privateFile(path) {
  const stat = lstatSync(path);
  if (!stat.isFile() || stat.isSymbolicLink()) throw new Error('私有配置必须是普通文件');
  if (process.platform !== 'win32' && (stat.mode & 0o077)) throw new Error('私有文件只能由所属用户读取，请设置 0600 权限');
}
export function readRemoteConfig(path) {
  if (process.env.NODE_ENV === 'production') throw new Error('remote-trial 仅供受控测试，不能作为生产模式启动');
  if (!isAbsolute(path ?? '')) throw new Error('必须显式提供私有配置的绝对路径');
  privateFile(path);
  let config;
  try { config = JSON.parse(readFileSync(path, 'utf8')); } catch { throw new Error('远程私有配置不是有效 JSON'); }
  const policy = createRemotePolicy(config);
  const data = config.dataDirectory;
  if (typeof data !== 'string' || !isAbsolute(data) || resolve(data) !== data || dirname(data) === data
    || under(workspace, data) || under(data, workspace) || under(data, resolve(path))
    || data.split(/[\\/]/).some(part => ['html', 'public', 'dist', 'www', 'wwwroot'].includes(part.toLowerCase())))
    throw new Error('数据目录必须是工作区、私有配置和静态根目录之外的独立绝对路径');
  if (typeof config.wechat.appSecret !== 'string' || /\s/.test(config.wechat.appSecret) || config.wechat.appSecret.length > 256)
    throw new Error('微信私有配置格式不正确');
  if (policy.invited && !config.wechat.appSecret) throw new Error('开放受邀登录前须配置微信 AppSecret');
  return config;
}
function prepareState(config) {
  const directory = config.dataDirectory;
  // Refuse symlinked ancestors before creating directories or opening a database.
  let ancestor = directory;
  while (!existsSync(ancestor)) ancestor = dirname(ancestor);
  if (resolve(realpathSync(ancestor)) !== resolve(ancestor)) throw new Error('数据目录不能经过符号链接');
  mkdirSync(directory, { recursive: true, mode: 0o700 });
  const stat = lstatSync(directory);
  if (!stat.isDirectory() || stat.isSymbolicLink() || (process.platform !== 'win32' && (stat.mode & 0o077)))
    throw new Error('数据目录必须独立且仅供所属用户访问');
  const marker = join(directory, 'environment.json');
  const identity = { mode: 'remote-trial', appId: config.wechat.appId };
  if (existsSync(marker)) {
    privateFile(marker);
    let existing;
    try { existing = JSON.parse(readFileSync(marker, 'utf8')); } catch { throw new Error('数据环境标记不可读取'); }
    if (existing.mode !== identity.mode || existing.appId !== identity.appId) throw new Error('数据目录属于其他环境或小程序');
  } else {
    if (readdirSync(directory).length) throw new Error('不能将已有数据目录直接转为远程测试库');
    writeFileSync(marker, JSON.stringify(identity), { encoding: 'utf8', flag: 'wx', mode: 0o600 });
  }
  for (const name of ['club.sqlite', 'club.sqlite-wal', 'club.sqlite-shm', 'admin.txt']) {
    const path = join(directory, name);
    const entry = lstatSync(path, { throwIfNoEntry: false });
    if (entry && (entry.isSymbolicLink() || !entry.isFile()))
      throw new Error('数据文件不能是符号链接或特殊文件');
  }
}
export async function startRemoteService(configPath, { port = 5210 } = {}) {
  const config = readRemoteConfig(configPath);
  prepareState(config);
  const db = openDatabase(join(config.dataDirectory, 'club.sqlite'));
  let server;
  try {
    if (config.adminOrigin && !db.prepare("SELECT 1 FROM users WHERE role='admin'").get()) {
      const credentialsPath = join(config.dataDirectory, 'admin.txt');
      if (existsSync(credentialsPath)) throw new Error('管理员文件与数据库不一致，请先核对');
      const password = randomBytes(24).toString('base64url');
      const hash = await hashPassword(password);
      transaction(db, () => {
        insertUser(db, 'remote_admin', hash, 'admin');
        writeFileSync(credentialsPath, `远程内测管理员，仅用于当前测试库\n账号：remote_admin\n密码：${password}\n`,
          { encoding: 'utf8', flag: 'wx', mode: 0o600 });
      });
    }
    server = createApplication(db, { remoteTrial: config,
      wechat: createWechatAdapter({ appId: config.wechat.appId, appSecret: config.wechat.appSecret }) });
    server.requestTimeout = 30000; server.headersTimeout = 10000;
    await new Promise((ok, fail) => {
      server.once('error', fail);
      server.listen(port, '127.0.0.1', () => { server.off('error', fail); ok(); });
    });
  } catch (error) { db.close(); throw error; }
  let closing;
  const stop = () => closing ??= new Promise(resolveClose => {
    process.off('SIGTERM', onSignal); process.off('SIGINT', onSignal);
    server.close(() => { db.close(); resolveClose(); });
  });
  const onSignal = () => { void stop(); };
  process.once('SIGTERM', onSignal); process.once('SIGINT', onSignal);
  console.log('远程内测后端已启动，仅监听服务器回环地址；付款关闭，身份配置与名单共同决定登录是否开放。');
  return { server, stop };
}
if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const args = process.argv.slice(2);
  if (args.length !== 2 || args[0] !== '--config') {
    console.error('用法：node server/remote-index.mjs --config <私有 JSON 配置绝对路径>');
    process.exitCode = 1;
  } else startRemoteService(args[1]).catch(error => {
    // Never print the config body, path-bearing I/O errors, environment, or credentials.
    console.error(error.code ? '远程测试启动失败，请核对私有配置权限、数据目录及监听端口' : error.message);
    process.exitCode = 1;
  });
}
