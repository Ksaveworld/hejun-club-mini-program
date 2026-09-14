import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { request } from 'node:http';
import { randomUUID } from 'node:crypto';
import vm from 'node:vm';
import { openDatabase } from '../../server/db.mjs';
import { createApplication } from '../../server/app.mjs';
import { createOrder, applyVerifiedPayment, hashPassword, insertUser } from '../../server/domain.mjs';

const password = 'IsolatedPostTestPassword1';
const article = { title: '隔离文字投稿', body: '第一段经验。\n第二段观察。<script>仅作为文字</script>' };
async function setup(t) {
  const db = openDatabase(':memory:');
  const server = createApplication(db, { allowNativeTrialAuth: true, hosts: ['127.0.0.1'], origins: ['http://127.0.0.1'] });
  await new Promise((resolve, reject) => { server.once('error', reject); server.listen(0, '127.0.0.1', resolve); });
  t.after(async () => { server.closeAllConnections(); await new Promise(resolve => server.close(resolve)); db.close(); });
  const base = `http://127.0.0.1:${server.address().port}/api`;
  function http(path, body, headers = {}) {
    return new Promise((resolve, reject) => {
      const req = request(base + path, { method: body === undefined ? 'GET' : 'POST', headers: { Host: '127.0.0.1',
        'Content-Type': 'application/json', 'X-Club-Request': '1', ...headers } }, res => {
        const chunks = []; res.on('data', chunk => chunks.push(chunk)); res.on('error', reject);
        res.on('end', () => resolve({ statusCode: res.statusCode, data: JSON.parse(Buffer.concat(chunks).toString('utf8')),
          cookie: res.headers['set-cookie']?.[0].split(';')[0] }));
      });
      req.on('error', reject); req.setTimeout(5000, () => req.destroy(new Error('timeout')));
      req.end(body === undefined ? undefined : JSON.stringify(body));
    });
  }
  const storage = new Map(), sent = [], navigations = [];
  let responseHook;
  const wx = {
    getStorageSync: key => storage.get(key), setStorageSync: (key, value) => storage.set(key, value), removeStorageSync: key => storage.delete(key),
    async request(options) {
      const path = options.url.slice(base.length);
      sent.push({ path, method: options.method, key: options.header['Idempotency-Key'] });
      try {
        const response = await http(path, options.data, options.header);
        if (responseHook && await responseHook(path, options, response)) return;
        options.success(response);
      } catch { options.fail({ errMsg: 'network failure' }); }
    },
    navigateTo: options => navigations.push(options.url),
  };
  const load = (file, require) => {
    const module = { exports: {} };
    vm.runInNewContext(readFileSync(new URL('../../miniprogram/' + file, import.meta.url), 'utf8'),
      { module, require, wx, getApp: () => ({ globalData: {} }), Date, Math, Promise, Error });
    return module.exports;
  };
  const referral = load('utils/referral.js');
  const client = load('utils/api.js', path => path === './referral' ? referral : { apiBaseUrl: base });
  let definition;
  vm.runInNewContext(readFileSync(new URL('../../miniprogram/pages/posts/index.js', import.meta.url), 'utf8'),
    { Page: value => { definition = value; }, require: path => path.endsWith('/drafts') ? load('utils/drafts.js') : client, wx, Error });
  const freshPage = (options = {}) => {
  const page = { ...definition, data: structuredClone(definition.data), writes: 0,
    setData(patch) { this.writes++; Object.assign(this.data, patch); } };
  page.onLoad(options); return page; };
  const page = freshPage();
  const login = (username = 'post_member', register = true) => client.loginLocal({ username, password, register });
  // Payment result injection is restricted to this disposable in-memory fixture.
  function activate(user) {
    const order = createOrder(db, user.id, { planId: 'basic', consent: true,
      form: { name: '隔离会员', phone: '13800000000', city: '测试城市' } }, randomUUID());
    const expected = { appId: 'ISOLATED_TEST', merchantId: 'ISOLATED_TEST' };
    applyVerifiedPayment(db, { ...expected, transactionId: randomUUID(), orderId: order.id, amountCents: order.amountCents,
      currency: 'CNY', status: 'SUCCESS', paidAt: new Date().toISOString() }, expected);
  }
  const fill = (values = article) => Object.entries(values).forEach(([field, value]) =>
    page.changeField({ currentTarget: { dataset: { field } }, detail: { value } }));
  async function review(id, status, reason) {
    if (!db.prepare("SELECT id FROM users WHERE username='post_admin'").get()) insertUser(db, 'post_admin', await hashPassword(password), 'admin');
    const session = await http('/auth/login', { username: 'post_admin', password });
    assert.equal(session.statusCode, 200);
    const response = await http('/admin/posts/' + id + '/review', { status, reason }, { Cookie: session.cookie });
    await http('/auth/logout', {}, { Cookie: session.cookie });
    return response;
  }
  return { db, page, freshPage, client, login, activate, fill, sent, http, review, navigations,
    hook: value => { responseHook = value; } };
}

