import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import vm from 'node:vm';

const source = readFileSync(new URL('../../miniprogram/pages/join/index.js', import.meta.url), 'utf8');
const plan = { id: 'basic', name: '普通会员', amountCents: 39900, review: false };
const member = { id: 'trial-member', username: 'trial_member', role: 'member', sourceCode: 'ABC123', referralSource: 'explicit' };

async function setup(orderResponses) {
  let definition, session = true, keyCount = 0, clearCount = 0, activeMember = member, contextError = null;
  const requests = [], navigations = [], responses = [...orderResponses];
  const api = {
    async api(path, body, key) {
      requests.push({ path, body: body === undefined ? undefined : structuredClone(body), key });
      if (path === '/plans') return { plans: [plan], paymentReady: false };
      if (path === '/me') return { user: session ? activeMember : null, membership: null };
      if (path === '/orders' && body) {
        assert.ok(responses.length, 'an unexpected automatic order retry occurred');
        const response = responses.shift();
        if (response instanceof Error) {
          // The real API client owns 401 credential invalidation.
          if (response.status === 401) api.clearSession();
          throw response;
        }
        return response;
      }
      throw new Error('Unexpected API call: ' + path);
    },
    hasSession: () => session,
    clearSession: () => { session = false; clearCount += 1; },
    newKey: () => 'test-submission-' + (++keyCount),
    money: cents => (cents / 100).toFixed(2),
    captureReferral: () => {},
    memberContext: async () => { if (contextError) throw contextError; return api.api('/me'); },
    sessionStamp: () => ({ scope: 'backend-a' }),
    isCurrentSession: () => true,
  };
  const wx = {
    navigateTo: options => navigations.push({ type: 'navigateTo', url: options.url }),
    redirectTo: options => navigations.push({ type: 'redirectTo', url: options.url }),
  };
  vm.runInNewContext(source, {
    Page: value => { definition = value; },
    require(path) {
      if (path === '../../utils/drafts') { const module={exports:{}}; vm.runInNewContext(readFileSync(new URL('../../miniprogram/utils/drafts.js',import.meta.url),'utf8'),{module,wx}); return module.exports; }
      if (path === '../../utils/api') return api;
      if (path === '../../data/content') return { plans: [plan] };
      throw new Error('Unexpected module: ' + path);
    },
    wx,
  }, { filename: 'pages/join/index.js' });
  const page = {
    ...definition,
    data: structuredClone(definition.data),
    setData(patch) {
      for (const [path, value] of Object.entries(patch)) {
        const segments = path.split('.');
        const field = segments.pop();
        let target = this.data;
        for (const segment of segments) target = target[segment];
        target[field] = value;
      }
    },
  };
  page.onLoad({ planId: plan.id, referral: 'ABC123' });
  await page.loadContext();
  for (const [field, value] of Object.entries({ name: '内测访客', phone: '19900000000', city: '测试城市', company: '虚构公司', industry: '测试行业', need: '虚构跨境需求' })) {
    page.changeField({ currentTarget: { dataset: { field } }, detail: { value } });
  }
  page.changeConsent({ detail: { value: ['agree'] } });
  return {
    page, navigations,
    orderRequests: () => requests.filter(request => request.path === '/orders'),
    restoreSession: () => { session = true; },
    hasSession: () => session,
    clearCount: () => clearCount,
    setMember: value => { activeMember = value; },
    failContext: value => { contextError = value; },
  };
}

test('an unknown network result keeps the submission key and retries the same order only on a new submit', async () => {
  const app = await setup([new Error('请求超时，请重试。'), { order: { id: 'ORDER1', status: 'pending' } }]);
  const form = structuredClone(app.page.data.form);

  await app.page.submit();
  const first = app.orderRequests()[0];
  assert.ok(first.key);
  assert.equal(app.orderRequests().length, 1);
  assert.equal(app.page._idempotencyKey, first.key);
  assert.equal(app.page.data.busy, false);
  assert.match(app.page.data.error, /超时/);
  assert.deepEqual(app.navigations, []);
  assert.deepEqual(app.page.data.form, form);

  await app.page.submit();
  const second = app.orderRequests()[1];
  assert.equal(app.orderRequests().length, 2);
  assert.equal(second.key, first.key);
  assert.deepEqual(second.body, first.body);
  assert.deepEqual(app.navigations, [{ type: 'redirectTo', url: '/pages/orders/index?id=ORDER1' }]);
});

