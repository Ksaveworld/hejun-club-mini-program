import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import vm from 'node:vm';
const journeyModule = {exports:{}};
vm.runInNewContext(readFileSync(new URL('../../miniprogram/utils/member-journey.js',import.meta.url),'utf8'),{module:journeyModule,require:()=>({plans:[]})});
const journey = journeyModule.exports;

const source = readFileSync(new URL('../../miniprogram/pages/account/index.js', import.meta.url), 'utf8');
function setup() {
  let definition, version = 1, loggedIn = true, failure = false, response = null;
  let user = { id: 'member-a', role: 'member', username: 'trial', referralCode: 'OWN123', sourceCode: 'UPR456' };
  const api = {
    api: async () => { if (failure) throw new Error('offline'); return response ? response() : { user }; },
    clearSession: () => { loggedIn = false; version++; }, hasSession: () => loggedIn,
    sessionStamp: () => ({ version }), isCurrentSession: stamp => stamp.version === version
  };
  vm.runInNewContext(source, { Page: value => { definition = value; }, require: path => path === '../../utils/api' ? api : path === '../../utils/member-journey' ? journey : { plans: [] }, wx: {} });
  const page = { ...definition, data: structuredClone(definition.data), setData: patch => Object.assign(page.data, patch) };
  return { page, setUser: value => { user = value; version++; }, offline: () => { failure = true; }, logout: api.clearSession,
    defer: () => { let finish; response = () => new Promise(resolve => { finish = resolve; }); return value => finish(value); } };
}

test('sharing uses the current member own code, never their upstream source or identity credentials', async () => {
  const { page } = setup(); await page.refreshAccount();
  const result = page.onShareAppMessage();
  assert.equal(result.path, '/pages/home/index?ref=OWN123');
  assert.equal(result.path.includes('UPR456'), false);
  assert.equal(result.path.includes('member-a'), false);
  assert.equal(page.data.shareReady, true);
});

test('a late account read cannot bless old profile data with the newer session stamp', async () => {
  const env = setup(), finish = env.defer();
  const pending = env.page.refreshAccount();
  env.setUser({ id: 'member-b', role: 'member', referralCode: 'NEW789' });
  finish({ user: { id: 'member-a', role: 'member', referralCode: 'OLD123' } });
  await pending;
  assert.equal(env.page.data.shareReady, false); assert.equal(env.page.data.user, null);
  assert.equal(env.page.onShareAppMessage().path, '/pages/home/index');
});

test('stale account data after a session change or logout cannot generate an old owner referral link', async () => {
  const env = setup(); await env.page.refreshAccount();
  env.setUser({ id: 'member-b', role: 'member', referralCode: 'NEW789' });
  assert.equal(env.page.onShareAppMessage().path, '/pages/home/index');
  await env.page.refreshAccount(); assert.equal(env.page.onShareAppMessage().path, '/pages/home/index?ref=NEW789');
  env.logout(); assert.equal(env.page.onShareAppMessage().path, '/pages/home/index');
});

test('unavailable identity and administrator accounts only produce a generic introduction', async () => {
  const env = setup(); await env.page.refreshAccount(); env.offline(); await env.page.refreshAccount();
  assert.equal(env.page.data.shareReady, false); assert.equal(env.page.onShareAppMessage().path, '/pages/home/index');
  const admin = setup(); admin.setUser({ id: 'admin', role: 'admin', referralCode: 'ADM123' });
  await admin.page.refreshAccount(); assert.equal(admin.page.data.shareReady, false);
  assert.equal(admin.page.onShareAppMessage().path, '/pages/home/index');
});