test('guest and unpaid members cannot submit; login and membership routes remain available', async t => {
  const env = await setup(t); await env.page.refreshPosts();
  assert.equal(env.sent.length, 0); assert.equal(env.page.data.loggedIn, false);
  env.page.openLogin(); assert.equal(env.navigations[0], '/pages/login/index');
  await env.login(); await env.page.refreshPosts();
  assert.equal(env.page.data.ready, true); assert.equal(env.page.data.canSubmit, false);
  env.fill(); await env.page.submit();
  assert.equal(env.sent.filter(r => r.path === '/posts' && r.method === 'POST').length, 0);
  await assert.rejects(env.client.api('/posts', article, 'forged-post-key'), error => error.status === 403);
  assert.equal(env.db.prepare('SELECT count(*) n FROM posts').get().n, 0);
});

test('eligible member submits once, reads full original text and sees real administrator review results', async t => {
  const env = await setup(t), user = (await env.login()).user; env.activate(user);
  await env.page.refreshPosts(); env.fill(); await Promise.all([env.page.submit(), env.page.submit()]);
  assert.equal(env.page.data.posts.length, 1); assert.equal(env.page.data.selectedPost.status, 'published');
  assert.equal(env.page.data.selectedPost.body, article.body); assert.equal(env.page.data.body, '');
  const id = env.page.data.selectedId;
  assert.equal((await env.http('/content')).statusCode, 401);
  assert.equal((await env.client.api('/content')).posts.length, 1);
  assert.equal((await env.review(id, 'rejected', '')).statusCode, 400);
  assert.equal((await env.review(id, 'rejected', '请补充事实依据')).statusCode, 200);
  await env.page.refreshPosts();
  assert.equal(env.page.data.selectedPost.statusLabel, '已下架'); assert.equal(env.page.data.selectedPost.reason, '请补充事实依据');
  assert.ok(env.page.data.selectedPost.reviewedLabel);
  assert.equal((await env.review(id, 'published', '')).statusCode, 409);
  env.fill({ title: '另一篇原创稿件', body: '另一段文字，不覆盖原稿。' }); await env.page.submit();
  const secondId = env.page.data.selectedId;
  assert.equal((await env.review(secondId, 'published', '')).statusCode, 200);
  await env.page.refreshPosts(); assert.equal(env.page.data.selectedPost.statusLabel, '已发表');
  assert.equal(env.db.prepare('SELECT count(*) n FROM posts').get().n, 2);
  assert.equal(env.db.prepare("SELECT count(*) n FROM audit_log WHERE action='post.published'").get().n, 2);
});

test('lost successful post response retains text and submission key; explicit retry returns one persisted post', async t => {
  const env = await setup(t); env.activate((await env.login()).user);
  await env.page.refreshPosts(); env.fill();
  env.hook((path, options, response) => {
    if (path === '/posts' && options.method === 'POST' && response.statusCode === 201) {
      env.hook(null); options.fail({ errMsg: 'injected lost response' }); return true;
    }
  });
  await env.page.submit(); assert.equal(env.page.data.body, article.body); assert.match(env.page.data.error, /重试/);
  assert.equal(env.db.prepare('SELECT count(*) n FROM posts').get().n, 1);
  await env.page.submit();
  const writes = env.sent.filter(r => r.path === '/posts' && r.method === 'POST');
  assert.equal(writes.length, 2); assert.equal(writes[0].key, writes[1].key);
  assert.equal(env.page.data.posts.length, 1); assert.equal(env.page.data.body, '');
  assert.equal(env.db.prepare("SELECT count(*) n FROM audit_log WHERE action='post.published'").get().n, 1);
});