for (const [status, label] of [['cancelled', '取消'], ['rejected', '未通过']]) {
  test(`a retry that returns an old ${status} order requires another explicit submit with a new key`, async () => {
    const app = await setup([
      new Error('请求超时，请重试。'),
      { order: { id: 'OLDORDER', status } },
      { order: { id: 'NEWORDER', status: 'pending' } },
    ]);
    const form = structuredClone(app.page.data.form);

    await app.page.submit();
    const originalKey = app.orderRequests()[0].key;
    await app.page.submit();
    assert.equal(app.orderRequests().length, 2, 'a terminal old order must not trigger automatic resubmission');
    assert.equal(app.orderRequests()[1].key, originalKey);
    assert.equal(app.page._idempotencyKey, '');
    assert.equal(app.page.data.error, `上次申请已${label}。确认重新申请请再次提交。`);
    assert.equal(app.page.data.busy, false);
    assert.deepEqual(app.navigations, [], 'the closed order must not redirect away from the form');
    assert.deepEqual(app.page.data.form, form);

    await app.page.submit();
    assert.equal(app.orderRequests().length, 3);
    assert.ok(app.orderRequests()[2].key);
    assert.notEqual(app.orderRequests()[2].key, originalKey);
    assert.deepEqual(app.orderRequests()[2].body, app.orderRequests()[0].body);
    assert.deepEqual(app.navigations, [{ type: 'redirectTo', url: '/pages/orders/index?id=NEWORDER' }]);
  });
}

test('a 401 keeps the application and consent while requiring login before another submission', async () => {
  const expired = Object.assign(new Error('登录已过期'), { status: 401 });
  const app = await setup([expired, { order: { id: 'AFTERLOGIN', status: 'pending' } }]);
  const form = structuredClone(app.page.data.form);

  await app.page.submit();
  const originalKey = app.orderRequests()[0].key;
  assert.equal(app.hasSession(), false);
  assert.equal(app.clearCount(), 1);
  assert.equal(app.page.data.loggedIn, false);
  assert.equal(app.page.data.user, null);
  assert.equal(app.page.data.busy, false);
  assert.match(app.page.data.error, /重新登录/);
  assert.deepEqual(app.page.data.form, form);
  assert.equal(app.page.data.consent, true);
  assert.deepEqual(app.navigations, []);

  await app.page.submit();
  assert.equal(app.orderRequests().length, 1, 'expired sessions must not submit again');
  app.page.openLogin();
  assert.deepEqual(app.navigations, [{ type: 'navigateTo', url: '/pages/login/index' }]);

  // Simulate the same member returning after login; reload only server context.
  app.restoreSession();
  await app.page.loadContext();
  assert.equal(app.page.data.loggedIn, true);
  assert.equal(app.page.data.planReady, true);
  assert.deepEqual(app.page.data.form, form);
  assert.equal(app.page.data.consent, true);
  await app.page.submit();
  assert.equal(app.orderRequests().length, 2);
  assert.equal(app.orderRequests()[1].key, originalKey);
  assert.deepEqual(app.orderRequests()[1].body, app.orderRequests()[0].body);
  assert.deepEqual(app.navigations[1], { type: 'redirectTo', url: '/pages/orders/index?id=AFTERLOGIN' });
});

test('source verification failure preserves the form and prevents an order until retry succeeds', async () => {
  const app = await setup([{ order: { id: 'VERIFIED', status: 'pending' } }]);
  const form = structuredClone(app.page.data.form);
  app.failContext(new Error('推荐来源暂未确认，请重试'));
  await app.page.submit();
  assert.equal(app.orderRequests().length, 0); assert.deepEqual(app.page.data.form, form);
  assert.equal(app.page.data.consent, true); assert.match(app.page.data.error, /暂未确认/);
  app.failContext(null); await app.page.submit();
  assert.equal(app.orderRequests().length, 1); assert.equal(app.orderRequests()[0].body.form.referral, '');
});

test('switching accounts clears the old form and cannot submit old-account data', async () => {
  const app = await setup([]);
  app.setMember({ ...member, id: 'another-member' });
  await app.page.submit();
  assert.equal(app.orderRequests().length, 0); assert.equal(app.page.data.form.name, '');
  assert.equal(app.page.data.consent, false); assert.equal(app.page._idempotencyKey, '');
  assert.match(app.page.data.error, /重新填写/);
});
