import test from 'node:test';
import assert from 'node:assert/strict';
import vm from 'node:vm';
import {readFileSync} from 'node:fs';

const message='已收到付款，需人工核对，请勿重复付款';
const pending={id:'SYNTHETIC123',planId:'star',status:'pending',amountCents:100,form:{name:'虚构会员',phone:'000'},createdAt:'2026-10-28T12:00:00Z'};
const top={paymentReconciliationRequired:true};
const legacy={cancellation:{paymentReconciliationRequired:true}};
function harness(kind,order={...pending},channel='ordinary') {
  let page,current=structuredClone(order),stamp={user:'synthetic-member'};
  const calls=[],actions=[],overrides=new Map();
  const api={hasSession:()=>true,sessionStamp:()=>stamp,isCurrentSession:s=>s===stamp,money:value=>String(value/100),
    statusLabels:{pending:'待付款',paid:'已支付',cancelled:'已取消'},paymentLoginCode:async()=>{actions.push('login-code');return 'synthetic-code';},
    api:async(path,body)=>{
      calls.push({path,body});if(overrides.has(path))return overrides.get(path)(body);
      if(path==='/orders')return {orders:[structuredClone(current)]};
      if(path==='/orders/'+pending.id)return {order:structuredClone(current)};
      if(path.endsWith('/payment-status'))return {order:structuredClone(current),enabled:true,paymentChannel:channel,legal:null,legalAccepted:true};
      if(path.endsWith('/payment'))return {paymentChannel:channel,payment:channel==='ordinary'?{package:'synthetic'}:{mode:'short_series_goods',signData:'synthetic',paySig:'a'.repeat(64),signature:'b'.repeat(64)}};
      if(path.endsWith('/cancel')){current={...current,status:'cancelled'};return {order:structuredClone(current)};}
      if(path.endsWith('/legal-consent'))return {};
      throw Error('Unexpected synthetic path '+path);
    }};
  const membershipModule={exports:{}};
  vm.runInNewContext(readFileSync(new URL('../../miniprogram/utils/membership-display.js',import.meta.url),'utf8'),{module:membershipModule});
  const require=path=>path.endsWith('/api')?api:path.endsWith('/membership-display')?membershipModule.exports:
    path.endsWith('/public-documents')?{showPublicDocuments(){},hidePublicDocuments(){},clearPublicDocuments(){}}:
    path.endsWith('/display-time')?{chineseDateTime:v=>v}:path.endsWith('/legal')?{legalConsent:()=>({})}:{returnToPrevious(){}};
  vm.runInNewContext(readFileSync(new URL('../../miniprogram/pages/'+kind+'/index.js',import.meta.url),'utf8'),{require,Page:value=>{page=value;},
    wx:{showModal:options=>{actions.push('modal');options.success({confirm:true});},navigateTo:options=>actions.push(options.url),redirectTo:options=>actions.push(options.url),
      requestPayment:options=>{actions.push('ordinary-payment');current={...current,status:'paid'};options.success({});},
      requestVirtualPayment:options=>{actions.push('virtual-payment');current={...current,status:'paid'};options.success({});},canIUse:()=>true,
      stopPullDownRefresh(){},nextTick:fn=>fn(),pageScrollTo(){}}});
  page.data=structuredClone(page.data);page.setData=value=>Object.assign(page.data,value);page.onLoad({id:pending.id});
  return {page,calls,actions,overrides,load:()=>kind==='payment'?page.onShow():page.refreshOrders(),setOrder:value=>{current=structuredClone(value);},
    changeAccount:()=>{stamp={user:'other-synthetic-member'};}};
}

for(const [name,flag] of [['top-level',top],['legacy cancellation',legacy]]) {
  test('orders '+name+' reconciliation preserves pending status and blocks cancellation/payment',async()=>{
    const h=harness('orders',{...pending,...flag});await h.load();
    assert.equal(h.page.data.selectedOrder.status,'pending');assert.equal(h.page.data.selectedOrder.paymentReconciliationRequired,true);
    assert.equal(h.page.data.selectedOrder.statusLabel,message);assert.equal(h.page.data.orders[0].statusLabel,message);
    assert.equal(h.page.data.selectedOrder.canCancel,false);assert.equal(h.page.data.selectedOrder.hasMemberNextStep,false);
    const before=h.calls.length;await h.page.cancelOrder();h.page.openPayment();assert.equal(h.calls.length,before);assert.deepEqual(h.actions,[]);
    h.page.openHelp();assert.match(h.actions[0],/feedback/);await h.page.refreshOrders();assert.ok(h.calls.length>before);
  });
  test('old payment link loads '+name+' reconciliation and cannot pay, accept legal or reapply',async()=>{
    const h=harness('payment',{...pending,...flag,paymentAttempted:true});await h.load();
    assert.equal(h.page.data.order.status,'pending');assert.equal(h.page.data.order.paymentReconciliationRequired,true);
    assert.equal(h.page.data.hasMemberNextStep,false);
    const before=h.calls.length;await h.page.payWechat();await h.page.reapplyPayment();await h.page.acceptLegal();
    assert.equal(h.calls.length,before);assert.deepEqual(h.actions,[]);
    h.page.openHelp();assert.match(h.actions[0],/feedback/);await h.page.load();assert.ok(h.calls.length>before);
  });
  for(const channel of ['ordinary','virtual'])test(channel+' server recheck catches '+name+' receipt before opening cashier',async()=>{
    const h=harness('payment',pending,channel);await h.load();h.setOrder({...pending,...flag});await h.page.payWechat();
    assert.equal(h.page.data.order.status,'pending');assert.equal(h.page.data.order.paymentReconciliationRequired,true);
    assert.equal(h.page.data.message,message);assert.equal(h.page.data.busy,false);
    assert.equal(h.calls.some(c=>c.path.endsWith('/payment')),false);assert.deepEqual(h.actions,[]);
  });
}

