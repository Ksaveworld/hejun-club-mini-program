import assert from 'node:assert/strict';
import { randomBytes } from 'node:crypto';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import automator from 'miniprogram-automator';
import { openDatabase } from '../../server/db.mjs';
import { createApplication } from '../../server/app.mjs';
import { insertUser, hashPassword } from '../../server/domain.mjs';

// All identities and records live only in this process's isolated memory DB.
const base = 'http://127.0.0.1:5197/api';
const reportPath = new URL('../../work/wechat/business-integration-check.json', import.meta.url);
const report = { startedAt: new Date().toISOString(), status: 'running', checks: [],
  scope: '微信模拟器运行时、渲染尺寸、页面处理函数、真实本机HTTP请求及后台审核API；非按钮输入事件或真机验收。取消确认仅使用官方SDK替身，业务请求不替换。' };
const db = openDatabase(':memory:');
const server = createApplication(db, { allowNativeTrialAuth: true, hosts: ['127.0.0.1:5197'], origins: ['http://127.0.0.1:5197'] });
let miniProgram, cookie, stage = '启动隔离业务服务', modalMocked = false;
const deadline = setTimeout(async () => {
  report.status = 'failed'; report.stage = stage; report.error = '联验超过120秒，未通过。';
  await saveReport(); process.exit(1);
}, 120000);
async function saveReport() {
  report.finishedAt = new Date().toISOString();
  await mkdir(new URL('../../work/wechat/', import.meta.url), { recursive: true });
  await writeFile(reportPath, JSON.stringify(report, null, 2) + '\n', 'utf8');
}
async function request(path, body) {
  const response = await fetch(base + path, { method: body === undefined ? 'GET' : 'POST',
    headers: { 'Content-Type': 'application/json', 'X-Club-Request': '1', ...(cookie ? { Cookie: cookie } : {}) },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }), signal: AbortSignal.timeout(8000) });
  const result = await response.json();
  assert.ok(response.ok, result.error || `HTTP ${response.status}`);
  if (response.headers.get('set-cookie')) cookie = response.headers.get('set-cookie').split(';')[0];
  return result;
}
const data = () => miniProgram.evaluate(() => getCurrentPages().slice(-1)[0].data);
const invoke = (name, ...args) => miniProgram.evaluate((name, args) => {
  const page = getCurrentPages().slice(-1)[0];
  if (typeof page[name] !== 'function') throw new Error('未找到处理函数：' + name);
  return page[name](...args);
}, name, args);
const field = (name, value) => invoke('changeField', { currentTarget: { dataset: { field: name } }, detail: { value } });
async function waitFor(read, predicate, label) {
  const end = Date.now() + 10000;
  while (Date.now() < end) {
    const value = await read();
    if (predicate(value)) return value;
    await new Promise(resolve => setTimeout(resolve, 120));
  }
  throw new Error('等待超时：' + label);
}
async function route(path) {
  let actual;
  await waitFor(async () => { actual = await miniProgram.currentPage(); return actual; }, page => page?.path === path, path)
    .catch(error => { throw new Error(error.message + '；当前页面：' + (actual?.path || '无')); });
  // getCurrentPage can change before the native navigation animation completes.
  // Let that transition settle before invoking a subsequent navigation handler.
  await new Promise(resolve => setTimeout(resolve, 600));
}
async function rendered(selector, count = 1) {
  const rects = await miniProgram.evaluate(selector => new Promise(resolve => {
    wx.createSelectorQuery().selectAll(selector).boundingClientRect(resolve).exec();
  }), selector);
  assert.equal(rects.length, count, selector + '渲染数量');
  assert.ok(rects.every(rect => rect.width > 0 && rect.height > 0), selector + '须实际显示');
}
async function check(name, run) { stage = name; console.log(name); await run(); report.checks.push({ name, passed: true }); }

