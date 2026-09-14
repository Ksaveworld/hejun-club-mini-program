import test from 'node:test';
import assert from 'node:assert/strict';
import { Readable } from 'node:stream';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { randomUUID } from 'node:crypto';
import { openDatabase } from '../../server/db.mjs';
import { createApplication } from '../../server/app.mjs';
import { hashPassword, insertUser } from '../../server/domain.mjs';
import { parseLanArguments } from '../../server/lan-index.mjs';
import { isPrivateIPv4, isAddressInSubnet, isLocalLanClient, isAllowedLanClient, validateLanBinding } from '../../server/lan-network.mjs';

const address = '192.168.110.33';
const network = { address, prefixLength: 24 };
const interfaces = { WiFi: [{ family: 'IPv4', internal: false, address, netmask: '255.255.255.0', cidr: `${address}/24` }] };
const password = 'OnlyIsolatedLanPassword1';

async function setup(t, options = {}) {
  const db = openDatabase(':memory:');
  const server = createApplication(db, { lanNetwork: network, mode: 'lan-trial', cookieName: 'club_lan_session', allowNativeTrialAuth: true,
    hosts: [`${address}:5198`, '127.0.0.1:5196', 'localhost:5196'],
    origins: ['http://127.0.0.1:5196', 'http://localhost:5196'], ...options });
  // Invoke the actual HTTP handler with isolated socket fixtures; do not bind the real LAN interface.
  t.after(() => { server.close(); db.close(); });
  async function request(path, { source = '192.168.110.60', body, token, cookie, headers = {}, method } = {}) {
    const req = Readable.from(body === undefined ? [] : [Buffer.from(JSON.stringify(body))]);
    req.url = `/api${path}`;
    req.method = method ?? (body === undefined ? 'GET' : 'POST');
    req.socket = { remoteAddress: source };
    req.headers = { host: `${address}:5198`, 'content-type': 'application/json', 'x-club-request': '1',
      ...(token ? { authorization: `Bearer ${token}` } : {}), ...(cookie ? { cookie } : {}), ...headers };
    return new Promise(resolve => {
      let status, responseHeaders;
      const res = { headersSent: false,
        writeHead(code, values) { status = code; responseHeaders = values; this.headersSent = true; },
        end(text) { resolve({ status, body: JSON.parse(text), headers: responseHeaders }); } };
      server.emit('request', req, res);
    });
  }
  return { db, request };
}

test('LAN binding accepts only an actual private IPv4 and the exact contiguous interface prefix', () => {
  for (const good of ['10.0.0.2', '172.16.0.2', '172.31.255.254', address]) assert.equal(isPrivateIPv4(good), true);
  for (const bad of ['0.0.0.0', '127.0.0.1', '8.8.8.8', '172.15.0.1', '172.32.0.1', '169.254.0.1', 'localhost', '::1', '192.168.001.2']) {
    assert.equal(isPrivateIPv4(bad), false);
    assert.throws(() => validateLanBinding(bad, 24, interfaces), /私有 IPv4/);
  }
  assert.deepEqual(validateLanBinding(address, 24, interfaces), network);
  assert.throws(() => validateLanBinding('192.168.110.34', 24, interfaces), /未绑定/);
  for (const prefix of [0, 33, 24.5, '24']) assert.throws(() => validateLanBinding(address, prefix, interfaces), /前缀/);
  assert.throws(() => validateLanBinding(address, 16, interfaces), /网卡不一致/);
  assert.throws(() => validateLanBinding(address, 24, { bad: [{ ...interfaces.WiFi[0], netmask: '255.0.255.0' }] }), /网卡不一致/);
  assert.throws(() => validateLanBinding(address, 24, { internal: [{ ...interfaces.WiFi[0], internal: true }] }), /未绑定/);
});

test('LAN subnet matching follows prefix exactly and normalizes only socket IPv4 mappings', () => {
  assert.equal(isAddressInSubnet('192.168.110.60', address, 24), true);
  assert.equal(isAddressInSubnet('::ffff:192.168.110.60', address, 24), true);
  assert.equal(isAddressInSubnet('192.168.111.60', address, 24), false);
  assert.equal(isAddressInSubnet('10.10.1.20', '10.10.0.5', 23), true);
  assert.equal(isAddressInSubnet('10.10.2.20', '10.10.0.5', 23), false);
  assert.equal(isAddressInSubnet('8.8.8.8', address, 1), false);
  assert.equal(isAddressInSubnet('192.168.110.60', address, 0), false);
  for (const local of [address, '127.0.0.1', '::1', '::ffff:127.0.0.1']) {
    assert.equal(isLocalLanClient(local, address), true); assert.equal(isAllowedLanClient(local, network), true);
  }
  assert.equal(isLocalLanClient('192.168.110.60', address), false);
  assert.equal(isAllowedLanClient('192.168.111.60', network), false);
});

