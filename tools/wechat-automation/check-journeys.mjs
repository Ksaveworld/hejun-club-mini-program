import assert from 'node:assert/strict';
import { fileURLToPath } from 'node:url';
import { randomBytes, randomUUID } from 'node:crypto';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import automator from 'miniprogram-automator';
import { createArticle, transitionArticle } from '../../server/articles.mjs';
import { openDatabase } from '../../server/db.mjs';
import { createApplication } from '../../server/app.mjs';
import { insertUser, hashPassword } from '../../server/domain.mjs';

const base = 'http://127.0.0.1:5197/api';
const reportPath = new URL('../../work/wechat/journey-redesign-check.json', import.meta.url);
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
const deadline = setTimeout(async () => { report.status = 'failed'; report.stage = stage; report.error = '超过360秒，未通过；须重新打开隔离工程清理运行状态'; await save(); process.exit(1); }, 360000);
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
async function waitFor(read, predicate, label, timeout = 12000) {
  const end = Date.now() + timeout;
  while (Date.now() < end) {
    if (predicate(await read())) { await new Promise(resolve=>setTimeout(resolve,1500)); return; }
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
async function check(name, run) {
  stage = name; console.log(name);
  try { await run(); report.checks.push({ name, passed: true }); }
  catch (error) {
    const stack = await miniProgram.evaluate(() => getCurrentPages().map(page => ({ route: page.route,
      error: page.data.error, loading: page.data.loading, navigationPending: !!page._navigationPending })));
    report.checks.push({ name, passed: false, error: error.message, stack });
    console.error(name + '：' + error.message);
  }
  await save();
}
try {
  await new Promise((resolve, reject) => { server.once('error', reject); server.listen(5197, '127.0.0.1', resolve); });
  const password = randomBytes(20).toString('hex');
  const login = await api('/native/auth/register', { username: 'journey_member', password, consent: true });
  const admin=insertUser(db, 'journey_admin', await hashPassword(password), 'admin');
  await api('/auth/login', { username: 'journey_admin', password });
  const draft=createArticle(db,admin,{title:'隔离知识资料',summary:'用于导航联验',body:'这是独立的阅读正文。',category:'knowledge',access:{visibility:'public',planIds:[]}},randomUUID());
  const article=transitionArticle(db,admin,draft.id,'publish',draft.revision);
  let orderId, ticket;
  miniProgram=await automator.connect({wsEndpoint:process.env.WECHAT_AUTOMATION_ENDPOINT || 'ws://127.0.0.1:9420'});
  const config=JSON.parse(await readFile(new URL('../../miniprogram/project.config.json',import.meta.url),'utf8'));
  assert.equal(await miniProgram.evaluate(()=>wx.getAccountInfoSync().miniProgram.appId),config.appid);
  await miniProgram.evaluate(base=>{getApp().globalData.apiBaseUrl=base;wx.removeStorageSync('club-native-session:'+base);},base);
  await check('选择会籍后登录并继续原申请，提交进入独立进度页',async()=>{
    await miniProgram.reLaunch('/pages/members/index');
    await invoke('openPlan',{currentTarget:{dataset:{planId:'organization'}}});
    await waitFor(()=>miniProgram.currentPage(),p=>p?.path==='pages/login/index','登录页面');
    await waitFor(data,d=>d.localAvailable&&!d.healthLoading,'登录能力');
    await new Promise(resolve=>setTimeout(resolve,700));
    await invoke('toggleLocal');await invoke('changeField',{currentTarget:{dataset:{field:'username'}},detail:{value:'journey_member'}});
    await invoke('changeField',{currentTarget:{dataset:{field:'password'}},detail:{value:password}});
    await invoke('changeConsent',{detail:{value:['agree']}});await invoke('submitLocal');
    if((await data()).returnReady){report.loginNavigationRecovery=true;await invoke('finishLogin');}
    await waitFor(()=>miniProgram.currentPage(),p=>p?.path==='pages/join/index','登录回到选定申请');
    await waitFor(data,d=>d.loggedIn&&d.planReady&&!d.loading,'申请就绪');
    assert.equal((await data()).planId,'organization');
    for(const [field,value]of Object.entries({name:'隔离申请人',phone:'13800000000',city:'测试城市',company:'隔离机构'}))await invoke('changeField',{currentTarget:{dataset:{field}},detail:{value}});
    await invoke('changeConsent',{detail:{value:['agree']}});await invoke('submit');
    await waitFor(()=>miniProgram.currentPage(),p=>p?.path==='pages/orders/index','独立进度页');
    await waitFor(data,d=>!!d.selectedOrder&&!d.loading,'已保存结果');
    const current=await data();orderId=current.selectedOrder.id;assert.equal(current.detailMode,true);assert.equal(current.selectedOrder.status,'review');
    await rendered('.order-detail');await rendered('.orders-list',0);await rendered('.cancel-order',0);
  });
  await check('我的显示审核任务，审核后返回自动更新，取消收进更多操作',async()=>{
    await miniProgram.switchTab('/pages/account/index');await waitFor(data,d=>d.journey&&!d.loading,'我的任务');
    assert.equal((await data()).journey.title,'资质审核中');await rendered('.journey-action');
    await invoke('openJourney');await waitFor(data,d=>d.detailMode&&d.selectedOrder&&!d.loading,'同一订单');assert.equal((await data()).selectedOrder.id,orderId);
    await api('/admin/orders/'+orderId+'/review',{decision:'approve',note:'隔离交互联验审核说明'});
    await invoke('refreshOrders');assert.equal((await data()).selectedOrder.status,'pending');await rendered('.cancel-order',0);
    await invoke('toggleMore');await rendered('.cancel-order');await invoke('toggleMore');
    await invoke('backToRecords');await waitFor(()=>miniProgram.currentPage(),p=>p?.path==='pages/account/index','回到我的',45000);
    await waitFor(data,d=>d.journey&&!d.loading,'更新我的任务');assert.equal((await data()).journey.title,'订单待付款');
    try { await Promise.race([miniProgram.screenshot({path:fileURLToPath(new URL('../../work/wechat/journey-account.png',import.meta.url))}),new Promise((_,reject)=>setTimeout(()=>reject(new Error('截图通道超时')),4000))]);report.accountScreenshot=true; } catch(e) {report.screenshotWarning=e.message;}
  });
  await check('知识库直达分类，独立正文返回原分类',async()=>{
    await miniProgram.switchTab('/pages/home/index');await invoke('openServices',{currentTarget:{dataset:{serviceId:'knowledge'}}});
    await waitFor(data,d=>d.ready&&d.category==='knowledge'&&!d.loading,'知识列表');await rendered('.article-item');
    await invoke('navigateArticle',{currentTarget:{dataset:{id:article.id}}});await waitFor(data,d=>d.detailId===article.id&&d.selected&&!d.loading,'正文');
    await rendered('.article-body');await rendered('.article-item',0);assert.equal((await data()).selected.body,article.body);
    await invoke('backToList');await waitFor(data,d=>d.category==='knowledge'&&d.ready&&!d.loading&&!d.detailId,'返回分类',45000);
  });
  await check('订单求助保留关联，新建后进入详情，回复可补充并确认解决',async()=>{
    await miniProgram.reLaunch('/pages/orders/index?id='+orderId);await waitFor(data,d=>d.selectedOrder&&!d.loading,'订单');await invoke('openHelp');
    await waitFor(data,d=>d.mode==='new'&&d.ready&&!d.loading,'新问题');assert.equal((await data()).relatedOrderId,orderId);
    await invoke('changeField',{currentTarget:{dataset:{field:'title'}},detail:{value:'隔离反馈'}});await invoke('changeField',{currentTarget:{dataset:{field:'body'}},detail:{value:'请核对申请进度'}});await invoke('submit');
    await waitFor(data,d=>d.mode==='detail'&&d.selected&&!d.loading,'反馈详情');ticket=(await data()).selected;assert.equal(ticket.relatedOrderId,orderId);await rendered('.feedback-form',0);await rendered('.feedback-item',0);
    ticket=(await api('/admin/feedback/'+ticket.id+'/reply',{revision:ticket.revision,body:'请核对本次回复',status:'resolved'},randomUUID())).ticket;
    await invoke('refresh');assert.equal((await data()).selected.statusLabel,'已回复，待你确认');
    await invoke('changeFollowup',{detail:{value:'还有一处需要说明'}});await invoke('sendFollowup');ticket=(await data()).selected;assert.equal(ticket.status,'processing');assert.equal(ticket.events.length,2);
    ticket=(await api('/admin/feedback/'+ticket.id+'/reply',{revision:ticket.revision,body:'补充问题已处理',status:'resolved'},randomUUID())).ticket;
    await invoke('refresh');await invoke('memberAction','confirm');assert.ok((await data()).selected.confirmedAt);await rendered('.feedback-followup',0);await rendered('.feedback-event',4);
    assert.equal(db.prepare('SELECT COUNT(*) n FROM memberships').get().n,0);
  });
  report.status = report.checks.every(item => item.passed) ? 'passed' : 'failed';
  if (report.status === 'failed') process.exitCode = 1;
} catch (error) { if(miniProgram) {try{report.failurePage=await miniProgram.evaluate(()=>{const p=getCurrentPages().slice(-1)[0];return {route:p.route,error:p.data.error,planId:p.data.planId,loginPlan:p._planId,consent:p.data.consent};});}catch{}} report.status = 'failed'; report.stage = stage; report.error = error.message; process.exitCode = 1; console.error(stage + '：' + error.message); }
finally {
  try {
    if (miniProgram) {
      // A ready page can precede the end of its native navigation animation.
      await new Promise(resolve => setTimeout(resolve, 600));
      report.cleanupStage = '清理隔离会话和端点';
      report.isolatedStateCleared = await miniProgram.evaluate(base => {
        wx.removeStorageSync('club-native-session:' + base); wx.removeStorageSync('club-native-referral:' + base);
        for (const page of getCurrentPages()) {
          if (page._orderStamp?.scope === base) page.clearOrders();
          if (page._accountStamp?.scope === base) page.clearAccount();
          if (page._viewStamp?.scope === base && typeof page.clearView === 'function') page.clearView();
        }
        delete getApp().globalData.apiBaseUrl;
        return !wx.getStorageSync('club-native-session:' + base) && !getApp().globalData.apiBaseUrl;
      }, base);
      assert.equal(report.isolatedStateCleared, true, '隔离会话和端点须清理');
      report.cleanupStage = '返回首页';
      const goHome = () => miniProgram.evaluate(() => new Promise(resolve => wx.reLaunch({ url: '/pages/home/index',
        success: () => resolve({ ok: true }), fail: error => resolve({ ok: false, error: error.errMsg }) })));
      let home = await Promise.race([goHome(),new Promise(resolve=>setTimeout(()=>resolve({ok:false,error:'cleanup timeout'}),12000))]);
      if (!home.ok && /timeout/.test(home.error || '')) {
        // Only retry this idempotent cleanup navigation, never business writes.
        report.cleanupNavigationWarning = home.error;
        report.cleanupNavigationRetries = 1;
        home = await Promise.race([goHome(),new Promise(resolve=>setTimeout(()=>resolve({ok:false,error:'cleanup timeout'}),12000))]);
      }
      assert.equal(home.ok, true, home.error || '返回首页失败');
      await waitFor(() => miniProgram.currentPage(), page => page?.path === 'pages/home/index', '清理后返回首页');
      const clean = await miniProgram.evaluate(base => !getApp().globalData.apiBaseUrl && !wx.getStorageSync('club-native-session:' + base), base);
      assert.equal(clean, true, '隔离会话和端点须清理');
      report.cleanupStage = '已核实清理完成';
    }
  } catch (error) { report.cleanupError = error.message; report.status = 'failed'; process.exitCode = 1; }
  miniProgram?.disconnect(); server.closeAllConnections(); await new Promise(resolve => server.close(resolve)); db.close();
  clearTimeout(deadline); await save(); console.log(report.status + ': work/wechat/journey-redesign-check.json'); process.exit(process.exitCode || 0);
}
