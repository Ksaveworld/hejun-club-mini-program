import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { request } from 'node:http';
import vm from 'node:vm';
import { openDatabase } from '../../server/db.mjs';
import { createApplication } from '../../server/app.mjs';
import { insertUser, hashPassword } from '../../server/domain.mjs';

const password = 'IsolatedRecoveryPassword1';
const form = { name: '隔离联验会员', phone: '13800000000', city: '测试城市', company: '测试机构',
  industry: '', need: '', organizationType: '机构会员', referral: '' };

async function setup(t) {
  const db = openDatabase(':memory:');
  const server = createApplication(db, { allowNativeTrialAuth: true, hosts: ['127.0.0.1'], origins: ['http://127.0.0.1'] });
  await new Promise((resolve, reject) => { server.once('error', reject); server.listen(0, '127.0.0.1', resolve); });
  t.after(async () => { server.closeAllConnections(); await new Promise(resolve => server.close(resolve)); db.close(); });
  const base = `http://127.0.0.1:${server.address().port}/api`;
  async function adminReview(id, note, decision = 'approve') {
    insertUser(db, 'recovery_admin', await hashPassword(password), 'admin');
    let cookie;
    const post = (path, body) => new Promise((resolve, reject) => {
      const req = request(base + path, { method: 'POST', headers: { Host: '127.0.0.1', 'Content-Type': 'application/json',
        'X-Club-Request': '1', ...(cookie ? { Cookie: cookie } : {}) } }, res => {
        const chunks = []; res.on('data', chunk => chunks.push(chunk)); res.on('error', reject);
        res.on('end', () => {
          if (res.headers['set-cookie']) cookie = res.headers['set-cookie'][0].split(';')[0];
          const body = JSON.parse(Buffer.concat(chunks).toString('utf8'));
          if (res.statusCode !== 200) reject(new Error(body.error)); else resolve(body);
        });
      });
      req.on('error', reject); req.end(JSON.stringify(body));
    });
    await post('/auth/login', { username: 'recovery_admin', password });
    await post('/admin/orders/' + id + '/review', { decision, note });
    await post('/auth/logout', {});
  }
  function phone() {
    const storage = new Map(), sent = [], navigations = [];
    let drop = null;
    const wx = {
      getStorageSync: key => storage.get(key), setStorageSync: (key, value) => storage.set(key, value),
      removeStorageSync: key => storage.delete(key),
      request(options) {
        const path = options.url.slice(base.length);
        sent.push({ path, method: options.method, key: options.header['Idempotency-Key'] });
        const req = request(options.url, { method: options.method, headers: { ...options.header, Host: '127.0.0.1' } }, res => {
          const chunks = [];
          res.on('data', chunk => chunks.push(chunk));
          res.on('end', () => {
            const response = { statusCode: res.statusCode, data: JSON.parse(Buffer.concat(chunks).toString('utf8')) };
            // The real backend has processed the request. Discard only the
            // selected response at the wx transport boundary, without retrying.
            if (drop && drop(path, options.method, response.statusCode)) {
              drop = null; options.fail({ errMsg: 'injected response loss' });
            } else options.success(response);
          });
          res.on('error', () => options.fail({ errMsg: 'response error' }));
        });
        req.setTimeout(5000, () => req.destroy(new Error('request timeout')));
        req.on('error', () => options.fail({ errMsg: 'request error' }));
        req.end(options.data === undefined ? undefined : JSON.stringify(options.data));
      },
      redirectTo: options => navigations.push(options.url), navigateTo: options => navigations.push(options.url),
      pageScrollTo() {}, showModal: options => options.success({ confirm: true }),
    };
    const load = (path, require) => {
      const module = { exports: {} };
      vm.runInNewContext(readFileSync(new URL('../../miniprogram/' + path, import.meta.url), 'utf8'),
        { module, require, wx, getApp: () => ({ globalData: {} }), Date, Math, Promise, Error });
      return module.exports;
    };
    const referral = load('utils/referral.js');
    const api = load('utils/api.js', path => path === './referral' ? referral : { apiBaseUrl: base });
    function page(name) {
      let definition;
      vm.runInNewContext(readFileSync(new URL('../../miniprogram/pages/' + name + '/index.js', import.meta.url), 'utf8'), {
        Page: value => { definition = value; }, wx, Error,
        require: path => path === '../../utils/drafts' ? load('utils/drafts.js') : path === '../../utils/api' ? api : { plans: [{ id: 'organization', name: '机构及专业会员' }] },
      });
      return { ...definition, data: structuredClone(definition.data), setData(patch) { Object.assign(this.data, patch); } };
    }
    return { api, page, sent, navigations, dropNext: predicate => { drop = predicate; } };
  }
  const device = phone();
  const identity = await device.api.loginLocal({ username: 'recovery_member', password, register: true });
  const join = device.page('join'); join.onLoad({ planId: 'organization' }); await join.loadContext();
  join.setData({ form: { ...form }, consent: true });
  return { db, phone, device, identity, join, adminReview };
}

