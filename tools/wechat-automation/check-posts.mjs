import assert from 'node:assert/strict';
import { randomBytes, randomUUID } from 'node:crypto';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import automator from 'miniprogram-automator';
import { openDatabase } from '../../server/db.mjs';
import { createApplication } from '../../server/app.mjs';
import { insertUser, hashPassword, createOrder, applyVerifiedPayment } from '../../server/domain.mjs';

const base = 'http://127.0.0.1:5197/api';
const reportPath = new URL('../../work/wechat/posts-integration-check.json', import.meta.url);
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
  const login = await api('/native/auth/register', { username: 'isolated_posts', password, consent: true });
  const member = db.prepare('SELECT * FROM users WHERE id=?').get(login.user.id);
  await check('连接指定AppID并直接打开原生投稿页（独立会话）', async () => {
    const config = JSON.parse(await readFile(new URL('../../miniprogram/project.config.json', import.meta.url), 'utf8'));
    miniProgram = await automator.connect({ wsEndpoint: 'ws://127.0.0.1:9420' });
    assert.equal(await miniProgram.evaluate(() => wx.getAccountInfoSync().miniProgram.appId), config.appid);
    assert.equal(await miniProgram.evaluate(() => __wxConfig.pages.includes('pages/posts/index')), true, '新投稿页尚未编译进工程');
    await miniProgram.evaluate((base, login) => {
      getApp().globalData.apiBaseUrl = base;
      wx.setStorageSync('club-native-session:' + base, { accessToken: login.accessToken, expiresAt: login.expiresAt, authMode: login.authMode });
      wx.removeStorageSync('club-native-referral:' + base);
    }, base, login);
    await miniProgram.reLaunch('/pages/posts/index');
    await waitFor(() => miniProgram.currentPage(), page => page?.path === 'pages/posts/index', '投稿页面路由');
    await waitFor(data, value => value.ready && !value.loading, '投稿会籍与列表');
    assert.equal((await data()).canSubmit, false); await rendered('.access-note'); await rendered('.post-form', 0);
  });
  await check('隔离会员资格生效后渲染表单并真实提交待审稿', async () => {
    const order = createOrder(db, member.id, { planId: 'basic', consent: true,
      form: { name: '隔离投稿会员', phone: '13800000000', city: '测试城市' } }, randomUUID());
    const expected = { appId: 'ISOLATED_POSTS', merchantId: 'ISOLATED_POSTS' };
    applyVerifiedPayment(db, { ...expected, transactionId: randomUUID(), orderId: order.id, currency: 'CNY',
      amountCents: order.amountCents, status: 'SUCCESS', paidAt: new Date().toISOString() }, expected);
    await invoke('refreshPosts'); assert.equal((await data()).canSubmit, true); await rendered('.post-form');
    for (const [field, value] of Object.entries({ title: '隔离运行时稿件', body: '第一段测试文字。\n第二段测试文字，仅用于验证。' })) {
      await invoke('changeField', { currentTarget: { dataset: { field } }, detail: { value } });
    }
    await invoke('submit'); assert.equal((await data()).selectedPost.status, 'pending');
    assert.equal((await data()).body, ''); await rendered('.post-detail'); await rendered('.review-note');
    assert.equal(db.prepare('SELECT count(*) n FROM posts').get().n, 1);
    assert.equal((await api('/content')).posts.length, 0);
  });
  await check('真实网页审核后原生刷新显示驳回原因且保留正文', async () => {
    insertUser(db, 'posts_admin', await hashPassword(password), 'admin');
    await api('/auth/login', { username: 'posts_admin', password });
    const id = db.prepare('SELECT id FROM posts').get().id;
    await api('/admin/posts/' + id + '/review', { status: 'rejected', reason: '隔离联验：请补充事实依据' });
    await api('/auth/logout', {}); cookie = undefined;
    await invoke('refreshPosts'); assert.equal((await data()).selectedPost.status, 'rejected');
    assert.match((await data()).selectedPost.reason, /事实依据/);
    assert.match((await data()).selectedPost.body, /第二段/); await rendered('.review-note');
  });
  await check('隔离会籍到期后不能新投稿，旧稿与审核结果仍可查询', async () => {
    db.prepare("UPDATE memberships SET expires_at='2000-01-01T00:00:00.000Z' WHERE user_id=?").run(member.id);
    await invoke('refreshPosts'); assert.equal((await data()).canSubmit, false);
    assert.equal((await data()).posts.length, 1); await rendered('.post-form', 0); await rendered('.post-detail');
  });
  await check('我的页面入口渲染并通过处理函数进入稿件页', async () => {
    await miniProgram.switchTab('/pages/account/index');
    await waitFor(data, value => value.loggedIn && !value.loading, '我的账号'); await rendered('.posts-entry');
    await invoke('openPosts');
    await waitFor(() => miniProgram.currentPage(), page => page?.path === 'pages/posts/index', '从我的进入稿件');
    await waitFor(data, value => value.ready && !value.loading, '稿件查询');
    assert.equal((await data()).posts.length, 1);
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
  clearTimeout(deadline); await save(); console.log(report.status + ': work/wechat/posts-integration-check.json'); process.exit(process.exitCode || 0);
}