test('expired session hides private text; same member login restores the draft but another member clears it', async t => {
  const env = await setup(t); const first = (await env.login()).user; env.activate(first);
  await env.page.refreshPosts(); env.fill();
  env.db.prepare('DELETE FROM native_sessions WHERE user_id=?').run(first.id);
  await env.page.submit(); assert.equal(env.page.data.loggedIn, false); assert.equal(env.page.data.body, '');
  await env.login('post_member', false); await env.page.refreshPosts();
  assert.equal(env.page.data.body, article.body);
  const second = (await env.login('post_second')).user; env.activate(second);
  await env.page.refreshPosts(); assert.equal(env.page.data.body, ''); assert.equal(env.page.data.posts.length, 0);
  await env.page.submit(); assert.equal(env.db.prepare('SELECT count(*) n FROM posts').get().n, 0);
});

test('membership expiry between editing and submitting is rechecked; historical submissions remain readable', async t => {
  const env = await setup(t); const user = (await env.login()).user; env.activate(user);
  await env.page.refreshPosts(); env.fill(); await env.page.submit();
  env.fill({ title: '到期前填写', body: '到期后不能新提交' });
  env.db.prepare("UPDATE memberships SET expires_at='2000-01-01T00:00:00.000Z' WHERE user_id=?").run(user.id);
  await env.page.submit(); assert.equal(env.page.data.canSubmit, false); assert.match(env.page.data.error, /投稿权限/);
  await env.page.refreshPosts(); assert.equal(env.page.data.posts.length, 1); assert.equal(env.page.data.canSubmit, false);
  await assert.rejects(env.client.api('/posts', article, 'expired-post-key'), error => error.status === 403);
  assert.equal(env.db.prepare('SELECT count(*) n FROM posts').get().n, 1);
});

test('delayed reads after account switching never render the old author text', async t => {
  const env = await setup(t); env.activate((await env.login()).user);
  await env.page.refreshPosts(); env.fill(); await env.page.submit();
  let release, arrived;
  const waiting = new Promise(resolve => { arrived = resolve; });
  env.hook(async (path, options) => {
    if (path === '/posts' && options.method === 'GET') {
      await new Promise(resolve => { release = resolve; arrived(); });
    }
  });
  const read = env.page.refreshPosts(); await waiting;
  await env.login('another_member'); release(); await read;
  assert.equal(env.page.data.posts.length, 0); assert.equal(env.page.data.selectedPost, null); assert.equal(env.page.data.body, '');
  assert.equal(env.client.hasSession(), true);
  env.hook(null); await env.page.refreshPosts(); assert.equal(env.page.data.posts.length, 0);
});

test('unloaded post page ignores responses and empty or oversized text cannot create submissions', async t => {
  const env = await setup(t); env.activate((await env.login()).user); await env.page.refreshPosts();
  for (const value of [{ title: '', body: '正文' }, { title: 'a'.repeat(61), body: '正文' }, { title: '标题', body: 'b'.repeat(2001) }]) {
    env.fill(value); await env.page.submit(); assert.match(env.page.data.error, /最多/);
  }
  assert.equal(env.sent.filter(r => r.path === '/posts' && r.method === 'POST').length, 0);
  let release, arrived;
  const waiting = new Promise(resolve => { arrived = resolve; });
  env.hook(async path => { if (path === '/posts') await new Promise(resolve => { release = resolve; arrived(); }); });
  const read = env.page.refreshPosts(); await waiting; env.page.onUnload(); const count = env.page.writes;
  release(); await read; assert.equal(env.page.writes, count);
});


test('a fresh form restores only this member draft, and confirmed submission clears it',async t=>{
 const e=await setup(t);const identity=await e.login();
 e.activate(identity.user);
 const first=e.freshPage({mode:'new'});await first.onShow();
 for(const [field,value] of Object.entries(article))first.changeField({currentTarget:{dataset:{field}},detail:{value}});
 first.onHide();first.onUnload();
 const resumed=e.freshPage({mode:'new'});await resumed.onShow();assert.equal(resumed.data.title,article.title);assert.equal(resumed.data.body,article.body);
 await resumed.submit();const clean=e.freshPage({mode:'new'});await clean.onShow();assert.equal(clean.data.title,'');assert.equal(clean.data.body,'');
});
