import test from 'node:test';
import assert from 'node:assert/strict';
import { Readable } from 'node:stream';
import { openDatabase } from '../../server/db.mjs';
import { createApplication } from '../../server/app.mjs';
import { createRemotePolicy } from '../../server/remote-policy.mjs';
import { hashPassword, insertUser, digest, nowISO } from '../../server/domain.mjs';

const appId = 'wx1111111111111111';
const password = 'OnlyRemoteFixturePassword1';
function config(overrides = {}) {
  return { mode: 'remote-trial', apiOrigin: 'https://api.example.test', adminOrigin: 'https://admin.example.test',
    adminIps: ['203.0.113.7'], wechat: { appId, openIds: ['invited-a', 'invited-b'] }, ...overrides };
}
function fixture(t, initial = config(), configured = true) {
  const db = openDatabase(':memory:');
  let exchangeCount = 0;
  const adapter = { appId, configured, async exchangeCode(code) { exchangeCount++; return { appId, openId: code }; } };
  let server;
  const restart = next => {
    server?.close();
    server = createApplication(db, { remoteTrial: next, wechat: adapter, allowNativeTrialAuth: true,
      hosts: ['evil.test'], origins: ['http://evil.test'] });
  };
  restart(initial);
  t.after(() => { server.close(); db.close(); });
  async function request(path, { body, token, cookie, source = '127.0.0.1', admin = false, headers = {}, method } = {}) {
    const req = Readable.from(body === undefined ? [] : [Buffer.from(JSON.stringify(body))]);
    req.url = '/api' + path; req.method = method ?? (body === undefined ? 'GET' : 'POST');
    req.socket = { remoteAddress: source };
    req.headers = { host: admin ? 'admin.example.test' : 'api.example.test',
      'x-real-ip': '203.0.113.7', 'x-forwarded-proto': 'https', 'content-type': 'application/json', 'x-club-request': '1',
      ...(token ? { authorization: `Bearer ${token}` } : {}), ...(cookie ? { cookie } : {}), ...headers };
    return new Promise(resolve => {
      let status, responseHeaders;
      server.emit('request', req, { headersSent: false,
        writeHead(code, values) { status = code; responseHeaders = values; this.headersSent = true; },
        end(text) { resolve({ status, headers: responseHeaders, body: JSON.parse(text) }); } });
    });
  }
  return { db, request, restart, exchanges: () => exchangeCount };
}

test('remote policy rejects ambiguous domains and invitations; configured lists are copied', () => {
  for (const apiOrigin of ['http://api.example.test', 'https://127.0.0.1', 'https://api.example.test/path',
    'https://api.example.test:443', 'https://user:pass@api.example.test', 'https://api.example.test/', 'https://*.example.test'])
    assert.throws(() => createRemotePolicy(config({ apiOrigin })));
  assert.throws(() => createRemotePolicy(config({ adminOrigin: 'https://api.example.test' })), /独立域名/);
  assert.throws(() => createRemotePolicy(config({ adminIps: [] })), /来源 IP/);
  assert.throws(() => createRemotePolicy(config({ adminIps: ['0.0.0.0/0'] })));
  assert.throws(() => createRemotePolicy(config({ wechat: { appId, openIds: ['*'] } })));
  const values = config(); const policy = createRemotePolicy(values);
  values.wechat.openIds.push('not-invited');
  assert.equal(policy.allowsIdentity({ appId, openId: 'not-invited' }), false);
  assert.equal(policy.allowsIdentity({ appId: 'wx0000000000000000', openId: 'invited-a' }), false);
});

test('remote rejects direct clients, spoofed proxy data, wrong hosts and cross-origin traffic before mutation', async t => {
  const { request, db } = fixture(t);
  for (const options of [
    { source: '203.0.113.7' }, { source: '172.17.0.1' },
    { headers: { 'x-real-ip': '203.0.113.7, 127.0.0.1' } },
    { headers: { 'x-real-ip': undefined, 'x-forwarded-for': '203.0.113.7' } },
    { headers: { 'x-forwarded-proto': 'http' } }, { headers: { host: 'evil.test' } },
    { headers: { origin: 'https://admin.example.test' } }, { headers: { 'sec-fetch-site': 'cross-site' } },
  ]) assert.equal((await request('/native/auth/wechat', { body: { code: 'invited-a', consent: true }, ...options })).status, 403);
  assert.equal(db.prepare('SELECT count(*) AS n FROM users').get().n, 0);
  const health = await request('/health');
  assert.equal(health.status, 200); assert.equal(health.body.mode, 'remote-trial');
  assert.equal(health.body.paymentReady, false); assert.equal(health.body.nativeAuth.localTrial, false);
});