test('HTTP: lost successful application response retries one saved order and a second client reads that same order', async t => {
  const { db, phone, device, join, identity } = await setup(t);
  device.dropNext((path, method, status) => path === '/orders' && method === 'POST' && status === 201);
  await join.submit();
  const saved = db.prepare('SELECT * FROM orders').get();
  assert.equal(saved.user_id, identity.user.id); assert.equal(saved.status, 'review');
  assert.equal(device.navigations.length, 0); assert.match(join.data.error, /重试/);
  assert.deepEqual(join.data.form, form); assert.equal(join.data.busy, false);
  const posts = () => device.sent.filter(r => r.path === '/orders' && r.method === 'POST');
  assert.equal(posts().length, 1);
  await join.submit();
  assert.equal(posts().length, 2); assert.equal(posts()[0].key, posts()[1].key);
  assert.equal(db.prepare('SELECT count(*) n FROM orders').get().n, 1);
  assert.equal(db.prepare("SELECT count(*) n FROM audit_log WHERE action='order.created'").get().n, 1);
  assert.deepEqual(device.navigations, ['/pages/orders/index?id=' + saved.id]);

  const second = phone();
  const same = await second.api.loginLocal({ username: 'recovery_member', password });
  assert.equal(same.user.id, identity.user.id);
  const orders = second.page('orders'); orders.onLoad({ id: saved.id }); await orders.refreshOrders();
  assert.equal(orders.data.selectedOrder.id, saved.id); assert.equal(orders.data.selectedOrder.form.name, form.name);
  assert.equal(db.prepare('SELECT count(*) n FROM memberships').get().n, 0);
  assert.equal(db.prepare('SELECT count(*) n FROM payment_receipts').get().n, 0);
});

test('HTTP: lost cancellation result refreshes to the saved terminal state with review history intact', async t => {
  const { db, device, join, adminReview } = await setup(t); await join.submit();
  const id = db.prepare('SELECT id FROM orders').get().id;
  const note = '隔离审核说明：验证原记录保留，不代表实际资质认定';
  await adminReview(id, note);
  const orders = device.page('orders'); orders.onLoad({ id }); await orders.refreshOrders();
  assert.equal(orders.data.selectedOrder.status, 'pending');
  device.dropNext((path, method, status) => path === '/orders/' + id + '/cancel' && method === 'POST' && status === 200);
  await orders.cancelOrder();
  assert.equal(db.prepare('SELECT status FROM orders WHERE id=?').get(id).status, 'cancelled');
  assert.match(orders.data.error, /结果暂未确认.*刷新/);
  assert.equal(orders.data.selectedOrder, null); assert.equal(orders.data.orders.length, 0);
  await orders.cancelOrder();
  assert.equal(device.sent.filter(r => r.path.endsWith('/cancel')).length, 1);
  await orders.refreshOrders();
  assert.equal(orders.data.selectedOrder.status, 'cancelled'); assert.equal(orders.data.selectedOrder.canCancel, false);
  assert.equal(orders.data.selectedOrder.reviewNote, note); assert.equal(orders.data.orders.length, 1);
  await orders.cancelOrder();
  assert.equal(device.sent.filter(r => r.path.endsWith('/cancel')).length, 1);
  assert.equal(db.prepare("SELECT count(*) n FROM audit_log WHERE action='order.cancelled'").get().n, 1);
  assert.equal(db.prepare('SELECT count(*) n FROM memberships').get().n, 0);
});

