import assert from 'node:assert/strict';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import automator from 'miniprogram-automator';

const reportPath = new URL('../../work/wechat/automation-check.json', import.meta.url);
const projectPath = new URL('../../miniprogram/project.config.json', import.meta.url);
const report = {
  startedAt: new Date().toISOString(), status: 'running', checks: [],
  scope: '微信模拟器中的真实运行时、页面渲染尺寸与处理函数；不包含按钮点击或输入框事件分发验证。',
};
let miniProgram;
let stage = '检查测试 AppID';
const deadline = setTimeout(async () => {
  report.status = 'failed';
  report.stage = stage;
  report.error = '自动化超过 60 秒，不能视为验证通过。';
  console.error(`${stage}：${report.error}`);
  await saveReport();
  process.exit(1);
}, 60000);

async function saveReport() {
  report.finishedAt = new Date().toISOString();
  await mkdir(new URL('../../work/wechat/', import.meta.url), { recursive: true });
  await writeFile(reportPath, `${JSON.stringify(report, null, 2)}\n`, 'utf8');
}

async function currentData() {
  return miniProgram.evaluate(() => getCurrentPages().slice(-1)[0].data);
}

async function invokeHandler(method, ...args) {
  return miniProgram.evaluate((name, values) => {
    const page = getCurrentPages().slice(-1)[0];
    if (typeof page[name] !== 'function') throw new Error(`未找到处理函数：${name}`);
    return page[name](...values);
  }, method, args);
}

async function rendered(selector, expectedCount) {
  const rects = await miniProgram.evaluate(selector => new Promise(resolve => {
    wx.createSelectorQuery().selectAll(selector).boundingClientRect(resolve).exec();
  }), selector);
  assert.equal(rects.length, expectedCount, `${selector} 渲染数量不符`);
  assert.ok(rects.every(rect => rect.width > 0 && rect.height > 0), `${selector} 未实际显示`);
}

async function waitUntil(read, predicate, description) {
  const end = Date.now() + 8000;
  while (Date.now() < end) {
    const value = await read();
    if (predicate(value)) return value;
    await new Promise(resolve => setTimeout(resolve, 150));
  }
  throw new Error(`等待超时：${description}`);
}

async function check(name, run) {
  stage = name;
  console.log(name);
  await run();
  report.checks.push({ name, passed: true });
}

try {
  const config = JSON.parse(await readFile(projectPath, 'utf8'));
  assert.match(config.appid, /^wx[0-9a-f]{16}$/i, '请先填写新申请的测试 AppID；游客占位值不能用于本次验证。');
  await check('连接微信官方自动化接口', async () => {
    miniProgram = await automator.connect({ wsEndpoint: 'ws://127.0.0.1:9420' });
    // Verify the attached runtime before interacting with any pages.
    const appId = await miniProgram.evaluate(() => wx.getAccountInfoSync().miniProgram.appId);
    assert.equal(appId, config.appid, '自动化端口连接到了其他小程序，已停止操作。');
  });
  await check('首页路由与标题区域实际渲染', async () => {
    const page = await miniProgram.reLaunch('/pages/home/index');
    assert.equal(page.path, 'pages/home/index');
    await rendered('.hero-title', 1);
  });
  await check('资讯入口直达阅读分类，服务大厅展示实际任务', async () => {
    await invokeHandler('openServices', { currentTarget: { dataset: { serviceId: 'insights' } } });
    await waitUntil(() => miniProgram.currentPage(), p => p?.path === 'pages/articles/index', '资讯列表页面');
    assert.equal((await currentData()).category, 'news');
    await rendered('.heading', 1);
    await miniProgram.switchTab('/pages/services/index');
    assert.deepEqual((await currentData()).filteredServices.map(item => item.id), ['knowledge', 'insights', 'posts', 'feedback']);
    await rendered('.service-item', 4);
  });
  await check('搜索处理函数、空结果渲染与清空', async () => {
    await invokeHandler('search', { detail: { value: '知识' } });
    const searched = await currentData();
    assert.equal(searched.query, '知识');
    assert.ok(searched.filteredServices.length > 0);
    await rendered('.service-item', searched.filteredServices.length);
    await invokeHandler('search', { detail: { value: '不存在的服务_automation_check' } });
    assert.equal((await currentData()).filteredServices.length, 0);
    await rendered('.empty-state', 1);
    await invokeHandler('clearSearch');
    const cleared = await currentData();
    assert.equal(cleared.query, '');
    assert.ok(cleared.filteredServices.length > searched.filteredServices.length);
  });
  await check('会员入口处理函数与三档会籍实际渲染', async () => {
    await invokeHandler('openMembers');
    await waitUntil(() => miniProgram.currentPage(), p => p?.path === 'pages/members/index', '会员权益页面');
    // A page-stack update precedes the navigation animation finishing.
    await new Promise(resolve => setTimeout(resolve, 600));
    assert.equal((await currentData()).plans.length, 3);
    await rendered('.plan', 3);
  });
  await miniProgram.switchTab('/pages/home/index');
  report.status = 'passed';
} catch (error) {
  report.status = 'failed';
  report.stage = stage;
  report.error = error.message;
  console.error(`${stage}：${error.message}`);
  process.exitCode = 1;
} finally {
  miniProgram?.disconnect();
  clearTimeout(deadline);
  await saveReport();
  console.log(`${report.status}: ${fileURLToPath(reportPath)}`);
  // The official SDK can retain a socket after a connection/version failure.
  process.exit(process.exitCode || 0);
}
