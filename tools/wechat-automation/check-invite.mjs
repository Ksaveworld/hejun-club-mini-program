import assert from 'node:assert/strict';
import { randomBytes, randomUUID } from 'node:crypto';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import automator from 'miniprogram-automator';
import { openDatabase } from '../../server/db.mjs';
import { createApplication } from '../../server/app.mjs';

const base = 'http://127.0.0.1:5197/api';
const reportPath = new URL('../../work/wechat/invite-integration-check.json', import.meta.url);
const report = { startedAt: new Date().toISOString(), status: 'running', checks: [],
  scope: '官方模拟器页面处理函数、渲染尺寸、真实隔离HTTP；非按钮输入事件/真机。不发送消息，不调用真实相册保存，不开通会籍。' };
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
  const first = await api('/native/auth/register', { username: 'isolated_inviter', password, consent: true });
  const second = await api('/native/auth/register', { username: 'isolated_invitee', password, consent: true });
  async function useSession(login) {
    await miniProgram.evaluate((base, login) => {
      getApp().globalData.apiBaseUrl = base;
      wx.setStorageSync('club-native-session:' + base, { accessToken: login.accessToken, expiresAt: login.expiresAt, authMode: login.authMode });
    }, base, login);
  }
  await check('官方画布导出卡片及介绍图片，尺寸与本人分享来源一致', async () => {
    miniProgram = await automator.connect({ wsEndpoint: 'ws://127.0.0.1:9420' });
    const config = JSON.parse(await readFile(new URL('../../miniprogram/project.config.json', import.meta.url), 'utf8'));
    assert.equal(await miniProgram.evaluate(() => wx.getAccountInfoSync().miniProgram.appId), config.appid);
    assert.equal(await miniProgram.evaluate(() => __wxConfig.pages.includes('pages/invite/index')), true, '邀请页尚未编译');
    await useSession(first); await miniProgram.reLaunch('/pages/invite/index');
    await waitFor(data, value => value.ready && !value.loading, '图片导出');
    const state = await data(); assert.equal(state.code, first.user.referralCode);
    await rendered('.invite-card-image'); await rendered('.invite-poster-image');
    const share = await invoke('onShareAppMessage'); assert.equal(share.path, '/pages/home/index?ref=' + first.user.referralCode); assert.equal(share.imageUrl, state.cardPath);
    for (const [kind, path, height] of [['card', state.cardPath, 480], ['poster', state.posterPath, 900]]) {
      const info = await miniProgram.evaluate(path => new Promise((resolve, reject) => wx.getImageInfo({src:path,success:resolve,fail:reject})), path);
      assert.equal(info.width, 600); assert.equal(info.height, height);
      const bytes = await miniProgram.evaluate(path => wx.getFileSystemManager().readFileSync(path, 'base64'), path);
      await writeFile(new URL('../../work/wechat/invite-' + kind + '-sample.png', import.meta.url), Buffer.from(bytes, 'base64'));
    }
    report.exportedImages = ['work/wechat/invite-card-sample.png','work/wechat/invite-poster-sample.png'];
  });
  await check('换账号后旧图不能作为分享图片，新生成卡片使用新来源', async () => {
    await useSession(second);
    const old = await invoke('onShareAppMessage'); assert.equal(old.path, '/pages/home/index'); assert.equal(old.imageUrl, undefined);
    await invoke('refresh'); const state = await data(); assert.equal(state.ready, true); assert.equal(state.code, second.user.referralCode);
    assert.equal((await invoke('onShareAppMessage')).path, '/pages/home/index?ref=' + second.user.referralCode);
  });
  await check('我的入口可进入邀请页，服务端失效后不再展示个人邀请图片', async () => {
    await miniProgram.switchTab('/pages/account/index');
    await waitFor(data, value => value.shareReady && !value.loading, '我的账号'); await rendered('.invite-entry');
    await invoke('openInvite');
    await waitFor(() => miniProgram.currentPage(), page => page?.path === 'pages/invite/index', '邀请页入口');
    await waitFor(data, value => value.ready && !value.loading, '邀请图片');
    db.prepare('DELETE FROM native_sessions WHERE user_id=?').run(second.user.id);
    await invoke('refresh'); assert.equal((await data()).ready, false); assert.equal((await data()).posterPath, '');
    await rendered('.invite-poster-image', 0); assert.equal((await invoke('onShareAppMessage')).path, '/pages/home/index');
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
  clearTimeout(deadline); await save(); console.log(report.status + ': work/wechat/invite-integration-check.json'); process.exit(process.exitCode || 0);
}
