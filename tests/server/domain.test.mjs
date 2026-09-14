import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { openDatabase } from '../../server/db.mjs';
import { insertUser, createOrder, cancelOrder, reviewOrder, captureReferral, publicUser,
  applyVerifiedPayment, membership, yearAfter } from '../../server/domain.mjs';

const expected = { merchantId:'ISOLATED_TEST_MERCHANT', appId:'ISOLATED_TEST_APP' };
export const orderBody = (planId='basic', referral='') => ({ planId, consent:true, form:{ name:'测试会员',phone:'13800000000',city:'上海',company:'虚构机构',industry:'制造业',need:'内测',organizationType:'机构会员',referral } });
function fixture(t) {
  const db = openDatabase(':memory:'); t.after(()=>db.close());
  const member = insertUser(db,'member','unused-hash');
  const admin = insertUser(db,'admin','unused-hash','admin');
  return {db,member,admin};
}
function receipt(order, overrides={}) { return {...expected, transactionId:randomUUID(),orderId:order.id,currency:'CNY',amountCents:order.amountCents,status:'SUCCESS',paidAt:new Date().toISOString(),...overrides}; }

test('server owns prices, basic/star pending and organization review; approval never activates',t=>{
  const {db,member,admin}=fixture(t);
  const basic=createOrder(db,member.id,{...orderBody(),amountCents:1,status:'paid'},randomUUID());
  assert.equal(basic.amountCents,36500); assert.equal(basic.status,'pending');
  cancelOrder(db,member.id,basic.id);
  const star=createOrder(db,member.id,orderBody('star'),randomUUID());
  assert.equal(star.status,'pending'); assert.equal(star.amountCents,365000);
  cancelOrder(db,member.id,star.id);
  const org=createOrder(db,member.id,orderBody('organization'),randomUUID());
  assert.equal(org.status,'review'); assert.equal(org.amountCents,3650000);
  assert.throws(()=>reviewOrder(db,member.id,org.id,{decision:'approve',note:'no'}),/管理员/);
  assert.throws(()=>reviewOrder(db,admin.id,org.id,{decision:'approve',note:''}),/审核说明/);
  assert.equal(reviewOrder(db,admin.id,org.id,{decision:'approve',note:'测试资质已核对'}).status,'pending');
  assert.equal(membership(db,member.id),null);
  assert.throws(()=>reviewOrder(db,admin.id,org.id,{decision:'reject',note:'重复'}),/已处理/);
  assert.equal(db.prepare("SELECT count(*) n FROM audit_log WHERE action='application.approve'").get().n,1);
});
test('orders are idempotent and only one pending application is allowed',t=>{
  const {db,member}=fixture(t); const key=randomUUID();
  const order=createOrder(db,member.id,orderBody(),key);
  assert.equal(createOrder(db,member.id,orderBody(),key).id,order.id);
  assert.throws(()=>createOrder(db,member.id,orderBody('star'),key),/其他内容/);
  assert.throws(()=>createOrder(db,member.id,orderBody(),randomUUID()),/待处理订单/);
  assert.equal(cancelOrder(db,member.id,order.id).status,'cancelled');
  assert.equal(cancelOrder(db,member.id,order.id).status,'cancelled');
  assert.equal(db.prepare('SELECT count(*) n FROM orders').get().n,1);
});
test('referral is optional; default never overwrites first explicit source; invalid/self/cycle rejected',t=>{
  const {db,member}=fixture(t);
  const a=insertUser(db,'refer_a','unused'),b=insertUser(db,'refer_b','unused');
  assert.equal(captureReferral(db,member.id).sourceCode,null);
  assert.throws(()=>captureReferral(db,member.id,'BADBAD'),/无效/);
  assert.throws(()=>captureReferral(db,member.id,member.referral_code),/自己的/);
  db.prepare("INSERT INTO settings VALUES ('default_referral_code',?)").run(a.referral_code);
  assert.equal(captureReferral(db,a.id).sourceCode,null);
  assert.equal(captureReferral(db,member.id).referralSource,'default');
  assert.equal(captureReferral(db,member.id,b.referral_code).sourceCode,b.referral_code);
  assert.equal(captureReferral(db,member.id,a.referral_code).sourceCode,b.referral_code);
  assert.throws(()=>captureReferral(db,b.id,member.referral_code),/循环/);
  assert.equal(createOrder(db,member.id,orderBody(),randomUUID()).sourceCode,b.referral_code);
});
test('rejected application remains in history, may reapply, invalid application creates nothing',t=>{
  const {db,member,admin}=fixture(t);
  assert.throws(()=>createOrder(db,member.id,{...orderBody('organization'),form:{...orderBody().form,company:''}},randomUUID()),/机构/);
  const order=createOrder(db,member.id,orderBody('organization'),randomUUID());
  assert.equal(reviewOrder(db,admin.id,order.id,{decision:'reject',note:'补充机构资质'}).status,'rejected');
  const next=createOrder(db,member.id,orderBody('organization'),randomUUID());
  assert.notEqual(order.id,next.id);
  assert.equal(db.prepare('SELECT count(*) n FROM orders').get().n,2);
});
test('verified successful receipt activates once; repeated receipt does not extend membership',t=>{
  const {db,member}=fixture(t);const ref=insertUser(db,'referrer','unused');
  const order=createOrder(db,member.id,orderBody('basic',ref.referral_code),randomUUID());
  const paid=receipt(order);
  assert.equal(applyVerifiedPayment(db,paid,expected).outcome,'activated');
  const original=membership(db,member.id);
  assert.equal(original.active,true);
  assert.equal(applyVerifiedPayment(db,paid,expected).duplicate,true);
  assert.deepEqual(membership(db,member.id),original);
  assert.equal(db.prepare('SELECT count(*) n FROM memberships').get().n,1);
  assert.equal(db.prepare('SELECT actual_paid_cents FROM orders WHERE id=?').get(order.id).actual_paid_cents,36500);
  assert.ok(publicUser(db,db.prepare('SELECT * FROM users WHERE id=?').get(member.id)).referralLockedAt);
  assert.throws(()=>createOrder(db,member.id,orderBody('star'),randomUUID()),/续费和升级/);
  assert.equal(membership(db,member.id,original.expiresAt).active,false);
});
test('bad amount, merchant, currency, time or conflicting transaction cannot activate',t=>{
  const {db,member}=fixture(t);const order=createOrder(db,member.id,orderBody(),randomUUID());
  for(const change of [{amountCents:1},{amountCents:1.5},{merchantId:'wrong'},{appId:'wrong'},{currency:'USD'},{paidAt:'invalid'},{paidAt:'2020-01-01T00:00:00Z'}]) {
    assert.throws(()=>applyVerifiedPayment(db,receipt(order,change),expected));
    assert.equal(membership(db,member.id),null);
  }
  assert.throws(()=>applyVerifiedPayment(db,receipt(order),{}),/配置/);
  const paid=receipt(order); applyVerifiedPayment(db,paid,expected);
  assert.throws(()=>applyVerifiedPayment(db,{...paid,status:'FAILED'},expected),/重复流水/);
});
test('failure and cancellation never activate; late/review/duplicate-charge successes require reconciliation',t=>{
  const {db,member}=fixture(t);const order=createOrder(db,member.id,orderBody(),randomUUID());
  for(const status of ['FAILED','CANCELLED'])assert.equal(applyVerifiedPayment(db,receipt(order,{status}),expected).outcome,'not_paid');
  assert.equal(membership(db,member.id),null);
  cancelOrder(db,member.id,order.id);
  assert.equal(applyVerifiedPayment(db,receipt(order),expected).outcome,'needs_reconciliation');
  const org=createOrder(db,member.id,orderBody('organization'),randomUUID());
  assert.equal(applyVerifiedPayment(db,receipt(org),expected).outcome,'needs_reconciliation');
  assert.equal(membership(db,member.id),null);
});
test('payment with no source locks null; later default cannot claim historical payment',t=>{
  const {db,member}=fixture(t);const order=createOrder(db,member.id,orderBody(),randomUUID());
  applyVerifiedPayment(db,receipt(order),expected);
  const ref=insertUser(db,'referrer','unused');
  db.prepare("INSERT INTO settings VALUES ('default_referral_code',?)").run(ref.referral_code);
  assert.equal(captureReferral(db,member.id).sourceCode,null);
  assert.equal(captureReferral(db,member.id,ref.referral_code).sourceCode,null);
});
test('annual term clamps leap day and uses exact expiration boundary',()=>{
  assert.equal(yearAfter('2024-02-29T08:30:00.000Z'),'2025-02-28T08:30:00.000Z');
  assert.equal(yearAfter('2026-09-06T08:30:00.000Z'),'2027-09-06T08:30:00.000Z');
});
test('restart persistence and consistent database backup/restore',()=>{
  const directory=mkdtempSync(join(tmpdir(),'club-db-test-'));
  try{
    const path=join(directory,'test.sqlite'),backupPath=join(directory,'backup.sqlite');
    let db=openDatabase(path);const user=insertUser(db,'persist','unused');
    const order=createOrder(db,user.id,orderBody(),randomUUID()); db.close();
    db=openDatabase(path);assert.equal(db.prepare('SELECT status FROM orders WHERE id=?').get(order.id).status,'pending');
    db.prepare('VACUUM INTO ?').run(backupPath);db.close();
    db=openDatabase(backupPath);assert.equal(db.prepare('PRAGMA integrity_check').get().integrity_check,'ok');
    assert.equal(db.prepare('SELECT count(*) n FROM users').get().n,1);
    assert.equal(db.prepare('SELECT id FROM orders').get().id,order.id); db.close();
  }finally{rmSync(directory,{recursive:true,force:true});}
});