test('LAN CLI is explicit and refuses unsafe or production starts before any database or credential access', () => {
  assert.deepEqual(parseLanArguments(['--address', address, '--prefix-length', '24']), network);
  assert.deepEqual(parseLanArguments(['--prefix-length', '24', '--address', address]), network);
  for (const args of [[], ['--address', address], ['--address', address, '--address', address],
    ['--address', address, '--prefix-length', '24.5'], ['--address', address, '--prefix-length', '24', '--port', '5187']])
    assert.throws(() => parseLanArguments(args));
  const entry = fileURLToPath(new URL('../../server/lan-index.mjs', import.meta.url));
  const production = spawnSync(process.execPath, [entry, '--address', address, '--prefix-length', '24'],
    { env: { ...process.env, NODE_ENV: 'production' }, encoding: 'utf8' });
  assert.equal(production.status, 1); assert.match(production.stderr, /不能作为生产环境/);
  const unsafe = spawnSync(process.execPath, [entry, '--address', '0.0.0.0', '--prefix-length', '24'],
    { env: { ...process.env, NODE_ENV: 'test' }, encoding: 'utf8' });
  assert.equal(unsafe.status, 1); assert.match(unsafe.stderr, /私有 IPv4/);
});

test('LAN policy rejects other subnets and public socket sources before all routes regardless of forwarding headers', async t => {
  const { request } = await setup(t);
  for (const source of ['192.168.111.60', '10.0.0.4', '203.0.113.2', '::ffff:203.0.113.2']) {
    for (const path of ['/health', '/plans', '/content', '/me']) {
      const result = await request(path, { source, headers: { 'x-forwarded-for': address, forwarded: `for=${address}`, 'x-real-ip': address } });
      assert.equal(result.status, 403);
    }
  }
  const health = await request('/health');
  assert.equal(health.status, 200); assert.equal(health.body.mode, 'lan-trial');
  assert.equal(health.body.paymentReady, false); assert.deepEqual(health.body.nativeAuth, { localTrial: true, wechat: false });
  const local = await setup(t, { lanNetwork: undefined, mode: undefined });
  assert.equal((await local.request('/health')).body.mode, 'local-trial');
});

test('LAN phones cannot use web authentication or administrator routes; the selected local address can', async t => {
  const { db, request } = await setup(t);
  insertUser(db, 'lan_admin', await hashPassword(password), 'admin');
  for (const path of ['/auth/register', '/auth/login', '/auth/logout', '/admin/orders', '/admin/members', '/admin/audit']) {
    const result = await request(path, { body: path.startsWith('/auth/') ? { username: 'lan_admin', password, consent: true } : undefined,
      headers: { 'x-forwarded-for': address, 'x-club-client': 'native', host: '127.0.0.1:5196' } });
    assert.equal(result.status, 403);
  }
  const web = await request('/auth/login', { source: address, body: { username: 'lan_admin', password },
    headers: { host: '127.0.0.1:5196', origin: 'http://127.0.0.1:5196' } });
  assert.equal(web.status, 200);
  const cookie = web.headers['Set-Cookie'].split(';')[0];
  for (const source of [address, '127.0.0.1', '::1'])
    assert.equal((await request('/admin/orders', { source, cookie, headers: { host: 'localhost:5196', origin: 'http://localhost:5196' } })).status, 200);
  assert.equal((await request('/admin/orders', { cookie })).status, 403);
  assert.equal((await request('/admin/orders', { source: address })).status, 401);
});

