import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { request } from 'node:http';
import { randomUUID } from 'node:crypto';
import vm from 'node:vm';
import { openDatabase } from '../../server/db.mjs';
import { createApplication } from '../../server/app.mjs';
import { hashPassword, insertUser } from '../../server/domain.mjs';

const password = 'IsolatedFeedbackPassword1';
const article = { title: '隔离反馈问题', body: '问题描述。\n<script>仅作为文字</script>' };
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
    navigateTo: options => navigations.push(options.url), redirectTo: options => navigations.push(options.url),
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
  vm.runInNewContext(readFileSync(new URL('../../miniprogram/pages/feedback/index.js', import.meta.url), 'utf8'),
    { Page: value => { definition = value; }, require: path => path.endsWith('/drafts') ? load('utils/drafts.js') : client, wx, Error });
  const freshPage = (options = {}) => {
  const page = { ...definition, data: structuredClone(definition.data), writes: 0,
    setData(patch) { this.writes++; Object.assign(this.data, patch); } };
  page.onLoad(options); page._visible = true; return page; };
  const page = freshPage();
  const login = (username = 'feedback_member', register = true) => client.loginLocal({ username, password, register });
  const fill = () => {for(const [field,value] of Object.entries(article)) page.changeField({currentTarget:{dataset:{field}},detail:{value}});};
  async function handle(id, action, body, key=randomUUID()) {
    if(!db.prepare("SELECT id FROM users WHERE username='feedback_admin'").get())insertUser(db,'feedback_admin',await hashPassword(password),'admin');
    const session=await http('/auth/login',{username:'feedback_admin',password});
    const result=await http('/admin/feedback/'+id+'/'+action,body,{Cookie:session.cookie,'Idempotency-Key':key});
    await http('/auth/logout',{}, {Cookie:session.cookie});return result;
  }
  return {db,page,freshPage,client,login,fill,sent,http,handle,navigations,hook:value=>{responseHook=value;}};
}

test('unpaid native account submits, receives admin acceptance and preserved replies through real HTTP',async t=>{
  const e=await setup(t);await e.login();await e.page.refresh();await e.page.submit();
  assert.equal(e.page.data.ready,true);assert.equal(e.page.data.busy,false);assert.match(e.page.data.error,/请填写/);
  e.fill();await e.page.submit();
  assert.equal(e.page.data.selected.status,'open');const id=e.page.data.selected.id;
  assert.equal((await e.handle(id,'accept',{revision:1})).statusCode,200);
  assert.equal((await e.handle(id,'reply',{revision:2,body:'隔离回复',status:'resolved'})).statusCode,200);
  await e.page.refresh();await e.page.openTicket({currentTarget:{dataset:{id}}});
  assert.equal(e.page.data.selected.events.length,2);assert.equal(e.page.data.selected.events[1].body,'隔离回复');
  assert.equal(e.page.data.selected.status,'resolved');assert.equal(e.db.prepare('SELECT count(*) n FROM memberships').get().n,0);
});
test('lost successful submission can refresh and retry same payload without duplicating a ticket',async t=>{
  const e=await setup(t);await e.login();await e.page.refresh();e.fill();
  e.hook((path,options,response)=>{if(path==='/feedback'&&options.method==='POST'){e.hook(null);options.fail();return true;}});
  await e.page.submit();await e.page.refresh();assert.equal(e.page.data.body,article.body);await e.page.submit();
  assert.equal(e.db.prepare('SELECT count(*) n FROM feedback_tickets').get().n,1);
  const writes=e.sent.filter(x=>x.path==='/feedback'&&x.method==='POST');assert.equal(writes[0].key,writes[1].key);
});
test('same-account return retains unsent text; another account clears it and cannot read old ticket',async t=>{
  const e=await setup(t);await e.login();await e.page.refresh();e.fill();await e.page.submit();const id=e.page.data.selected.id;e.fill();
  e.page.onHide();assert.equal(e.page.data.body,'');await e.page.onShow();assert.equal(e.page.data.body,article.body);
  e.client.clearSession({logout:true});await e.login('second_feedback');await e.page.refresh();assert.equal(e.page.data.body,'');assert.equal(e.page.data.tickets.length,0);
  await assert.rejects(e.client.api('/feedback/'+id),err=>err.status===404);
  await assert.rejects(e.client.api('/admin/feedback'),err=>err.status===403);
});
test('server-revoked session and delayed response after hiding cannot restore private feedback',async t=>{
  const e=await setup(t);const user=(await e.login()).user;await e.page.refresh();e.fill();await e.page.submit();const id=e.page.data.selected.id;
  e.hook((path,options,response)=>{if(path==='/feedback/'+id){e.page.onHide();e.hook(null);options.success(response);return true;}});
  await e.page.openTicket({currentTarget:{dataset:{id}}});assert.equal(e.page.data.selected,null);
  await e.page.onShow();e.db.prepare('DELETE FROM native_sessions WHERE user_id=?').run(user.id);await e.page.refresh();
  assert.equal(e.page.data.ready,false);assert.equal(e.page.data.tickets.length,0);
});

