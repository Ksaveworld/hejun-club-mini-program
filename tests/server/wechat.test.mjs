import test from 'node:test';
import assert from 'node:assert/strict';
import { createWechatAdapter } from '../../server/wechat.mjs';

const fixture = { appId: 'wx_isolated_app', appSecret: 'ISOLATED_SECRET_NOT_REAL' };
test('WeChat adapter needs complete server configuration and never requests with missing credentials', async () => {
  let calls = 0;
  for (const config of [{}, { appId: fixture.appId }, { appSecret: fixture.appSecret }]) {
    const adapter = createWechatAdapter({ ...config, fetchImpl: async () => { calls++; } });
    assert.equal(adapter.configured, false);
    await assert.rejects(adapter.exchangeCode('isolated_code'), error => error.code === 'WECHAT_NOT_CONFIGURED');
  }
  assert.equal(calls, 0);
});

test('WeChat adapter targets official HTTPS code exchange and strips session key and union identity', async () => {
  let calls = 0;
  const adapter = createWechatAdapter({ ...fixture, fetchImpl: async (url, options) => {
    calls++;
    assert.equal(url.origin, 'https://api.weixin.qq.com'); assert.equal(url.pathname, '/sns/jscode2session');
    assert.equal(url.searchParams.get('appid'), fixture.appId); assert.equal(url.searchParams.get('secret'), fixture.appSecret);
    assert.equal(url.searchParams.get('js_code'), 'isolated_code'); assert.equal(url.searchParams.get('grant_type'), 'authorization_code');
    assert.equal(options.redirect, 'error'); assert.equal(options.method, 'GET'); assert.ok(options.signal);
    return { ok: true, json: async () => ({ errcode: 0, openid: 'isolated_openid', session_key: 'ISOLATED_SESSION_KEY', unionid: 'ISOLATED_UNION_ID' }) };
  } });
  assert.deepEqual(await adapter.exchangeCode('isolated_code'), { appId: fixture.appId, openId: 'isolated_openid' });
  assert.equal(calls, 1);
});

test('WeChat adapter normalizes provider errors without forwarding errmsg or credential-bearing URLs', async () => {
  for (const [errcode, status, code] of [[40029, 401, 'WECHAT_CODE_INVALID'], [40163, 401, 'WECHAT_CODE_INVALID'],
    [40226, 403, 'FORBIDDEN'], [45011, 429, 'TOO_MANY_ATTEMPTS'], [-1, 503, 'WECHAT_UNAVAILABLE'], [40013, 503, 'WECHAT_UNAVAILABLE']]) {
    const adapter = createWechatAdapter({ ...fixture, fetchImpl: async () => ({ ok: true, json: async () => ({ errcode, errmsg: fixture.appSecret }) }) });
    await assert.rejects(adapter.exchangeCode('isolated_code'), error => error.status === status && error.code === code && !error.message.includes(fixture.appSecret));
  }
  const failed = createWechatAdapter({ ...fixture, fetchImpl: async url => { throw new Error(`network ${url}`); } });
  await assert.rejects(failed.exchangeCode('isolated_code'), error => error.status === 503 && !error.message.includes(fixture.appSecret));
});

test('WeChat adapter rejects malformed responses and invalid codes; no partial identity succeeds', async () => {
  const cases = [null, [], {}, { openid: 'isolated_openid' }, { openid: '', session_key: 'test' },
    { errcode: '0', openid: 'isolated_openid', session_key: 'test' }];
  for (const data of cases) {
    const adapter = createWechatAdapter({ ...fixture, fetchImpl: async () => ({ ok: true, json: async () => data }) });
    await assert.rejects(adapter.exchangeCode('isolated_code'), error => error.status === 503);
  }
  for (const response of [{ ok: false }, { ok: true, json: async () => { throw new Error(fixture.appSecret); } }]) {
    const adapter = createWechatAdapter({ ...fixture, fetchImpl: async () => response });
    await assert.rejects(adapter.exchangeCode('isolated_code'), error => error.status === 503 && !error.message.includes(fixture.appSecret));
  }
  let called = false;
  const adapter = createWechatAdapter({ ...fixture, fetchImpl: async () => { called = true; } });
  for (const code of ['', 'has space', 'x'.repeat(513), null])
    await assert.rejects(adapter.exchangeCode(code), error => error.status === 400);
  assert.equal(called, false);
});
