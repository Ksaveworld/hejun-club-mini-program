import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import vm from 'node:vm';
const journeyModule = {exports:{}};
vm.runInNewContext(readFileSync(new URL('../../miniprogram/utils/member-journey.js',import.meta.url),'utf8'),{module:journeyModule,require:()=>({plans:[]})});
const journey = journeyModule.exports;

// Exercise real session storage and request handling together with page state.
function setup(name = 'orders') {
  const storage = new Map(), requests = [], pending = [], modals = [], patches = [];
  const wx = {
    getStorageSync: key => storage.get(key), setStorageSync: (key, value) => storage.set(key, value),
    removeStorageSync: key => storage.delete(key),
    request: options => { requests.push(options); if(options.url.endsWith('/feedback/summary')) options.success({statusCode:200,data:{unreadCount:0}}); else pending.push(options); },
    showModal: options => modals.push(options), pageScrollTo() {},
  };
  const load = (path, require) => {
    const module = { exports: {} };
    vm.runInNewContext(readFileSync(new URL('../../miniprogram/' + path, import.meta.url), 'utf8'),
      { module, require, wx, getApp: () => ({ globalData: {} }), Date, Math, Promise, Error });
    return module.exports;
  };
  const referral = load('utils/referral.js');
  const client = load('utils/api.js', path => path === './referral' ? referral : { apiBaseUrl: 'http://127.0.0.1:5187/api' });
  let definition;
  vm.runInNewContext(readFileSync(new URL('../../miniprogram/pages/' + name + '/index.js', import.meta.url), 'utf8'), {
    Page: value => { definition = value; }, wx, Error,
    require: path => path === '../../utils/drafts' ? load('utils/drafts.js') : path === '../../utils/api' ? client : path === '../../utils/member-journey' ? journey : { plans: [{ id: 'basic', name: '基础会员' }] },
  });
  const page = { ...definition, data: structuredClone(definition.data),
    setData(patch) { patches.push(patch); Object.assign(this.data, patch); } };
  const login = (letter = 'a') => client.saveSession({ tokenType: 'Bearer', accessToken: letter.repeat(64),
    expiresAt: '2099-01-01T00:00:00Z', user: { id: letter } });
  login();
  return { page, client, login, requests, pending, modals, patches,
    respond(data, statusCode = 200) { pending.shift().success({ statusCode, data }); },
    offline() { pending.shift().fail({ errMsg: 'request:fail timeout' }); } };
}
const order = { id: 'ORDER_A', planId: 'basic', status: 'pending', amountCents: 36500,
  form: { name: '甲的私有资料', phone: '13800000000' } };
const user = { id: 'a', username: 'member_a', role: 'member', referralCode: 'AAA111' };
async function fillOrders(env) {
  const list = env.page.refreshOrders(); env.respond({ orders: [order] }); await list;
  const detail = env.page.toggleOrder({ currentTarget: { dataset: { orderId: order.id } } });
  env.respond({ order }); await detail;
}
async function fillAccount(env) {
  const read = env.page.refreshAccount(); env.respond({ user, membership: { active: true, planId: 'basic', expiresAt: '2099-01-01' } });
  await new Promise(resolve=>setImmediate(resolve)); env.respond({orders:[]}); await read;
}

test('switching account clears old order list and contact details even when the next read times out', async () => {
  const env = setup(); await fillOrders(env); env.login('b');
  const read = env.page.refreshOrders();
  assert.equal(env.page.data.orders.length, 0); assert.equal(env.page.data.selectedOrder, null);
  assert.equal(env.page.data.selectedId, '');
  env.offline(); await read;
  assert.equal(env.page.data.orders.length, 0); assert.equal(env.page.data.selectedOrder, null);
  assert.match(env.page.data.error, /重试/); assert.equal(env.client.hasSession(), true);
  const retry = env.page.refreshOrders(); env.respond({ orders: [] }); await retry;
  assert.equal(env.page.data.error, ''); assert.equal(env.page.data.loading, false);
});

test('failed same-account refresh clears stale actionable detail and succeeds on explicit retry', async () => {
  const env = setup(); await fillOrders(env);
  const read = env.page.refreshOrders(); env.offline(); await read;
  assert.equal(env.page.data.selectedOrder, null);
  const before = env.requests.length; await env.page.cancelOrder(); assert.equal(env.requests.length, before);
  const retry = env.page.refreshOrders(); env.respond({ orders: [order] });
  await new Promise(resolve => setImmediate(resolve));
  env.respond({ order: { ...order, status: 'cancelled' } }); await retry;
  assert.equal(env.page.data.selectedOrder.canCancel, false);
});

