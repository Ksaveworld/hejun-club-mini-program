import assert from 'node:assert/strict';
import { randomBytes, randomUUID } from 'node:crypto';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import automator from 'miniprogram-automator';
import { openDatabase } from '../../server/db.mjs';
import { createApplication } from '../../server/app.mjs';
import { insertUser, hashPassword } from '../../server/domain.mjs';

const base = 'http://127.0.0.1:5197/api';
const reportPath = new URL('../../work/wechat/feedback-integration-check.json', import.meta.url);
const report = { startedAt: new Date().toISOString(), status: 'running', checks: [],
  scope: '官方模拟器页面处理函数、渲染尺寸、真实隔离HTTP；非按钮输入事件/真机。仅独立内存库，无会籍注入。' };
const db = openDatabase(':memory:');
const server = createApplication(db, { allowNativeTrialAuth: true, hosts: ['127.0.0.1:5197'], origins: ['http://127.0.0.1:5197'] });
let miniProgram, cookie, stage = '启动隔离服务';
async function save() {
  report.finishedAt = new Date().toISOString();
  await mkdir(new URL('../../work/wechat/', import.meta.url), { recursive: true });
  await writeFile(reportPath, JSON.stringify(report, null, 2) + '\n', 'utf8');
}
const deadline = setTimeout(async () => { report.status = 'failed'; report.stage = stage; report.error = '超过90秒，未通过'; await save(); process.exit(1); }, 90000);
async function api(path, body, key) {
  const response = await fetch(base + path, { method: body === undefined ? 'GET' : 'POST', headers: {
    'Content-Type': 'application/json', 'X-Club-Request': '1', ...(key ? { 'Idempotency-Key': key } : {}), ...(cookie ? { Cookie: cookie } : {}) },
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
  const login = await api('/native/auth/register', { username: 'feedback_member', password, consent: true });
  insertUser(db, 'feedback_admin', await hashPassword(password), 'admin');
  await api('/auth/login', { username: 'feedback_admin', password });
  let ticket;
  await check('未付费账号在官方原生页提交反馈并显示待受理', async () => {
    const config = JSON.parse(await readFile(new URL('../../miniprogram/project.config.json', import.meta.url), 'utf8'));
    miniProgram = await automator.connect({ wsEndpoint: 'ws://127.0.0.1:9420' });
    assert.equal(await miniProgram.evaluate(() => wx.getAccountInfoSync().miniProgram.appId), config.appid);
    assert.equal(await miniProgram.evaluate(() => __wxConfig.pages.includes('pages/feedback/index')), true);
    await miniProgram.evaluate((base, login) => {
      getApp().globalData.apiBaseUrl = base;
      wx.setStorageSync('club-native-session:' + base, { accessToken: login.accessToken, expiresAt: login.expiresAt, authMode: login.authMode });
    }, base, login);
    await miniProgram.reLaunch('/pages/feedback/index');
    await waitFor(data, value => value.ready && !value.loading, '反馈页面读取');
    await rendered('.feedback-form');
    await invoke('changeField', { currentTarget: { dataset: { field: 'title' } }, detail: { value: '隔离运行时反馈' } });
    await invoke('changeField', { currentTarget: { dataset: { field: 'body' } }, detail: { value: '希望了解申请处理进度，纯隔离测试。' } });
    await invoke('submit');
    ticket = (await data()).selected; assert.equal(ticket.status, 'open'); await rendered('.feedback-detail');
    assert.equal(db.prepare('SELECT COUNT(*) n FROM memberships').get().n, 0);
  });
  await check('真实管理员受理并回复，原生刷新后展示不可覆盖的历史', async () => {
    ticket = (await api('/admin/feedback/' + ticket.id + '/accept', { revision: ticket.revision }, randomUUID())).ticket;
    ticket = (await api('/admin/feedback/' + ticket.id + '/reply', { revision: ticket.revision, body: '测试问题已处理。', status: 'resolved' }, randomUUID())).ticket;
    await invoke('refresh');
    await invoke('openTicket', { currentTarget: { dataset: { id: ticket.id } } });
    const selected = (await data()).selected;
    assert.equal(selected.status, 'resolved'); assert.equal(selected.events.length, 2);
    assert.equal(selected.events[1].body, '测试问题已处理。'); await rendered('.feedback-event', 2);
  });
  await check('我的入口可进入反馈，换账号隔离且服务端过期后清除旧问题', async () => {
    await miniProgram.switchTab('/pages/account/index');
    await waitFor(() => miniProgram.currentPage(), page => page?.path === 'pages/account/index', '我的入口');
    await invoke('openFeedback');
    await waitFor(data, value => value.ready && !value.loading && Array.isArray(value.tickets), '反馈入口');
    await api('/auth/logout', {}); cookie = undefined;
    const other = await api('/native/auth/register', { username: 'feedback_other', password, consent: true });
    await miniProgram.evaluate((base, login) => wx.setStorageSync('club-native-session:' + base,
      { accessToken: login.accessToken, expiresAt: login.expiresAt, authMode: login.authMode }), base, other);
    await invoke('refresh'); assert.equal((await data()).tickets.length, 0); assert.equal((await data()).selected, null);
    db.prepare('DELETE FROM native_sessions WHERE user_id=?').run(other.user.id);
    await invoke('refresh'); assert.equal((await data()).ready, false); assert.equal((await data()).tickets.length, 0);
    await rendered('.feedback-error');
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
  clearTimeout(deadline); await save(); console.log(report.status + ': work/wechat/feedback-integration-check.json'); process.exit(process.exitCode || 0);
}
