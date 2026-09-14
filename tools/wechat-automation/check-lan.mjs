import assert from 'node:assert/strict';
import { readFile, writeFile } from 'node:fs/promises';
import automator from 'miniprogram-automator';
import { isPrivateIPv4 } from '../../server/lan-network.mjs';

const report = { startedAt: new Date().toISOString(), status: 'running', checks: [], phoneVerified: false,
  scope: '独立手机预览包在微信模拟器访问 LAN 地址，读取健康接口和登录能力；不创建账号或订单，不代替实际手机联网验收。' };
let miniProgram, observing = false;
let stage = '连接官方自动化接口';
const reportPath = new URL('../../work/wechat/lan-check.json', import.meta.url);
async function save() { report.finishedAt = new Date().toISOString(); await writeFile(reportPath, JSON.stringify(report, null, 2) + '\n', 'utf8'); }
async function restoreObservation() {
  if (!observing || !miniProgram) return;
  // Cleanup has its own deadline in case the IDE runtime stops responding.
  await Promise.race([miniProgram.evaluate(() => {
    const app = getApp(), probe = app.__lanHealthProbe;
    if (probe && wx.request === probe.wrapper) wx.request = probe.original;
    delete app.__lanHealthProbe;
  }).catch(() => {}), new Promise(resolve => setTimeout(resolve, 1500))]);
  observing = false;
}
const timer = setTimeout(async () => { report.status = 'failed'; report.stage = stage; report.error = 'LAN模拟器检查超过45秒'; await restoreObservation(); await save(); process.exit(1); }, 45000);
try {
  const manifest = JSON.parse(await readFile(new URL('../../work/wechat/lan-project.json', import.meta.url), 'utf8'));
  assert.equal(isPrivateIPv4(manifest.address), true);
  assert.equal(manifest.apiBaseUrl, 'http://' + manifest.address + ':5198/api');
  miniProgram = await automator.connect({ wsEndpoint: 'ws://127.0.0.1:9421' });
  stage = '等待独立预览工程的微信运行时'; console.log(stage);
  assert.equal(await miniProgram.evaluate(() => wx.getAccountInfoSync().miniProgram.appId), manifest.appId);
  report.checks.push('运行时 AppID 一致，实际业务端点须另行核验');
  stage = '微信运行时请求局域网服务'; console.log(stage);
  const health = await miniProgram.evaluate(base => new Promise((resolve, reject) => wx.request({
    url: base + '/health', timeout: 8000,
    success: result => resolve({ status: result.statusCode, data: result.data }),
    fail: () => reject(new Error('模拟器不能连接局域网测试地址')),
  })), manifest.apiBaseUrl);
  assert.equal(health.status, 200); assert.equal(health.data.mode, 'lan-trial'); assert.equal(health.data.paymentReady, false);
  report.checks.push('模拟器实际请求 LAN 后端成功，付款关闭');
  stage = '验证登录页能力与渲染'; console.log(stage);
  observing = true;
  await miniProgram.evaluate(() => {
    const app = getApp();
    if (app.__lanHealthProbe) throw new Error('已有请求观测未清理，请重新编译该测试工程');
    const probe = { original: wx.request, urls: [] };
    probe.wrapper = function (options) {
      if (options && typeof options.url === 'string' && options.url.endsWith('/api/health')) probe.urls.push(options.url);
      // Observe only the health URL; preserve the actual request and callbacks.
      return probe.original.apply(this, arguments);
    };
    app.__lanHealthProbe = probe;
    wx.request = probe.wrapper;
    if (wx.request !== probe.wrapper) throw new Error('运行时不允许观测请求，无法确认登录页实际端点');
  });
  await miniProgram.reLaunch('/pages/login/index');
  let state;
  const deadline = Date.now() + 10000;
  do {
    state = await miniProgram.evaluate(() => {
      const page = getCurrentPages().slice(-1)[0];
      return { route: page?.route, ready: page?.data.healthReady, local: page?.data.localAvailable,
        wechat: page?.data.wechatAvailable, error: page?.data.healthError, urls: getApp().__lanHealthProbe?.urls || [] };
    });
    if (state.route === 'pages/login/index' && (state.ready || state.error)) break;
    await new Promise(resolve => setTimeout(resolve, 200));
  } while (Date.now() < deadline);
  assert.equal(state.route, 'pages/login/index');
  assert.ok(state.urls.length > 0, '没有观测到登录页实际健康请求');
  assert.ok(state.urls.every(url => url === manifest.apiBaseUrl + '/health'), '登录页连接了其他环境');
  assert.equal(state.ready, true, state.error); assert.equal(state.local, true); assert.equal(state.wechat, health.data.nativeAuth.wechat);
  const rects = await miniProgram.evaluate(() => new Promise(resolve => {
    wx.createSelectorQuery().selectAll('.local-toggle').boundingClientRect(resolve).exec();
  }));
  assert.equal(rects.length, 1); assert.ok(rects[0].width > 0 && rects[0].height > 0);
  report.checks.push('预览包登录页已读取后台能力并实际渲染内测入口');
  await restoreObservation();
  await miniProgram.switchTab('/pages/home/index');
  report.status = 'passed';
} catch (error) { report.status = 'failed'; report.stage = stage; report.error = error.message; process.exitCode = 1; }
finally { clearTimeout(timer); await restoreObservation(); miniProgram?.disconnect(); await save(); console.log(JSON.stringify(report)); process.exit(process.exitCode || 0); }
