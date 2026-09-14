import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { request } from 'node:http';
import { randomUUID } from 'node:crypto';
import vm from 'node:vm';
import { openDatabase } from '../../server/db.mjs';
import { createApplication } from '../../server/app.mjs';
import { insertUser, hashPassword, createOrder, applyVerifiedPayment } from '../../server/domain.mjs';
import { createResource, transitionResource } from '../../server/resources.mjs';

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
  function freshPage(name='service-detail', options={}) {
  let definition;
  vm.runInNewContext(readFileSync(new URL('../../miniprogram/pages/'+name+'/index.js', import.meta.url), 'utf8'),
    { Page: value => { definition = value; }, require: () => client, wx, Error, getApp:()=>({globalData:{}}) });
  const page = { ...definition, data: structuredClone(definition.data), writes: 0,
    setData(patch) { this.writes++; Object.assign(this.data, patch); } };
  if(page.onLoad)page.onLoad(options);return page;
  }
  const page=freshPage();
  const admin = insertUser(db, 'resource_admin', await hashPassword('FixturePassword1'), 'admin');
  function publish(category, visibility = 'public') {
    const resource = createResource(db, admin, { title: category + '测试资料', summary: '说明文字', body: '<b>按原文显示</b>\n第二段', category,
      action:{type:'miniProgram',appId:'wx0000000000000001',path:'pages/course/index?id=fixture'}, access: { visibility, planIds: visibility === 'plans' ? ['basic'] : [] } }, randomUUID());
    return transitionResource(db, admin, resource.id, 'publish', resource.revision);
  }
  async function member(username = 'resource_member') {
    const user = (await client.loginLocal({ username, password: 'FixturePassword1', register: true })).user;
    const order = createOrder(db, user.id, { planId: 'basic', consent: true, form: { name: '隔离会员', phone: '13800000000', city: '测试城市' } }, randomUUID());
    const expected = { appId: 'ISOLATED_ARTICLES', merchantId: 'ISOLATED_ARTICLES' };
    applyVerifiedPayment(db, { ...expected, transactionId: randomUUID(), orderId: order.id, amountCents: order.amountCents,
      currency: 'CNY', status: 'SUCCESS', paidAt: new Date().toISOString() }, expected);
    return user;
  }
  return { db, page, wx, freshPage, client, publish, member, admin, hook: value => { hook = value; },
    open: async resource => {page.onLoad({id:resource.id});await page.onShow();} };
}


test('published service catalog searches and opens an authorized detail; hidden page clears all private entries',async t=>{
 const env=await setup(t), resource=env.publish('lectures');env.publish('directory','plans');
 const catalog=env.freshPage('services');let route;env.wx.navigateTo=o=>{route=o.url;};
 await catalog.onShow();assert.equal(catalog.data.resources.length,1);assert.equal(catalog.data.filteredServices.length,6);assert.ok(catalog.data.filteredServices.some(item=>item.id==='activities'));
 catalog.search({detail:{value:'lectures'}});assert.equal(catalog.data.filteredServices.length,1);
 catalog.openService({currentTarget:{dataset:{serviceId:resource.id}}});assert.equal(route,'/pages/service-detail/index?id='+resource.id);
 await env.open(resource);assert.equal(env.page.data.service.body,resource.body);
 catalog.onHide();assert.equal(catalog.data.resources.length,0);assert.equal(catalog.data.filteredServices.length,0);
 env.page.onHide();assert.equal(env.page.data.service,null);
});
test('opening a resource rechecks server permission, requires confirmation, and calls the configured native action once',async t=>{
 const env=await setup(t), resource=env.publish('lectures');await env.open(resource);
 let calls=0;env.wx.showModal=o=>o.success({confirm:false});env.wx.navigateToMiniProgram=o=>{calls++;assert.equal(o.appId,resource.action.appId);assert.equal(o.envVersion,'release');o.success();};
 await env.page.useService();assert.equal(calls,0);env.page.cancelUse();
 await Promise.all([env.page.useService(),env.page.useService()]);assert.equal(calls,0);env.page.confirmService();env.page.confirmService();assert.equal(calls,1);
 env.wx.navigateToMiniProgram=o=>o.fail();await env.page.useService();env.page.confirmService();assert.match(env.page.data.error,/未能打开/);assert.equal(env.page.data.opening,false);
});
test('withdrawal and membership expiry stop service use even with previously loaded details',async t=>{
 const env=await setup(t), user=await env.member(), resource=env.publish('lectures','plans');let calls=0;
 env.wx.showModal=()=>{calls++;};await env.open(resource);
 env.db.prepare("UPDATE memberships SET expires_at='2000-01-01T00:00:00.000Z' WHERE user_id=?").run(user.id);
 await env.page.useService();assert.equal(calls,0);assert.equal(env.page.data.service,null);assert.match(env.page.data.error,/不可使用/);
 const pub=env.publish('translation');await env.open(pub);transitionResource(env.db,env.admin,pub.id,'unpublish',pub.revision);
 await env.page.useService();assert.equal(calls,0);assert.equal(env.page.data.service,null);
});
test('late response and account change while confirming cannot expose details or open an external service',async t=>{
 const env=await setup(t);await env.member();const resource=env.publish('lectures','plans');
 env.hook((options,response)=>{env.page.onHide();env.hook(null);options.success(response);return true;});
 await env.open(resource);assert.equal(env.page.data.service,null);
 await env.open(resource);let calls=0;env.wx.navigateToMiniProgram=()=>{calls++;};
 await env.page.useService();env.client.clearSession({logout:true});env.page.confirmService();assert.equal(calls,0);assert.equal(env.page.data.service,null);
 await env.page.refresh();assert.equal(env.page.data.service,null);
});
test('changed resource is shown for review before use; phone dispatch uses only its configured number',async t=>{
 const env=await setup(t), resource=env.publish('visits');await env.open(resource);let calls=0;
 env.wx.showModal=o=>o.success({confirm:true});env.wx.makePhoneCall=o=>{calls++;assert.equal(o.phoneNumber,'13800000000');o.success();};
 let withdrawn=transitionResource(env.db,env.admin,resource.id,'unpublish',resource.revision);
 const {updateResource}=await import('../../server/resources.mjs');
 withdrawn=updateResource(env.db,env.admin,resource.id,{...withdrawn,action:{type:'phone',phoneNumber:'13800000000'}});
 transitionResource(env.db,env.admin,resource.id,'publish',withdrawn.revision);
 await env.page.useService();assert.equal(calls,0);assert.match(env.page.data.error,/已更新/);
 await env.page.useService();env.page.confirmService();assert.equal(calls,1);
});

test('service confirmation expires and dispatch stays synchronous in the final tap handler',async t=>{
 const env=await setup(t),resource=env.publish('lectures');await env.open(resource);await env.page.useService();let calls=0;
 env.wx.navigateToMiniProgram=o=>{calls++;o.success();};env.page._prepared.expiresAt=0;env.page.confirmService();assert.equal(calls,0);assert.match(env.page.data.error,/更新服务状态/);
 await env.page.useService();env.page.confirmService();assert.equal(calls,1);assert.equal(env.page.data.confirming,false);
});
