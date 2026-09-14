import assert from 'node:assert/strict';
import { randomBytes, randomUUID } from 'node:crypto';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import automator from 'miniprogram-automator';
import { openDatabase } from '../../server/db.mjs';
import { createApplication } from '../../server/app.mjs';
import { createArticle, transitionArticle } from '../../server/articles.mjs';
import { insertUser, hashPassword, createOrder, applyVerifiedPayment } from '../../server/domain.mjs';

const base = 'http://127.0.0.1:5197/api';
const reportPath = new URL('../../work/wechat/articles-integration-check.json', import.meta.url);
const report = { startedAt: new Date().toISOString(), status: 'running', checks: [],
  scope: '官方模拟器页面处理函数、渲染尺寸、真实隔离HTTP；非按钮输入事件/真机。有效会籍仅注入独立内存库。' };
const db = openDatabase(':memory:');
const server = createApplication(db, { allowNativeTrialAuth: true, hosts: ['127.0.0.1:5197'], origins: ['http://127.0.0.1:5197'] });
let miniProgram, cookie, stage = '启动隔离服务';
async function save() {
  report.finishedAt = new Date().toISOString();
  await mkdir(new URL('../../work/wechat/', import.meta.url), { recursive: true });
  await writeFile(reportPath, JSON.stringify(report, null, 2) + '\n', 'utf8');
}
const deadline = setTimeout(async () => { report.status = 'failed'; report.stage = stage; report.error = '超过90秒，未通过'; await save(); process.exit(1); }, 90000);
async function api(path, body) {
  const response = await fetch(base + path, { method: body === undefined ? 'GET' : 'POST', headers: {
    'Content-Type': 'application/json', 'X-Club-Request': '1', ...(cookie ? { Cookie: cookie } : {}) },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }), signal: AbortSignal.timeout(5000) });
  const result = await response.json(); assert.ok(response.ok, result.error);
  if (response.headers.get('set-cookie')) cookie = response.headers.get('set-cookie').split(';')[0];
  return result;
}
const data = () => miniProgram.evaluate(() => getCurrentPages().slice(-1)[0].data);
const invoke = (name, ...args) => miniProgram.evaluate((name, args) => {
  const page = getCurrentPages().slice(-1)[0];
  if (typeof page[name] !== 'function') throw new Error('未加载处理函数：' + name);
  return page[name](...args);
}, name, args);
async function waitFor(read, predicate, label) {
  const end = Date.now() + 12000;
  while (Date.now() < end) {
    if (predicate(await read())) return;
    await new Promise(resolve => setTimeout(resolve, 150));
  }
  throw new Error('等待超时：' + label);
}
async function rendered(selector, count = 1) {
  const rects = await miniProgram.evaluate(selector => new Promise(resolve => {
    wx.createSelectorQuery().selectAll(selector).boundingClientRect(resolve).exec();
  }), selector);
  assert.equal(rects.length, count, selector);
  assert.ok(rects.every(rect => rect.width > 0 && rect.height > 0), selector + '渲染尺寸');
}
async function check(name, run) { stage = name; console.log(name); await run(); report.checks.push({ name, passed: true }); }
try {
  await new Promise((resolve, reject) => { server.once('error', reject); server.listen(5197, '127.0.0.1', resolve); });
  const password = randomBytes(20).toString('hex');
  const login = await api('/native/auth/register', { username: 'isolated_reader', password, consent: true });
  const admin = insertUser(db, 'articles_admin', await hashPassword(password), 'admin');
  function article(category, visibility) {
    const row = createArticle(db, admin, { title: category === 'news' ? '隔离公开资讯' : '隔离会员知识', summary: '运行时阅读联验',
      body: '第一段隔离文字。\n<b>纯文字展示</b>', category, access: { visibility, planIds: visibility === 'plans' ? ['basic'] : [] } }, randomUUID());
    return transitionArticle(db, admin, row.id, 'publish', row.revision);
  }
  const news = article('news', 'public'), knowledge = article('knowledge', 'plans');
  await check('官方原生页面显示公开内容，分类与搜索可筛选', async () => {
    const config = JSON.parse(await readFile(new URL('../../miniprogram/project.config.json', import.meta.url), 'utf8'));
    miniProgram = await automator.connect({ wsEndpoint: 'ws://127.0.0.1:9420' });
    assert.equal(await miniProgram.evaluate(() => wx.getAccountInfoSync().miniProgram.appId), config.appid);
    assert.equal(await miniProgram.evaluate(() => __wxConfig.pages.includes('pages/articles/index')), true, '阅读页尚未编译进工程');
    await miniProgram.evaluate(base => { getApp().globalData.apiBaseUrl = base; wx.removeStorageSync('club-native-session:' + base); }, base);
    await miniProgram.reLaunch('/pages/articles/index');
    await waitFor(data, value => value.ready && !value.loading, '公开内容读取');
    assert.equal((await data()).articles.length, 1); await rendered('.article-item');
    await invoke('chooseCategory', { currentTarget: { dataset: { category: 'knowledge' } } }); await rendered('.article-item', 0);
    await invoke('resetFilters'); await invoke('search', { detail: { value: '不存在' } }); await rendered('.article-item', 0);
    await invoke('resetFilters');
    await invoke('openArticle', { currentTarget: { dataset: { id: news.id } } });
    assert.equal((await data()).selected.body, news.body); await rendered('.article-body');
  });
  await check('有效会籍阅读指定知识，服务端撤下后正文清除', async () => {
    const order = createOrder(db, login.user.id, { planId: 'basic', consent: true,
      form: { name: '隔离阅读会员', phone: '13800000000', city: '测试城市' } }, randomUUID());
    const expected = { appId: 'ISOLATED_ARTICLES', merchantId: 'ISOLATED_ARTICLES' };
    applyVerifiedPayment(db, { ...expected, transactionId: randomUUID(), orderId: order.id, currency: 'CNY',
      amountCents: order.amountCents, status: 'SUCCESS', paidAt: new Date().toISOString() }, expected);
    await miniProgram.evaluate((base, login) => wx.setStorageSync('club-native-session:' + base,
      { accessToken: login.accessToken, expiresAt: login.expiresAt, authMode: login.authMode }), base, login);
    await invoke('refresh'); assert.equal((await data()).articles.length, 2);
    await invoke('openArticle', { currentTarget: { dataset: { id: knowledge.id } } });
    assert.equal((await data()).selected.body, knowledge.body); await rendered('.article-body');
    transitionArticle(db, admin, knowledge.id, 'unpublish', knowledge.revision);
    await invoke('openArticle', { currentTarget: { dataset: { id: knowledge.id } } });
    assert.equal((await data()).selected, null); await rendered('.article-body', 0); await rendered('.error');
  });
  await check('会籍到期不再返回会员资料，服务入口能进入阅读列表', async () => {
    const row = db.prepare('SELECT revision FROM articles WHERE id=?').get(knowledge.id);
    transitionArticle(db, admin, knowledge.id, 'publish', row.revision);
    db.prepare("UPDATE memberships SET expires_at='2000-01-01T00:00:00.000Z' WHERE user_id=?").run(login.user.id);
    await invoke('refresh'); assert.equal((await data()).articles.length, 1);
    await miniProgram.switchTab('/pages/services/index');
    await waitFor(() => miniProgram.currentPage(), page => page?.path === 'pages/services/index', '服务入口');
    await invoke('openArticles');
    await waitFor(() => miniProgram.currentPage(), page => page?.path === 'pages/articles/index', '阅读路由');
    await waitFor(data, value => value.ready && !value.loading, '阅读列表');
    assert.equal((await data()).articles.length, 1); await rendered('.article-item');
  });
  report.status = 'passed';
} catch (error) { report.status = 'failed'; report.stage = stage; report.error = error.message; process.exitCode = 1; console.error(stage + '：' + error.message); }
finally {
  try {
    if (miniProgram) {
      // A ready page can precede the end of its native navigation animation.
      await new Promise(resolve => setTimeout(resolve, 600));
      report.cleanupStage = '清理隔离会话和端点';
      await miniProgram.evaluate(base => { wx.removeStorageSync('club-native-session:' + base); wx.removeStorageSync('club-native-referral:' + base); delete getApp().globalData.apiBaseUrl; }, base);
      report.cleanupStage = '返回首页';
      const goHome = () => miniProgram.evaluate(() => new Promise(resolve => wx.reLaunch({ url: '/pages/home/index',
        success: () => resolve({ ok: true }), fail: error => resolve({ ok: false, error: error.errMsg }) })));
      let home = await goHome();
      if (!home.ok && /timeout/.test(home.error || '')) {
        // Only retry this idempotent cleanup navigation, never business writes.
        report.cleanupNavigationWarning = home.error;
        report.cleanupNavigationRetries = 1;
        home = await goHome();
      }
      assert.equal(home.ok, true, home.error || '返回首页失败');
      await waitFor(() => miniProgram.currentPage(), page => page?.path === 'pages/home/index', '清理后返回首页');
      const clean = await miniProgram.evaluate(base => !getApp().globalData.apiBaseUrl && !wx.getStorageSync('club-native-session:' + base), base);
      assert.equal(clean, true, '隔离会话和端点须清理');
      report.cleanupStage = '已核实清理完成';
    }
  } catch (error) { report.cleanupError = error.message; report.status = 'failed'; process.exitCode = 1; }
  miniProgram?.disconnect(); server.closeAllConnections(); await new Promise(resolve => server.close(resolve)); db.close();
  clearTimeout(deadline); await save(); console.log(report.status + ': work/wechat/articles-integration-check.json'); process.exit(process.exitCode || 0);
}