test('new feedback navigates to its detail; reading a reply clears its badge and member followup can retry once',async t=>{
 const e=await setup(t);await e.login();e.page.onLoad({mode:'new'});await e.page.refresh();e.fill();await e.page.submit();
 const id=e.page.data.selected.id;assert.equal(e.navigations[0],'/pages/feedback/index?mode=detail&id='+id);
 await e.handle(id,'reply',{revision:1,body:'请核对',status:'resolved'});assert.equal((await e.client.api('/feedback/summary')).unreadCount,1);
 e.page.onLoad({mode:'detail',id});await e.page.refresh();assert.equal(e.page.data.selected.statusLabel,'已回复，待你确认');assert.equal((await e.client.api('/feedback/summary')).unreadCount,0);
 e.page.changeFollowup({detail:{value:'仍有问题'}});e.hook((path,options)=>{if(path.endsWith('/followup')){e.hook(null);options.fail();return true;}});
 await e.page.sendFollowup();assert.equal(e.page.data.followup,'仍有问题');await e.page.sendFollowup();assert.equal(e.page.data.selected.events.length,2);assert.equal(e.page.data.selected.status,'processing');
 await e.handle(id,'reply',{revision:3,body:'重新处理好了',status:'resolved'});await e.page.refresh();await e.page.memberAction('confirm');assert.ok(e.page.data.selected.confirmedAt);assert.equal(e.page.data.selected.statusLabel,'已解决');
});


test('a fresh form restores only this member draft, and confirmed submission clears it',async t=>{
 const e=await setup(t);const identity=await e.login();
 const first=e.freshPage({mode:'new'});await first.onShow();
 for(const [field,value] of Object.entries(article))first.changeField({currentTarget:{dataset:{field}},detail:{value}});
 first.onHide();first.onUnload();
 const resumed=e.freshPage({mode:'new'});await resumed.onShow();assert.equal(resumed.data.title,article.title);assert.equal(resumed.data.body,article.body);
 await resumed.submit();const clean=e.freshPage({mode:'new'});await clean.onShow();assert.equal(clean.data.title,'');assert.equal(clean.data.body,'');
});


test('unsubmitted followup survives reopening the same problem and is never sent automatically',async t=>{
 const e=await setup(t);await e.login();await e.page.onShow();e.fill();await e.page.submit();const id=e.page.data.selected.id;
 const detail=e.freshPage({mode:'detail',id});await detail.onShow();detail.changeFollowup({detail:{value:'暂未发送的补充'}});detail.onHide();detail.onUnload();
 const resumed=e.freshPage({mode:'detail',id});await resumed.onShow();assert.equal(resumed.data.followup,'暂未发送的补充');assert.equal(resumed.data.selected.events.length,0);
 await resumed.sendFollowup();assert.equal(resumed.data.selected.events.length,1);
 const clean=e.freshPage({mode:'detail',id});await clean.onShow();assert.equal(clean.data.followup,'');
});