test('late detail responses after a new login cannot render old contact data or clear the new session', async () => {
  for (const status of [200, 401]) {
    const env = setup(); const list = env.page.refreshOrders(); env.respond({ orders: [order] }); await list;
    const detail = env.page.toggleOrder({ currentTarget: { dataset: { orderId: order.id } } });
    env.login('b'); env.respond(status === 200 ? { order } : { error: 'expired' }, status); await detail;
    assert.equal(env.page.data.selectedOrder, null); assert.equal(env.page.data.orders.length, 0);
    assert.equal(env.client.hasSession(), true); assert.equal(env.client.sessionStamp().token, 'b'.repeat(64));
  }
});

test('changing session while cancel confirmation is open prevents cancellation under the new identity', async () => {
  const env = setup(); await fillOrders(env);
  const cancel = env.page.cancelOrder(); assert.equal(env.modals.length, 1);
  env.login('b'); env.modals.shift().success({ confirm: true }); await cancel;
  assert.equal(env.requests.filter(r => r.method === 'POST').length, 0);
  assert.equal(env.page.data.selectedOrder, null); assert.match(env.page.data.error, /重新读取/);
});

test('stale order buttons are refused before opening a confirmation or making a request', async () => {
  const env = setup(); await fillOrders(env); env.login('b');
  const before = env.requests.length; await env.page.cancelOrder();
  assert.equal(env.requests.length, before); assert.equal(env.modals.length, 0);
  assert.equal(env.page.data.orders.length, 0);
});

test('expired order session clears private data and the same member can log in and reload', async () => {
  const env = setup(); await fillOrders(env);
  const read = env.page.refreshOrders(); env.respond({ error: 'expired' }, 401); await read;
  assert.equal(env.page.data.loggedIn, false); assert.equal(env.page.data.orders.length, 0);
  assert.equal(env.page.data.selectedOrder, null); assert.match(env.page.data.error, /重新登录/);
  env.login(); const retry = env.page.refreshOrders(); env.respond({ orders: [order] }); await retry;
  assert.equal(env.page.data.orders[0].id, order.id); assert.equal(env.page.data.error, '');
});

test('returning account page removes the old identity and membership before a failed read', async () => {
  const env = setup('account'); await fillAccount(env); env.login('b');
  const read = env.page.refreshAccount();
  assert.equal(env.page.data.user, null); assert.equal(env.page.data.membership, null);
  env.offline(); await read;
  assert.equal(env.page.data.user, null); assert.equal(env.page.data.shareReady, false);
  const retry = env.page.refreshAccount(); env.respond({ user: { ...user, id: 'b', username: 'member_b' } });
  await new Promise(resolve=>setImmediate(resolve)); env.respond({orders:[]}); await retry;
  assert.equal(env.page.data.user.username, 'member_b'); assert.equal(env.page.data.membership, null);
});

test('stale account logout cannot revoke the new session', async () => {
  const env = setup('account'); await fillAccount(env); env.login('b');
  const before = env.requests.length; await env.page.logout();
  assert.equal(env.requests.length, before); assert.equal(env.client.sessionStamp().token, 'b'.repeat(64));
  assert.equal(env.page.data.user, null);
});

test('a 401 page callback cannot clear a login saved after the request handler processed expiry', async () => {
  for (const name of ['orders', 'account', 'join']) {
    const env = setup(name);
    if (name === 'join') env.page.onLoad({ planId: 'basic' });
    const read = name === 'orders' ? env.page.refreshOrders() : name === 'account' ? env.page.refreshAccount() : env.page.loadContext();
    env.respond({ error: 'expired' }, 401); env.login('b'); await read;
    assert.equal(env.client.sessionStamp().token, 'b'.repeat(64));
  }
});

test('unloaded pages ignore late request results without writing page state', async () => {
  for (const name of ['orders', 'account']) {
    const env = setup(name);
    const read = name === 'orders' ? env.page.refreshOrders() : env.page.refreshAccount();
    env.page.onUnload(); const before = env.patches.length;
    env.respond(name === 'orders' ? { orders: [order] } : { user }); await read;
    assert.equal(env.patches.length, before);
  }
});
