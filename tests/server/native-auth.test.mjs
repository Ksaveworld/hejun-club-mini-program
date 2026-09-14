import test from 'node:test';
import assert from 'node:assert/strict';
import { request as httpRequest } from 'node:http';
import { randomUUID } from 'node:crypto';
import { mkdtempSync, existsSync, unlinkSync, rmdirSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { openDatabase } from '../../server/db.mjs';
import { createApplication } from '../../server/app.mjs';
import { authError } from '../../server/native-auth.mjs';
import { digest, insertUser, hashPassword, checkPassword } from '../../server/domain.mjs';

const password = 'OnlyIsolatedNativeTest1';
const orderBody = { planId: 'basic', consent: true, form: { name: '隔离测试会员', phone: '13800000000', city: '上海' } };
async function setup(t, options = {}) {
  const db = openDatabase(':memory:');
  const initialOptions = { hosts: ['127.0.0.1'], origins: ['http://127.0.0.1'], allowNativeTrialAuth: true, ...options };
  let server = createApplication(db, initialOptions);
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  t.after(async () => { await new Promise(resolve => server.close(resolve)); db.close(); });
  async function request(path, { body, token, cookie, headers = {}, method } = {}) {
    return new Promise((resolve, reject) => {
      const req = httpRequest(`http://127.0.0.1:${server.address().port}/api${path}`, {
        method: method ?? (body === undefined ? 'GET' : 'POST'),
        headers: { Host: '127.0.0.1', 'Content-Type': 'application/json', 'X-Club-Request': '1',
          ...(token ? { Authorization: `Bearer ${token}` } : {}), ...(cookie ? { Cookie: cookie } : {}), ...headers },
      }, res => {
        const chunks = [];
        res.on('data', chunk => chunks.push(chunk));
        res.on('end', () => resolve({ status: res.statusCode, body: JSON.parse(Buffer.concat(chunks)), headers: res.headers }));
      });
      req.on('error', reject);
      req.end(body === undefined ? undefined : JSON.stringify(body));
    });
  }
  async function register(username = 'nativealice', extra = {}) {
    const result = await request('/native/auth/register', { body: { username, password, consent: true, ...extra } });
    assert.equal(result.status, 201);
    return result;
  }
  async function restart(nextOptions) {
    await new Promise(resolve => server.close(resolve));
    server = createApplication(db, { ...initialOptions, ...nextOptions });
    await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  }
  return { db, request, register, restart };
}

test('native trial sessions persist by digest, expire and revoke without creating H5 cookies', async t => {
  const { db, request, register } = await setup(t);
  const registered = await register('nativealice', { role: 'admin' });
  const { accessToken: token, user } = registered.body;
  assert.match(token, /^[a-f0-9]{64}$/);
  assert.equal(user.role, 'member'); assert.equal(user.phoneVerified, false);
  assert.equal(registered.body.authMode, 'local-trial'); assert.equal(registered.body.tokenType, 'Bearer');
  assert.equal(registered.headers['set-cookie'], undefined);
  assert.equal(db.prepare('SELECT count(*) n FROM sessions').get().n, 0);
  assert.equal(db.prepare('SELECT token_hash FROM native_sessions').get().token_hash, digest(token));
  assert.equal((await request('/me', { token })).body.user.id, user.id);
  const logged = await request('/native/auth/login', { body: { username: 'nativealice', password } });
  assert.equal(logged.status, 200); assert.equal(logged.body.user.id, user.id);
  assert.notEqual(logged.body.accessToken, token);
  const logout = await request('/native/auth/logout', { body: {}, token });
  assert.equal(logout.status, 200); assert.equal(logout.headers['set-cookie'], undefined);
  assert.equal((await request('/me', { token })).status, 401);
  db.prepare("UPDATE native_sessions SET expires_at='2000-01-01T00:00:00.000Z'").run();
  const expired = await request('/me', { token: logged.body.accessToken });
  assert.equal(expired.status, 401); assert.equal(expired.body.code, 'SESSION_EXPIRED');
});

test('Cookie and Bearer transports cannot be interchanged, combined or used as fallback', async t => {
  const { request, register } = await setup(t);
  const native = await register(); const token = native.body.accessToken;
  const web = await request('/auth/login', { body: { username: 'nativealice', password } });
  const cookie = web.headers['set-cookie'][0].split(';')[0];
  const webToken = cookie.split('=')[1];
  assert.equal((await request('/me', { cookie })).body.user.id, native.body.user.id);
  assert.equal((await request('/me', { token: webToken })).status, 401);
  assert.equal((await request('/me', { cookie: `club_session=${token}` })).body.user, null);
  for (const headers of [{ Authorization: 'Bearer invalid' }, { Authorization: 'Basic test' }, { Authorization: '' }])
    assert.equal((await request('/me', { headers })).status, 401);
  for (const bearer of [token, 'bad-token']) {
    const mixed = await request('/me', { token: bearer, cookie });
    assert.equal(mixed.status, 400); assert.equal(mixed.body.code, 'AUTH_AMBIGUOUS');
  }
  assert.equal((await request('/native/auth/login', { cookie, body: { username: 'nativealice', password } })).status, 400);
  assert.equal((await request('/native/auth/login', { token, body: { username: 'nativealice', password } })).status, 400);
  assert.equal((await request('/auth/login', { token, body: { username: 'nativealice', password } })).status, 400);
  assert.equal((await request('/auth/logout', { token, body: {} })).status, 400);
  assert.equal((await request('/native/auth/logout', { cookie, body: {} })).status, 401);
  assert.equal((await request('/me', { cookie })).body.user.id, native.body.user.id);
});

test('native labels and valid Bearer never bypass Host, Origin, cross-site or write protection', async t => {
  const { db, request, register } = await setup(t);
  const token = (await register()).body.accessToken;
  for (const rejected of [{ Host: 'evil.example' }, { Origin: 'https://evil.example' }, { Origin: 'null' },
    { 'Sec-Fetch-Site': 'cross-site' }, { 'X-Club-Request': '' }]) {
    const result = await request('/orders', { body: orderBody, token,
      headers: { 'X-Club-Client': 'native', 'Idempotency-Key': randomUUID(), ...rejected } });
    assert.equal(result.status, 403);
  }
  assert.equal((await request('/orders', { body: orderBody, token, headers: { 'Content-Type': 'text/plain' } })).status, 415);
  assert.equal((await request('/native/auth/login', { body: { username: 'nativealice', password }, headers: { Origin: 'https://evil.example', 'X-Club-Client': 'native' } })).status, 403);
  assert.equal((await request('/orders', { token, method: 'OPTIONS', headers: { Origin: 'https://evil.example' } })).status, 403);
  assert.equal(db.prepare('SELECT count(*) n FROM orders').get().n, 0);
});

test('native member orders stay isolated and idempotent; payment and administrator access remain closed', async t => {
  const { db, request, register } = await setup(t);
  const a = (await register('nativealice')).body, b = (await register('nativebobby')).body;
  const key = randomUUID();
  const results = await Promise.all([1, 2].map(() => request('/orders', { body: orderBody, token: a.accessToken, headers: { 'Idempotency-Key': key } })));
  assert.equal(results[0].status, 201); assert.equal(results[1].status, 201);
  const id = results[0].body.order.id; assert.equal(results[1].body.order.id, id);
  assert.equal((await request(`/orders/${id}`, { token: b.accessToken })).status, 404);
  assert.equal((await request(`/orders/${id}/cancel`, { body: {}, token: b.accessToken })).status, 404);
  assert.equal((await request(`/orders/${id}/payment`, { body: { status: 'paid' }, token: a.accessToken })).status, 503);
  assert.equal((await request('/admin/orders', { token: a.accessToken })).status, 403);
  const me = await request('/me', { token: a.accessToken });
  assert.equal(me.body.paymentReady, false); assert.equal(me.body.membership, null);
  assert.ok(!JSON.stringify(me.body).includes(a.accessToken));
  assert.equal(db.prepare('SELECT count(*) n FROM memberships').get().n, 0);
  insertUser(db, 'nativeadmin', await hashPassword(password), 'admin');
  assert.equal((await request('/native/auth/login', { body: { username: 'nativeadmin', password } })).status, 403);
  db.prepare("UPDATE users SET role='admin' WHERE id=?").run(a.user.id);
  assert.equal((await request('/admin/orders', { token: a.accessToken })).status, 403);
});

test('native trial authentication is disabled by default and in production despite opt-in', async t => {
  const disabled = await setup(t, { allowNativeTrialAuth: undefined });
  const health = await disabled.request('/health');
  assert.deepEqual(health.body.nativeAuth, { localTrial: false, wechat: false });
  assert.equal(health.body.paymentReady, false);
  assert.equal((await disabled.request('/native/auth/register', { body: { username: 'nevercreated', password, consent: true, allowNativeTrialAuth: true }, headers: { 'X-Club-Client': 'native' } })).status, 404);
  assert.equal(disabled.db.prepare('SELECT count(*) n FROM users').get().n, 0);
  const old = process.env.NODE_ENV;
  let production;
  try { process.env.NODE_ENV = 'production'; production = await setup(t); }
  finally { if (old === undefined) delete process.env.NODE_ENV; else process.env.NODE_ENV = old; }
  assert.equal((await production.request('/health')).body.nativeAuth.localTrial, false);
  assert.equal((await production.request('/native/auth/login', { body: { username: 'nativealice', password } })).status, 404);
});

test('disabling trial authentication rejects previously issued trial tokens while keeping verified WeChat sessions', async t => {
  const wechat = { configured: true, appId: 'wx_isolated_app', exchangeCode: async () => ({ appId: 'wx_isolated_app', openId: 'isolated_openid' }) };
  const { db, request, register, restart } = await setup(t, { wechat });
  const trial = (await register()).body;
  const verified = await request('/native/auth/wechat', { body: { code: 'isolated_code', consent: true } });
  assert.equal(verified.status, 200);
  assert.equal((await request('/me', { token: trial.accessToken })).status, 200);
  await restart({ allowNativeTrialAuth: false });
  assert.deepEqual((await request('/health')).body.nativeAuth, { localTrial: false, wechat: true });
  const refused = await request('/me', { token: trial.accessToken });
  assert.equal(refused.status, 401); assert.equal(refused.body.code, 'AUTH_REQUIRED');
  assert.equal((await request('/orders', { body: orderBody, token: trial.accessToken, headers: { 'Idempotency-Key': randomUUID() } })).status, 401);
  const session = await request('/me', { token: verified.body.accessToken });
  assert.equal(session.status, 200); assert.equal(session.body.user.id, verified.body.user.id);
  assert.equal(db.prepare('SELECT count(*) n FROM orders').get().n, 0);
});

test('native registration validates consent and referral transactionally; wrong passwords are limited', async t => {
  const { db, request, register } = await setup(t);
  assert.equal((await request('/native/auth/register', { body: { username: 'no_consent', password } })).status, 400);
  assert.equal((await request('/native/auth/register', { body: { username: 'bad_referral', password, consent: true, referral: 'BADBAD' } })).status, 400);
  assert.equal(db.prepare('SELECT count(*) n FROM users').get().n, 0);
  const referrer = (await register('referrer')).body.user;
  const referred = await register('referred', { referral: referrer.referralCode });
  assert.equal(referred.body.user.sourceCode, referrer.referralCode);
  assert.equal(db.prepare("SELECT count(*) n FROM settings WHERE key='default_referral_code'").get().n, 0);
  assert.equal((await request('/native/auth/login', { body: { username: 'referred', password: 'WrongIsolatedPassword' } })).status, 401);
  let result;
  for (let i = 0; i < 26; i++) result = await request('/native/auth/login', { body: { username: 'unknownuser', password } });
  assert.equal(result.status, 429);
});

test('missing WeChat configuration, invalid codes and upstream faults create no user or session', async t => {
  const unconfigured = await setup(t);
  const missing = await unconfigured.request('/native/auth/wechat', { body: { code: 'isolated_code', consent: true, openid: 'forged', role: 'admin' } });
  assert.equal(missing.status, 503); assert.equal(missing.body.code, 'WECHAT_NOT_CONFIGURED');
  let calls = 0;
  const configured = await setup(t, { wechat: { configured: true, appId: 'wx_isolated_app', exchangeCode: async code => {
    calls++;
    if (code === 'expired_code') throw authError('凭证失效', 401, 'WECHAT_CODE_INVALID');
    throw new Error('DO_NOT_LEAK_UPSTREAM_SECRET');
  } } });
  assert.equal((await configured.request('/native/auth/wechat', { body: { code: 'bad code', consent: true } })).status, 400);
  assert.equal((await configured.request('/native/auth/wechat', { body: { code: 'isolated_code' } })).status, 400);
  assert.equal(calls, 0);
  assert.equal((await configured.request('/native/auth/wechat', { body: { code: 'expired_code', consent: true } })).status, 401);
  const failed = await configured.request('/native/auth/wechat', { body: { code: 'network_fail', consent: true } });
  assert.equal(failed.status, 503); assert.ok(!JSON.stringify(failed).includes('DO_NOT_LEAK'));
  for (const { db } of [unconfigured, configured]) {
    assert.equal(db.prepare('SELECT count(*) n FROM users').get().n, 0);
    assert.equal(db.prepare('SELECT count(*) n FROM native_sessions').get().n, 0);
  }
});

test('concurrent verified WeChat identity creates one member and never trusts client identity or role', async t => {
  const adapter = { configured: true, appId: 'wx_isolated_app', exchangeCode: async () => ({ appId: 'wx_isolated_app', openId: 'isolated_openid_secret' }) };
  const { db, request } = await setup(t, { wechat: adapter });
  const local = insertUser(db, 'keep_local_account', await hashPassword(password));
  const body = { code: 'isolated_code', consent: true, username: local.username, userId: local.id, openid: 'client_fake_openid', appId: 'client_fake_app', role: 'admin' };
  const results = await Promise.all([1, 2].map(i => request('/native/auth/wechat', { body: { ...body, code: `${body.code}_${i}` } })));
  for (const result of results) {
    assert.equal(result.status, 200); assert.equal(result.body.user.role, 'member');
    assert.equal(result.body.user.phoneVerified, false); assert.equal(result.body.authMode, 'wechat');
    assert.equal(result.headers['set-cookie'], undefined);
    assert.notEqual(result.body.user.id, local.id);
    assert.ok(!JSON.stringify(result.body).includes('isolated_openid_secret'));
    assert.ok(!JSON.stringify(result.body).includes('session_key'));
  }
  assert.equal(results[0].body.user.id, results[1].body.user.id);
  assert.equal(db.prepare('SELECT count(*) n FROM wechat_identities').get().n, 1);
  assert.equal(db.prepare('SELECT count(*) n FROM users').get().n, 2);
  const hash = db.prepare('SELECT password_hash FROM users WHERE id=?').get(results[0].body.user.id).password_hash;
  assert.equal(await checkPassword(password, hash), false);
  const me = await request('/me', { token: results[0].body.accessToken });
  assert.equal(me.body.paymentReady, false); assert.equal(me.body.membership, null);
  assert.deepEqual((await request('/health')).body.nativeAuth, { localTrial: true, wechat: true });
});

test('verified WeChat identity is scoped to configured app; malformed or mismatched identity is rejected', async t => {
  const adapter = { configured: true, appId: 'wx_isolated_one', exchangeCode: async () => ({ appId: adapter.appId, openId: 'same_isolated_openid' }) };
  const { db, request } = await setup(t, { wechat: adapter });
  const login = () => request('/native/auth/wechat', { body: { code: randomUUID(), consent: true } });
  const one = await login();
  adapter.appId = 'wx_isolated_two';
  const two = await login();
  assert.equal(one.status, 200); assert.equal(two.status, 200);
  assert.notEqual(one.body.user.id, two.body.user.id);
  adapter.exchangeCode = async () => ({ appId: 'wrong_app', openId: 'same_isolated_openid' });
  assert.equal((await login()).status, 503);
  adapter.exchangeCode = async () => ({ appId: adapter.appId, openId: '' });
  assert.equal((await login()).status, 503);
  assert.equal(db.prepare('SELECT count(*) n FROM users').get().n, 2);
});

test('additive native schema preserves an existing H5 account and cookie session when reopening an old database', async t => {
  const directory = mkdtempSync(join(tmpdir(), 'club-native-isolated-'));
  const file = join(directory, 'isolated.sqlite');
  let db = openDatabase(file);
  t.after(() => {
    db.close();
    for (const suffix of ['', '-wal', '-shm']) if (existsSync(file + suffix)) unlinkSync(file + suffix);
    rmdirSync(directory);
  });
  const user = insertUser(db, 'existing_h5_member', await hashPassword(password));
  db.prepare('INSERT INTO sessions VALUES (?,?,?)').run(digest('isolated_h5_token'), user.id, '2099-01-01T00:00:00.000Z');
  db.exec('DROP TABLE native_sessions; DROP TABLE wechat_identities;');
  db.close();
  db = openDatabase(file);
  assert.equal(db.prepare('SELECT id FROM users WHERE username=?').get(user.username).id, user.id);
  assert.equal(db.prepare('SELECT user_id FROM sessions').get().user_id, user.id);
  assert.equal(db.prepare('SELECT count(*) n FROM native_sessions').get().n, 0);
  assert.equal(db.prepare('SELECT count(*) n FROM wechat_identities').get().n, 0);
});