test('HTTP: revoked sessions recover by login; a different account cannot read or cancel the old order', async t => {
  const { db, device, identity, join } = await setup(t); await join.submit();
  const id = db.prepare('SELECT id FROM orders').get().id;
  const orders = device.page('orders'); orders.onLoad({ id }); await orders.refreshOrders();
  db.prepare('DELETE FROM native_sessions WHERE user_id=?').run(identity.user.id);
  await orders.refreshOrders();
  assert.equal(orders.data.loggedIn, false); assert.equal(orders.data.selectedOrder, null);
  assert.equal(orders.data.orders.length, 0); assert.match(orders.data.error, /重新登录/);
  await device.api.loginLocal({ username: 'recovery_member', password });
  await orders.refreshOrders(); assert.equal(orders.data.orders[0].id, id);
  await orders.toggleOrder({ currentTarget: { dataset: { orderId: id } } });

  await device.api.loginLocal({ username: 'different_member', password, register: true });
  device.dropNext((path, method) => path === '/orders' && method === 'GET');
  await orders.refreshOrders();
  assert.equal(orders.data.orders.length, 0); assert.equal(orders.data.selectedOrder, null);
  await orders.refreshOrders(); assert.equal(orders.data.orders.length, 0);
  await assert.rejects(device.api.api('/orders/' + id), error => error.status === 404);
  await assert.rejects(device.api.api('/orders/' + id + '/cancel', {}), error => error.status === 404);
  assert.equal(db.prepare('SELECT status FROM orders WHERE id=?').get(id).status, 'review');
});


test('HTTP: reopening the application restores the saved draft and submission key after a lost response', async t => {
 const {db,device,join}=await setup(t);
 device.dropNext((path,method,status)=>path==='/orders'&&method==='POST'&&status===201);
 await join.submit();assert.match(join.data.draftNote,/草稿已保存/);join.onUnload();
 const reopened=device.page('join');reopened.onLoad({planId:'organization'});await reopened.loadContext();
 assert.deepEqual(JSON.parse(JSON.stringify(reopened.data.form)),form);assert.equal(reopened.data.consent,false);assert.match(reopened.data.draftNote,/恢复/);
 reopened.changeConsent({detail:{value:['agree']}});await reopened.submit();
 const writes=device.sent.filter(r=>r.path==='/orders'&&r.method==='POST');assert.equal(writes.length,2);assert.equal(writes[0].key,writes[1].key);
 assert.equal(db.prepare('SELECT count(*) n FROM orders').get().n,1);
 const fresh=device.page('join');fresh.onLoad({planId:'organization'});await fresh.loadContext();assert.equal(fresh.data.form.name,'');
});

test('HTTP: rejected application prefills a new application without changing the original order or recommendation',async t=>{
 const {db,device,join,adminReview}=await setup(t);await join.submit();const original=db.prepare('SELECT id FROM orders').get().id;
 await adminReview(original,'请补充所在城市','reject');
 const next=device.page('join');next.onLoad({planId:'organization',reapplyId:original});await next.loadContext();
 assert.equal(next.data.form.name,form.name);assert.equal(next.data.consent,false);assert.match(next.data.reapplyNote,/原申请记录/);
 next.setData({form:{...next.data.form,city:'补充后的城市'},consent:true});await next.submit();
 const records=await device.api.api('/orders');assert.equal(records.orders.length,2);
 const old=await device.api.api('/orders/'+original);assert.equal(old.order.status,'rejected');assert.equal(old.order.reviewNote,'请补充所在城市');assert.equal(old.order.form.city,form.city);
 const submitted=records.orders.find(order=>order.id!==original);assert.equal(submitted.status,'review');
 await device.api.loginLocal({username:'other_draft_owner',password,register:true});
 const forbidden=device.page('join');forbidden.onLoad({planId:'organization',reapplyId:original});await forbidden.loadContext();assert.equal(forbidden.data.planReady,false);assert.equal(forbidden.data.form.name,'');
});