try {
  await new Promise((resolve, reject) => { server.once('error', reject); server.listen(5197, '127.0.0.1', resolve); });
  const adminPassword = randomBytes(20).toString('hex');
  insertUser(db, 'isolatedadmin', await hashPassword(adminPassword), 'admin');
  await request('/auth/login', { username: 'isolatedadmin', password: adminPassword });
  const referralPasswordHash = await hashPassword(randomBytes(20).toString('hex'));
  const defaultOwner = insertUser(db, 'defaultsource', referralPasswordHash);
  const explicitOwner = insertUser(db, 'explicitsource', referralPasswordHash);
  const laterOwner = insertUser(db, 'latersource', referralPasswordHash);
  db.prepare("INSERT INTO settings(key,value) VALUES ('default_referral_code',?)").run(defaultOwner.referral_code);
  await check('连接指定测试AppID并隔离业务服务及会话', async () => {
    const config = JSON.parse(await readFile(new URL('../../miniprogram/project.config.json', import.meta.url), 'utf8'));
    miniProgram = await automator.connect({ wsEndpoint: 'ws://127.0.0.1:9420' });
    assert.equal(await miniProgram.evaluate(() => wx.getAccountInfoSync().miniProgram.appId), config.appid);
    await miniProgram.evaluate(base => {
      getApp().globalData.apiBaseUrl = base;
      wx.removeStorageSync('club-native-session:' + base);
      wx.removeStorageSync('club-native-referral:' + base);
    }, base);
    await miniProgram.evaluate(code => {
      const app = getApp();
      if (typeof app.onLaunch !== 'function' || typeof app.onShow !== 'function') throw new Error('请重新编译原生工程以加载来源入口');
      app.onLaunch({ query: { ref: 'ZZZZZZ' } });
      app.onShow({ query: { ref: code } });
      app.onShow({ query: {} });
    }, explicitOwner.referral_code);
    await miniProgram.switchTab('/pages/account/index');
    await route('pages/account/index');
    await rendered('.guest-card');
  });
  const username = 'isolatedmember', memberPassword = randomBytes(20).toString('hex');
  await check('未登录填写机构申请，注册返回后保留资料', async () => {
    await invoke('openMembers'); await route('pages/members/index'); await rendered('.plan', 3);
    await invoke('openPlan', { currentTarget: { dataset: { planId: 'organization' } } });
    await route('pages/join/index');
    await waitFor(data, d => d.planReady && !d.loading, '服务端方案');
    await field('name', '隔离联验会员'); await field('phone', '13800000000');
    await field('city', '联验城市'); await field('company', '隔离联验机构');
    await invoke('changeConsent', { detail: { value: ['agree'] } });
    await invoke('openLogin'); await route('pages/login/index');
    await waitFor(data, d => d.healthReady && !d.healthLoading, '身份能力');
    assert.equal((await data()).localAvailable, true); assert.equal((await data()).wechatAvailable, false);
    await invoke('toggleLocal'); await invoke('toggleRegister');
    await rendered('.local-form');
    await field('username', username); await field('password', memberPassword);
    await invoke('changeConsent', { detail: { value: ['agree'] } });
    await invoke('submitLocal'); await route('pages/join/index');
    const restored = await waitFor(data, d => d.loggedIn && !d.loading, '登录后的申请表');
    assert.equal(restored.form.name, '隔离联验会员'); assert.equal(restored.form.company, '隔离联验机构');
    assert.equal(restored.amountLabel, '36500.00'); assert.equal(restored.consent, true);
    assert.equal(restored.sourceCode, explicitOwner.referral_code);
    assert.equal(restored.sourceExplicit, true);
    const savedMember = db.prepare("SELECT referrer_id,referral_source FROM users WHERE username='isolatedmember'").get();
    assert.equal(savedMember.referrer_id, explicitOwner.id); assert.equal(savedMember.referral_source, 'explicit');
    await rendered('.join-form');
  });
  let orderId;
  await check('原生提交待审核订单，服务端仅保存一笔且未开通会籍', async () => {
    await invoke('submit'); await route('pages/orders/index');
    const current = await waitFor(data, d => d.selectedOrder && !d.loading, '订单详情');
    orderId = current.selectedOrder.id;
    assert.equal(current.selectedOrder.status, 'review'); assert.equal(current.orders.length, 1);
    await rendered('.order-detail'); await rendered('.order-row');
    assert.equal(db.prepare('SELECT count(*) n FROM orders').get().n, 1);
    assert.equal(db.prepare('SELECT count(*) n FROM memberships').get().n, 0);
    const admin = await request('/admin/orders');
    assert.equal(admin.orders[0].id, orderId); assert.equal(admin.orders[0].form.company, '隔离联验机构');
    assert.equal(admin.orders[0].sourceCode, explicitOwner.referral_code);
    assert.equal(admin.orders[0].referralSource, 'explicit');
  });
  await check('后台审核API处理同一订单，原生刷新显示审核结果及付款未开放', async () => {
    await request('/admin/orders/' + orderId + '/review', { decision: 'approve', note: '隔离联验：资质流程通过，无真实资质认定' });
    await invoke('refreshOrders');
    assert.equal((await data()).selectedOrder.status, 'pending');
    assert.equal((await data()).selectedOrder.sourceCode, explicitOwner.referral_code);
    assert.match((await data()).selectedOrder.reviewNote, /隔离联验/);
    await rendered('.review-note'); await rendered('.state-note-title');
    assert.equal(db.prepare('SELECT count(*) n FROM memberships').get().n, 0);
  });
  await check('退出和重新登录后仍可读取同一订单与审核记录', async () => {
    await miniProgram.switchTab('/pages/account/index');
    await waitFor(data, d => d.loggedIn && !d.loading, '我的账户');
    assert.equal((await data()).membership, null); await rendered('.profile-card');
    await invoke('logout'); assert.equal((await data()).loggedIn, false);
    await invoke('openLogin'); await route('pages/login/index');
    await waitFor(data, d => d.healthReady && !d.healthLoading, '登录服务');
    await invoke('toggleLocal'); await field('username', username); await field('password', memberPassword);
    await invoke('changeConsent', { detail: { value: ['agree'] } }); await invoke('submitLocal');
    await route('pages/account/index'); await waitFor(data, d => d.loggedIn && !d.loading, '重新登录');
    await invoke('openOrders'); await route('pages/orders/index'); await waitFor(data, d => d.orders.length === 1 && !d.loading, '保存的订单');
    await invoke('toggleOrder', { currentTarget: { dataset: { orderId } } });
    assert.equal((await data()).selectedOrder.status, 'pending');
  });
  await check('原生分享入口使用当前账号自己的推荐码，忙碌时不产生旧归属链接', async () => {
    await miniProgram.switchTab('/pages/account/index');
    await waitFor(data, d => d.loggedIn && d.shareReady && !d.loading, '分享入口账号');
    await rendered('.share-invite');
    const ownCode = db.prepare("SELECT referral_code FROM users WHERE username='isolatedmember'").get().referral_code;
    assert.equal((await invoke('onShareAppMessage')).path, '/pages/home/index?ref=' + ownCode);
    assert.notEqual(ownCode, explicitOwner.referral_code);
    await miniProgram.evaluate(() => getCurrentPages().slice(-1)[0].setData({ busy: true }));
    assert.equal((await invoke('onShareAppMessage')).path, '/pages/home/index');
    await miniProgram.evaluate(() => getCurrentPages().slice(-1)[0].setData({ busy: false }));
    await invoke('openOrders'); await route('pages/orders/index');
    await waitFor(data, d => d.orders.length === 1 && !d.loading, '分享后原订单');
    await invoke('toggleOrder', { currentTarget: { dataset: { orderId } } });
  });
  await check('取消确认、服务端保存与刷新后的历史记录（仅确认弹窗采用官方SDK替身）', async () => {
    await miniProgram.mockWxMethod('showModal', { confirm: false, cancel: true }); modalMocked = true;
    await invoke('cancelOrder'); assert.equal((await data()).selectedOrder.status, 'pending');
    await miniProgram.mockWxMethod('showModal', { confirm: true, cancel: false });
    await invoke('cancelOrder'); assert.equal((await data()).selectedOrder.status, 'cancelled');
    assert.equal(db.prepare('SELECT status FROM orders WHERE id=?').get(orderId).status, 'cancelled');
    await miniProgram.restoreWxMethod('showModal'); modalMocked = false;
    await invoke('refreshOrders');
    const history = await data();
    assert.equal(history.orders.length, 1);
    assert.equal(history.orders[0].id, orderId);
    assert.equal(history.orders[0].status, 'cancelled');
    assert.equal(history.selectedOrder.id, orderId);
    assert.match(history.selectedOrder.reviewNote, /隔离联验/);
    assert.equal(history.selectedOrder.canCancel, false);
    await rendered('.order-row'); await rendered('.cancel-order', 0);
    assert.equal(db.prepare('SELECT count(*) n FROM orders').get().n, 1);
    assert.equal(db.prepare('SELECT count(*) n FROM memberships').get().n, 0);
    await invoke('openMembers'); await route('pages/members/index'); await rendered('.plan', 3);
  });
  await check('过期后的旧账号来源不能串到新账号，默认来源保持默认', async () => {
    await miniProgram.evaluate(code => getApp().onShow({ query: { ref: code } }), laterOwner.referral_code);
    const firstMember = db.prepare("SELECT id FROM users WHERE username='isolatedmember'").get();
    db.prepare('DELETE FROM native_sessions WHERE user_id=?').run(firstMember.id);
    await miniProgram.switchTab('/pages/account/index');
    await waitFor(data, d => !d.loggedIn && !d.loading, '过期后的登录入口');
    const pendingSource = await miniProgram.evaluate(base => wx.getStorageSync('club-native-referral:' + base), base);
    assert.equal(pendingSource.ownerId, firstMember.id);
    assert.ok(pendingSource.codes.includes(laterOwner.referral_code));
    await invoke('openLogin'); await route('pages/login/index');
    await waitFor(data, d => d.healthReady && !d.healthLoading, '新账号注册入口');
    await invoke('toggleLocal'); await invoke('toggleRegister');
    await field('username', 'isolatedsecond'); await field('password', memberPassword);
    await invoke('changeConsent', { detail: { value: ['agree'] } }); await invoke('submitLocal');
    await route('pages/account/index'); await waitFor(data, d => d.loggedIn && !d.loading, '新账号已登录');
    const second = db.prepare("SELECT * FROM users WHERE username='isolatedsecond'").get();
    assert.equal(second.referrer_id, defaultOwner.id); assert.equal(second.referral_source, 'default');
    assert.equal((await data()).user.sourceCode, defaultOwner.referral_code);
    const after = await miniProgram.evaluate(base => wx.getStorageSync('club-native-referral:' + base), base);
    assert.equal(after.ownerId, second.id); assert.deepEqual(after.codes, []);
  });
  await check('已有待处理订单时新分享来源不改变原订单或默认关系', async () => {
    await invoke('openMembers'); await route('pages/members/index');
    await invoke('openPlan', { currentTarget: { dataset: { planId: 'basic' } } }); await route('pages/join/index');
    await waitFor(data, d => d.planReady && d.loggedIn && !d.loading, '默认来源申请');
    await field('name', '第二位隔离会员'); await field('phone', '13800000001'); await field('city', '隔离城市');
    await invoke('changeConsent', { detail: { value: ['agree'] } }); await invoke('submit');
    await route('pages/orders/index');
    const submitted = await waitFor(data, d => d.selectedOrder && !d.loading, '默认来源订单');
    const secondOrderId = submitted.selectedOrder.id;
    assert.equal(submitted.selectedOrder.sourceCode, defaultOwner.referral_code);
    assert.equal(submitted.selectedOrder.referralSource, 'default');
    await miniProgram.evaluate(code => getApp().onShow({ query: { ref: code } }), laterOwner.referral_code);
    await invoke('openMembers'); await route('pages/members/index');
    await invoke('openPlan', { currentTarget: { dataset: { planId: 'basic' } } }); await route('pages/join/index');
    const blocked = await waitFor(data, d => d.planReady && d.loggedIn && !d.loading, '待处理订单来源保护');
    assert.match(blocked.referralNotice, /待处理订单/);
    assert.equal(blocked.sourceCode, defaultOwner.referral_code); assert.equal(blocked.sourceExplicit, false);
    const row = db.prepare('SELECT referrer_id,referral_source,status FROM orders WHERE id=?').get(secondOrderId);
    assert.equal(row.referrer_id, defaultOwner.id); assert.equal(row.referral_source, 'default'); assert.equal(row.status, 'pending');
    assert.deepEqual(await miniProgram.evaluate(base => wx.getStorageSync('club-native-referral:' + base).codes, base), []);
  });
  report.status = 'passed';
} catch (error) {
  report.status = 'failed'; report.stage = stage; report.error = error.message; console.error(stage + '：' + error.message); process.exitCode = 1;
} finally {
  try {
    if (miniProgram) {
      if (modalMocked) await miniProgram.restoreWxMethod('showModal');
      await miniProgram.evaluate(base => { wx.removeStorageSync('club-native-session:' + base); wx.removeStorageSync('club-native-referral:' + base); delete getApp().globalData.apiBaseUrl; }, base);
      await miniProgram.switchTab('/pages/home/index');
    }
  } catch (error) { report.cleanupError = error.message; report.status = 'failed'; process.exitCode = 1; }
  miniProgram?.disconnect();
  await new Promise(resolve => server.close(resolve)); db.close();
  clearTimeout(deadline); await saveReport(); console.log(report.status + ': work/wechat/business-integration-check.json');
  process.exit(process.exitCode || 0);
}
