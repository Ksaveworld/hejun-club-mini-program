import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { request } from 'node:http';
import { randomUUID } from 'node:crypto';
import vm from 'node:vm';
import { openDatabase } from '../../server/db.mjs';
import { createApplication } from '../../server/app.mjs';
import { insertUser, hashPassword, createOrder, applyVerifiedPayment } from '../../server/domain.mjs';
import { createArticle, transitionArticle } from '../../server/articles.mjs';

async function setup(t) {
  const db = openDatabase(':memory:');
  const server = createApplication(db, { allowNativeTrialAuth: true, hosts: ['127.0.0.1'], origins: ['http://127.0.0.1'] });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  t.after(async () => { server.closeAllConnections(); await new Promise(resolve => server.close(resolve)); db.close(); });
  const base = `http://127.0.0.1:${server.address().port}/api`, storage = new Map();
  let hook;
  const wx = { getStorageSync: key => storage.get(key), setStorageSync: (key, value) => storage.set(key, value), removeStorageSync: key => storage.delete(key),
    request(options) {
      const req = request(options.url, { method: options.method, headers: { ...options.header, Host: '127.0.0.1' } }, res => {
        const chunks = []; res.on('data', chunk => chunks.push(chunk));
        res.on('end', () => {
          const response = { statusCode: res.statusCode, data: JSON.parse(Buffer.concat(chunks).toString('utf8')) };
          if (!hook || !hook(options, response)) options.success(response);
        });
      });
      req.on('error', options.fail); req.setTimeout(5000, () => req.destroy());
      req.end(options.data === undefined ? undefined : JSON.stringify(options.data));
    } };
  const load = (file, require) => {
    const module = { exports: {} };
    vm.runInNewContext(readFileSync(new URL('../../miniprogram/' + file, import.meta.url), 'utf8'),
      { module, require, wx, getApp: () => ({ globalData: {} }), Date, Math, Promise, Error });
    return module.exports;
  };
  const referral = load('utils/referral.js');
  const client = load('utils/api.js', path => path === './referral' ? referral : { apiBaseUrl: base });
  let definition;
  vm.runInNewContext(readFileSync(new URL('../../miniprogram/pages/articles/index.js', import.meta.url), 'utf8'),
    { Page: value => { definition = value; }, require: () => client, wx, Error });
  const page = { ...definition, data: structuredClone(definition.data), writes: 0,
    setData(patch) { this.writes++; Object.assign(this.data, patch); } };
  page.onLoad();
  const admin = insertUser(db, 'article_admin', await hashPassword('FixturePassword1'), 'admin');
  function publish(category, visibility = 'public') {
    const article = createArticle(db, admin, { title: category + '测试资料', summary: '说明文字', body: '<b>按原文显示</b>\n第二段', category,
      access: { visibility, planIds: visibility === 'plans' ? ['basic'] : [] } }, randomUUID());
    return transitionArticle(db, admin, article.id, 'publish', article.revision);
  }
  async function member(username = 'article_member') {
    const user = (await client.loginLocal({ username, password: 'FixturePassword1', register: true })).user;
    const order = createOrder(db, user.id, { planId: 'basic', consent: true, form: { name: '隔离会员', phone: '13800000000', city: '测试城市' } }, randomUUID());
    const expected = { appId: 'ISOLATED_ARTICLES', merchantId: 'ISOLATED_ARTICLES' };
    applyVerifiedPayment(db, { ...expected, transactionId: randomUUID(), orderId: order.id, amountCents: order.amountCents,
      currency: 'CNY', status: 'SUCCESS', paidAt: new Date().toISOString() }, expected);
    return user;
  }
  return { db, page, client, publish, member, admin, hook: value => { hook = value; },
    open: article => page.openArticle({ currentTarget: { dataset: { id: article.id } } }) };
}

test('reader loads public metadata, filters category/search, fetches plain text detail and handles empty results', async t => {
  const env = await setup(t), news = env.publish('news'); env.publish('knowledge'); env.publish('knowledge', 'plans');
  await env.page.onShow(); assert.equal(env.page.data.articles.length, 2);
  assert.equal(env.page.data.articles.some(a => 'body' in a), false);
  env.page.chooseCategory({ currentTarget: { dataset: { category: 'news' } } });
  assert.equal(env.page.data.filtered.length, 1);
  env.page.search({ detail: { value: '不存在' } }); assert.equal(env.page.data.filtered.length, 0);
  env.page.resetFilters(); assert.equal(env.page.data.filtered.length, 2);
  await env.open(news); assert.equal(env.page.data.selected.body, news.body);
  env.page.onHide(); assert.equal(env.page.data.selected, null); assert.equal(env.page.data.articles.length, 0);
  await env.page.onShow(); assert.equal(env.page.data.articles.length, 2);
});

test('reader rechecks membership and publication when opening metadata already listed', async t => {
  const env = await setup(t), user = await env.member(), article = env.publish('knowledge', 'plans');
  await env.page.refresh(); assert.equal(env.page.data.articles.length, 1);
  env.db.prepare("UPDATE memberships SET expires_at='2000-01-01T00:00:00.000Z' WHERE user_id=?").run(user.id);
  await env.open(article); assert.equal(env.page.data.selected, null); assert.match(env.page.data.error, /不可阅读/);
  await env.page.refresh(); assert.equal(env.page.data.articles.length, 0);
  const news = env.publish('news'); await env.page.refresh();
  transitionArticle(env.db, env.admin, news.id, 'unpublish', news.revision);
  await env.open(news); assert.equal(env.page.data.selected, null); assert.equal(env.page.data.articles.length, 0);
});

test('expired server session clears details and allows explicit refresh of public content', async t => {
  const env = await setup(t), user = await env.member(), article = env.publish('knowledge', 'plans'); env.publish('news');
  await env.page.refresh(); await env.open(article); assert.ok(env.page.data.selected);
  env.db.prepare('DELETE FROM native_sessions WHERE user_id=?').run(user.id);
  await env.page.refresh(); assert.equal(env.page.data.selected, null); assert.equal(env.page.data.loggedIn, false);
  assert.match(env.page.data.error, /过期/); await env.page.refresh();
  assert.equal(env.page.data.articles.length, 1); assert.equal(env.page.data.articles[0].category, 'news');
});

test('late detail after account change or page hide cannot restore private data; network failure clears stale view', async t => {
  const env = await setup(t); await env.member(); const article = env.publish('knowledge', 'plans');
  await env.page.refresh();
  env.hook((options, response) => {
    if (options.url.endsWith('/articles/' + article.id)) {
      env.client.clearSession({ logout: true }); env.hook(null); options.success(response); return true;
    }
  });
  await env.open(article); assert.equal(env.page.data.selected, null); assert.equal(env.page.data.articles.length, 0);
  await env.member('another_member'); await env.page.refresh();
  env.hook((options, response) => {
    if (options.url.endsWith('/articles/' + article.id)) {
      env.page.onHide(); const writes = env.page.writes; env.hook(null); options.success(response);
      queueMicrotask(() => assert.equal(env.page.writes, writes)); return true;
    }
  });
  await env.open(article); assert.equal(env.page.data.selected, null);
  await env.page.onShow(); await env.open(article); assert.ok(env.page.data.selected);
  env.hook(options => { env.hook(null); options.fail(); return true; });
  await env.page.refresh(); assert.equal(env.page.data.selected, null); assert.equal(env.page.data.articles.length, 0);
  assert.match(env.page.data.error, /连接不上/);
});