test('reapply refresh after confirmation prevents cancel and redirect when receipt arrived',async()=>{
  const h=harness('payment',{...pending,paymentAttempted:true});await h.load();h.setOrder({...pending,...top,paymentAttempted:true});await h.page.reapplyPayment();
  assert.equal(h.page.data.message,message);assert.deepEqual(h.actions,['modal']);assert.equal(h.calls.some(c=>c.path.endsWith('/cancel')),false);
});

test('orders cancel refresh after confirmation prevents cancel when receipt arrived',async()=>{
  const h=harness('orders');await h.load();h.setOrder({...pending,...legacy});await h.page.cancelOrder();
  assert.equal(h.page.data.message,message);assert.equal(h.page.data.selectedOrder.status,'pending');
  assert.deepEqual(h.actions,['modal']);assert.equal(h.calls.some(c=>c.path.endsWith('/cancel')),false);
});

test('a reconciliation response from cancel remains visible instead of redirecting',async()=>{
  const h=harness('orders');await h.load();h.overrides.set('/orders/'+pending.id+'/cancel',()=>({order:{...pending,...top,status:'cancelled'}}));
  await h.page.cancelOrder();assert.equal(h.page.data.selectedOrder.paymentReconciliationRequired,true);
  assert.equal(h.page.data.message,message);assert.equal(h.page.data.detailMode,true);assert.deepEqual(h.actions,['modal']);
});

test('payment preparation returning reconciliation never opens cashier',async()=>{
  const h=harness('payment');await h.load();h.overrides.set('/orders/'+pending.id+'/payment',()=>{
    const order={...pending,...top};h.setOrder(order);return {order,payment:{package:'must-not-pay'}};
  });await h.page.payWechat();assert.deepEqual(h.actions,[]);assert.equal(h.page.data.message,message);
});

for(const channel of ['ordinary','virtual'])test(channel+' unaffected payment completes with server verified paid response',async()=>{
  const h=harness('payment',pending,channel);await h.load();await h.page.payWechat();
  assert.ok(h.actions.includes(channel+'-payment'));assert.equal(h.page.data.order.status,'paid');
  assert.equal(h.page.data.hasMemberNextStep,true);assert.equal(h.page.data.order.paymentReconciliationRequired,false);
});

test('failed or account-changed server recheck never opens cashier',async()=>{
  for(const changeAccount of [false,true]){
    const h=harness('payment');await h.load();h.overrides.set('/orders/'+pending.id+'/payment-status',()=>{
      if(changeAccount){h.changeAccount();return {order:pending,enabled:true};}throw Error('synthetic offline');
    });await h.page.payWechat();assert.deepEqual(h.actions,[]);assert.equal(h.calls.some(c=>c.path.endsWith('/payment')),false);
  }
});

test('templates suppress payment prompts for reconciliation and retain refresh/help',()=>{
  const read=kind=>readFileSync(new URL('../../miniprogram/pages/'+kind+'/index.wxml',import.meta.url),'utf8');
  const orders=read('orders'),payment=read('payment');
  assert.ok(orders.includes(message));assert.ok(payment.includes(message));
  assert.match(orders,/!selectedOrder\.paymentReconciliationRequired && selectedOrder\.status === 'pending'/);
  assert.match(payment,/!enabled && !order\.paymentReconciliationRequired && order\.status === 'pending'/);
  assert.match(payment,/enabled && order\.status === 'pending' && !order\.paymentReconciliationRequired/);
  assert.match(orders,/error \|\| selectedOrder\.paymentReconciliationRequired/);
  assert.match(payment,/bindtap="load"/);assert.match(orders,/bindtap="openHelp"/);assert.match(payment,/bindtap="openHelp"/);
});