test('LAN native member flow retains Host/Origin/write checks, transport isolation, ownership and payment closure', async t => {
  const { db, request } = await setup(t);
  const signup = await request('/native/auth/register', { body: { username: 'lan_member', password, consent: true, role: 'admin' } });
  assert.equal(signup.status, 201); assert.equal(signup.body.user.role, 'member');
  const token = signup.body.accessToken;
  const body = { planId: 'basic', consent: true, form: { name: '隔离 LAN 测试', phone: '13800000000', city: '上海' } };
  for (const headers of [{ host: 'evil.example' }, { origin: 'https://evil.example' }, { origin: 'null' },
    { 'sec-fetch-site': 'cross-site' }, { 'x-club-request': '' }])
    assert.equal((await request('/orders', { body, token, headers: { ...headers, 'idempotency-key': randomUUID(), 'x-club-client': 'native' } })).status, 403);
  assert.equal((await request('/orders', { body, token, headers: { 'content-type': 'text/plain' } })).status, 415);
  assert.equal((await request('/me', { token, cookie: 'club_session=invalid' })).status, 400);
  assert.equal((await request('/me', { token: 'not-a-token' })).status, 401);
  const key = randomUUID();
  const order = await request('/orders', { body, token, headers: { 'idempotency-key': key } });
  assert.equal(order.status, 201);
  assert.equal((await request('/orders', { body, token, headers: { 'idempotency-key': key } })).body.order.id, order.body.order.id);
  const other = await request('/native/auth/register', { body: { username: 'lan_other', password, consent: true } });
  assert.equal((await request(`/orders/${order.body.order.id}`, { token: other.body.accessToken })).status, 404);
  assert.equal((await request(`/orders/${order.body.order.id}/payment`, { body: {}, token })).status, 503);
  assert.equal(db.prepare('SELECT count(*) n FROM memberships').get().n, 0);
});

test('two local browser environments use distinct cookies and logging out revokes only the matching session', async t => {
  const original = await setup(t, { lanNetwork: undefined, mode: undefined, cookieName: 'club_session' });
  const lan = await setup(t);
  const originalUser = insertUser(original.db, 'original_admin', await hashPassword(password), 'admin');
  const lanUser = insertUser(lan.db, 'lan_admin', await hashPassword(password), 'admin');
  const a = await original.request('/auth/login', { source: address, body: { username: originalUser.username, password } });
  const b = await lan.request('/auth/login', { source: address, body: { username: lanUser.username, password } });
  assert.equal(a.status, 200); assert.equal(b.status, 200);
  assert.match(a.headers['Set-Cookie'], /^club_session=/);
  assert.match(b.headers['Set-Cookie'], /^club_lan_session=/);
  const both = [a, b].map(result => result.headers['Set-Cookie'].split(';')[0]).join('; ');
  assert.equal((await original.request('/me', { source: address, cookie: both })).body.user.id, originalUser.id);
  assert.equal((await lan.request('/me', { source: address, cookie: both })).body.user.id, lanUser.id);
  const signout = await original.request('/auth/logout', { source: address, cookie: both, body: {} });
  assert.equal(signout.status, 200); assert.match(signout.headers['Set-Cookie'], /^club_session=;/);
  assert.ok(!signout.headers['Set-Cookie'].includes('club_lan_session'));
  assert.equal((await original.request('/me', { source: address, cookie: both })).body.user, null);
  assert.equal((await lan.request('/me', { source: address, cookie: both })).body.user.id, lanUser.id);
  assert.equal(lan.db.prepare('SELECT count(*) n FROM sessions').get().n, 1);
  const lanSignout = await lan.request('/auth/logout', { source: address, cookie: both, body: {} });
  assert.match(lanSignout.headers['Set-Cookie'], /^club_lan_session=;/);
  assert.equal(lan.db.prepare('SELECT count(*) n FROM sessions').get().n, 0);
});

test('LAN cookies count as browser credentials for Bearer mixing checks; arbitrary cookie names cannot be configured', async t => {
  const { request } = await setup(t);
  const signup = await request('/native/auth/register', { body: { username: 'cookie_mix_member', password, consent: true } });
  const token = signup.body.accessToken;
  const mixed = await request('/me', { token, cookie: 'club_lan_session=invalid' });
  assert.equal(mixed.status, 400); assert.equal(mixed.body.code, 'AUTH_AMBIGUOUS');
  const exchange = await request('/native/auth/login', { cookie: 'club_lan_session=invalid', body: { username: 'cookie_mix_member', password } });
  assert.equal(exchange.status, 400);
  const db = openDatabase(':memory:');
  try { assert.throws(() => createApplication(db, { cookieName: 'untrusted; Path=/' }), /Cookie 名称/); }
  finally { db.close(); }
});