test('empty invitation list or absent adapter keeps login closed without accounts or upstream calls', async t => {
  for (const [options, configured] of [[config({ wechat: { appId, openIds: [] } }), true], [config(), false]]) {
    const { request, db, exchanges } = fixture(t, options, configured);
    assert.equal((await request('/health')).body.nativeAuth.wechat, false);
    assert.equal((await request('/native/auth/wechat', { body: { code: 'invited-a', consent: true } })).status, 503);
    for (const path of ['/native/auth/register', '/native/auth/login'])
      assert.equal((await request(path, { body: { username: 'testuser', password, consent: true } })).status, 404);
    assert.equal((await request('/auth/register', { admin: true, body: { username: 'testuser', password, consent: true } })).status, 404);
    assert.equal(exchanges(), 0); assert.equal(db.prepare('SELECT count(*) AS n FROM users').get().n, 0);
  }
});

test('verified invitation is checked before account creation and existing sessions lose access after removal', async t => {
  const { request, db, restart } = fixture(t);
  const denied = await request('/native/auth/wechat', { body: { code: 'not-invited', openId: 'invited-a', consent: true } });
  assert.equal(denied.status, 403); assert.equal(denied.body.code, 'TRIAL_NOT_INVITED');
  for (const table of ['users', 'wechat_identities', 'native_sessions', 'audit_log'])
    assert.equal(db.prepare(`SELECT count(*) AS n FROM ${table}`).get().n, 0);
  const accepted = await request('/native/auth/wechat', { body: { code: 'invited-a', consent: true } });
  assert.equal(accepted.status, 200); const token = accepted.body.accessToken;
  const order = await request('/orders', { token, headers: { 'idempotency-key': 'remote-order-fixture-001' },
    body: { planId: 'basic', consent: true, form: { name: '远程隔离测试', phone: '13800000000', city: '上海' } } });
  assert.equal(order.status, 201);
  restart(config({ wechat: { appId, openIds: ['invited-b'] } }));
  assert.equal((await request('/orders', { token })).status, 403);
  assert.equal(db.prepare('SELECT count(*) AS n FROM orders').get().n, 1);
  assert.equal(db.prepare('SELECT count(*) AS n FROM users').get().n, 1);
});

test('remote disables old local tokens and cookie member sessions as alternate access', async t => {
  const { request, db } = fixture(t);
  const user = insertUser(db, 'oldmember', await hashPassword(password));
  const token = 'a'.repeat(64); const expires = new Date(Date.now() + 60000).toISOString();
  db.prepare('INSERT INTO native_sessions VALUES (?,?,?,?)').run(digest(token), user.id, expires, 'local-trial');
  assert.equal((await request('/orders', { token })).status, 401);
  db.prepare('INSERT INTO sessions VALUES (?,?,?)').run(digest(token), user.id, expires);
  assert.equal((await request('/orders', { admin: true, cookie: `club_remote_session=${token}` })).status, 403);
  assert.equal((await request('/auth/login', { admin: true, body: { username: user.username, password } })).status, 401);
  assert.equal((await request('/me', { cookie: `club_remote_session=${token}` })).status, 403);
});

test('admin login requires separate origin and source; Secure cookies are removed consistently on logout', async t => {
  const { request, db } = fixture(t);
  insertUser(db, 'remoteadmin', await hashPassword(password), 'admin');
  const body = { username: 'remoteadmin', password };
  assert.equal((await request('/auth/login', { body })).status, 404);
  assert.equal((await request('/auth/login', { body, admin: true, headers: { 'x-real-ip': '203.0.113.8' } })).status, 403);
  assert.equal((await request('/auth/login', { body, admin: true, headers: { origin: 'https://api.example.test' } })).status, 403);
  const login = await request('/auth/login', { admin: true, body });
  assert.equal(login.status, 200); const header = login.headers['Set-Cookie'];
  for (const part of ['club_remote_session=', 'HttpOnly', 'SameSite=Strict', 'Path=/api', '; Secure']) assert.ok(header.includes(part));
  assert.ok(!header.includes('Domain=')); const cookie = header.split(';')[0];
  assert.equal((await request('/admin/orders', { admin: true, cookie })).status, 200);
  assert.equal((await request('/admin/orders', { cookie })).status, 404);
  const logout = await request('/auth/logout', { admin: true, cookie, body: {} });
  assert.equal(logout.status, 200); assert.match(logout.headers['Set-Cookie'], /Max-Age=0; Secure/);
  assert.equal((await request('/admin/orders', { admin: true, cookie })).status, 401);
  assert.equal(db.prepare('SELECT count(*) AS n FROM sessions WHERE expires_at>?').get(nowISO()).n, 0);
});

test('proxy rate limits are separate per validated IP; forged forwarding chains cannot reset them', async t => {
  const { request } = fixture(t);
  for (let i = 0; i < 25; i++) assert.equal((await request('/native/auth/wechat', {
    body: { code: 'not-invited', consent: true }, headers: { 'x-forwarded-for': `198.51.100.${i}` },
  })).status, 403);
  assert.equal((await request('/native/auth/wechat', { body: { code: 'invited-a', consent: true } })).status, 429);
  assert.equal((await request('/native/auth/wechat', { body: { code: 'invited-a', consent: true },
    headers: { 'x-real-ip': '203.0.113.8' } })).status, 200);
});
