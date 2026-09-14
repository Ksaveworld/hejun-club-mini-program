import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, writeFileSync, existsSync, mkdirSync, readdirSync, symlinkSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { tmpdir } from 'node:os';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { request as httpRequest } from 'node:http';
import { readRemoteConfig, startRemoteService } from '../../server/remote-index.mjs';
import { openDatabase } from '../../server/db.mjs';
import { insertUser, hashPassword, createOrder } from '../../server/domain.mjs';

function configFiles(t) {
  const root = mkdtempSync(join(tmpdir(), 'club-remote-start-'));
  t.after(() => { assert.ok(resolve(root).startsWith(resolve(tmpdir()))); rmSync(root, { recursive: true, force: true }); });
  const file = join(root, 'remote.json'), data = join(root, 'state');
  const config = { mode: 'remote-trial', apiOrigin: 'https://api.example.test', dataDirectory: data,
    adminOrigin: null, adminIps: [], wechat: { appId: 'wx1111111111111111', appSecret: '', openIds: [] } };
  const save = (next = config) => writeFileSync(file, JSON.stringify(next), { encoding: 'utf8', mode: 0o600 });
  save(); return { root, file, data, config, save };
}
test('remote startup rejects missing, unsafe, mismatched and production configuration before creating state', t => {
  const { file, data, config, save } = configFiles(t);
  assert.throws(() => readRemoteConfig('relative.json'), /绝对路径/);
  for (const changes of [
    { mode: 'production' }, { apiOrigin: 'http://api.example.test' }, { dataDirectory: resolve('work/data') },
    { dataDirectory: resolve('/') }, { dataDirectory: '/usr/local/nginx/html/club' },
    { wechat: { ...config.wechat, openIds: ['invited'] } },
  ]) { save({ ...config, ...changes }); assert.throws(() => readRemoteConfig(file)); assert.equal(existsSync(data), false); }
  save();
  const entry = fileURLToPath(new URL('../../server/remote-index.mjs', import.meta.url));
  const result = spawnSync(process.execPath, [entry, '--config', file], { env: { ...process.env, NODE_ENV: 'production' }, encoding: 'utf8' });
  assert.equal(result.status, 1); assert.match(result.stderr, /不能作为生产模式/); assert.equal(existsSync(data), false);
});

test('closed remote server listens only on loopback and reopens its own persistent data without local config', async t => {
  let runtime;
  t.after(async () => { await runtime?.stop(); });
  const { file, data, config, save } = configFiles(t);
  runtime = await startRemoteService(file, { port: 0 });
  assert.equal(runtime.server.address().address, '127.0.0.1');
  const url = () => `http://127.0.0.1:${runtime.server.address().port}/api/health`;
  const request = (headers = {}) => new Promise((ok, fail) => {
    const req = httpRequest(url(), { headers, agent: false }, res => {
      const chunks = []; res.on('data', chunk => chunks.push(chunk));
      res.on('end', () => ok({ status: res.statusCode, body: JSON.parse(Buffer.concat(chunks)) }));
    }); req.on('error', fail); req.end();
  });
  assert.equal((await request()).status, 403);
  const response = await request({ host: 'api.example.test', 'x-real-ip': '203.0.113.1', 'x-forwarded-proto': 'https' });
  assert.equal(response.status, 200, JSON.stringify(response.body));
  assert.deepEqual(response.body.nativeAuth, { localTrial: false, wechat: false });
  await runtime.stop();
  const db = openDatabase(join(data, 'club.sqlite'));
  const user = insertUser(db, 'isolatedpersist', await hashPassword('TestOnlyPassword100'));
  const order = createOrder(db, user.id, { planId: 'basic', consent: true, form: { name: '恢复测试', phone: '13800000000', city: '上海' } }, 'remote-persist-001');
  db.close();
  runtime = await startRemoteService(file, { port: 0 });
  await runtime.stop();
  const reopened = openDatabase(join(data, 'club.sqlite'));
  assert.equal(reopened.prepare('SELECT id FROM orders').get().id, order.id);
  assert.equal(reopened.prepare('SELECT count(*) AS n FROM memberships').get().n, 0); reopened.close();
  save({ ...config, wechat: { ...config.wechat, appId: 'wx0000000000000000' } });
  await assert.rejects(startRemoteService(file, { port: 0 }), /其他环境或小程序/);
});

test('remote state refuses unmarked existing data and symlinks rather than adopting another database', async t => {
  const { file, data, root, config } = configFiles(t);
  mkdirSync(data, { mode: 0o700 }); writeFileSync(join(data, 'keep.txt'), 'existing');
  await assert.rejects(startRemoteService(file, { port: 0 }), /已有数据目录/);
  assert.deepEqual(readdirSync(data), ['keep.txt']);
  // Unix deployment invariant; Windows can require extra privilege to create symlinks.
  if (process.platform !== 'win32') {
    const target = join(root, 'real-state'); mkdirSync(target, { mode: 0o700 });
    rmSync(data, { recursive: true }); symlinkSync(target, data);
    await assert.rejects(startRemoteService(file, { port: 0 }), /符号链接/);
    assert.deepEqual(readdirSync(target), []);
    rmSync(data); mkdirSync(data, { mode: 0o700 });
    writeFileSync(join(data, 'environment.json'), JSON.stringify({ mode: 'remote-trial', appId: config.wechat.appId }), { mode: 0o600 });
    const outside = join(root, 'must-not-create.sqlite');
    symlinkSync(outside, join(data, 'club.sqlite'));
    await assert.rejects(startRemoteService(file, { port: 0 }), /符号链接/);
    assert.equal(existsSync(outside), false);
  }
});
