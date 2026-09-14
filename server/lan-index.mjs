import { dirname, resolve, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { existsSync, mkdirSync, writeFileSync } from 'node:fs';
import { loadEnvFile } from 'node:process';
import { randomBytes } from 'node:crypto';
import { openDatabase, transaction } from './db.mjs';
import { hashPassword, insertUser } from './domain.mjs';
import { createApplication } from './app.mjs';
import { createWechatAdapter } from './wechat.mjs';
import { validateLanBinding } from './lan-network.mjs';

export function parseLanArguments(args) {
  if (args.length !== 4 || new Set([args[0], args[2]]).size !== 2
    || ![args[0], args[2]].every(value => ['--address', '--prefix-length'].includes(value)))
    throw new Error('用法：node server/lan-index.mjs --address <本机私有IPv4> --prefix-length <网卡前缀长度>');
  const values = new Map([[args[0], args[1]], [args[2], args[3]]]);
  const prefix = values.get('--prefix-length');
  if (!/^\d{1,2}$/.test(prefix)) throw new Error('请提供网卡实际的整数前缀长度');
  return { address: values.get('--address'), prefixLength: Number(prefix) };
}
export async function startLanService(args = process.argv.slice(2)) {
  if (process.env.NODE_ENV === 'production') throw new Error('LAN 入口仅供同网段内测，不能作为生产环境启动');
  const input = parseLanArguments(args);
  const lanNetwork = validateLanBinding(input.address, input.prefixLength);
  const workspace = resolve(dirname(fileURLToPath(import.meta.url)), '..');
  const localEnv = join(workspace, 'server', '.env.local');
  if (existsSync(localEnv)) loadEnvFile(localEnv);
  if (process.env.NODE_ENV === 'production') throw new Error('LAN 入口仅供同网段内测，不能作为生产环境启动');
  // Paths deliberately ignore CLUB_DB_PATH and cwd, preserving the existing local service and database.
  const directory = join(workspace, 'work', 'lan-test');
  const administratorFile = join(directory, 'admin.txt');
  mkdirSync(directory, { recursive: true });
  const db = openDatabase(join(directory, 'club.sqlite'));
  let server;
  try {
    if (!db.prepare("SELECT 1 FROM users WHERE username='lan_admin' AND role='admin'").get()) {
      if (existsSync(administratorFile)) throw new Error('独立 LAN 管理员文件已存在但数据库未登记，请核对后再启动');
      const password = randomBytes(18).toString('base64url');
      const passwordHash = await hashPassword(password);
      transaction(db, () => {
        insertUser(db, 'lan_admin', passwordHash, 'admin');
        writeFileSync(administratorFile,
          `LAN 独立内测管理员（勿提交 Git 或对外发送）\n入口：http://127.0.0.1:5196/#/admin\n账号：lan_admin\n密码：${password}\n仅用于 work/lan-test 数据库。付款尚未接通。\n`,
          { encoding: 'utf8', flag: 'wx', mode: 0o600 });
      });
    }
    const wechat = createWechatAdapter({ appId: process.env.WECHAT_MINI_APP_ID, appSecret: process.env.WECHAT_MINI_APP_SECRET });
    server = createApplication(db, { documentsDirectory:join(directory,'report-files'),lanNetwork, mode: 'lan-trial', cookieName: 'club_lan_session', allowNativeTrialAuth: true, wechat,
      hosts: [`${lanNetwork.address}:5198`, '127.0.0.1:5196', 'localhost:5196'],
      origins: ['http://127.0.0.1:5196', 'http://localhost:5196'] });
    await new Promise((resolveListen, reject) => {
      server.once('error', reject);
      server.listen(5198, lanNetwork.address, () => { server.off('error', reject); resolveListen(); });
    });
    console.log(`LAN 会员数据服务：http://${lanNetwork.address}:5198（仅同网段内测，支付未接通）`);
    console.log(`独立后台：http://127.0.0.1:5196/#/admin；微信配置${wechat.configured ? '齐备，仍需真实联验' : '未齐备'}`);
  } catch (error) { db.close(); throw error; }
  let closing = false;
  const stop = () => {
    if (closing) return;
    closing = true;
    server.close(() => { db.close(); });
  };
  process.once('SIGINT', stop);
  process.once('SIGTERM', stop);
  server.on('error', () => { console.error('LAN 数据服务发生错误，请检查本机网络和端口'); stop(); });
  return server;
}
if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  startLanService().catch(error => {
    // Only report bounded configuration/startup errors; never dump environment or credentials.
    console.error(`LAN 数据服务未启动：${error.message}`);
    process.exitCode = 1;
  });
}
