import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { openDatabase } from '../../server/db.mjs';
import { insertUser, createOrder, applyVerifiedPayment } from '../../server/domain.mjs';
import { publishMemberPost, moderateMemberPost } from '../../server/posts.mjs';
import { installAmbassadors, applyAmbassador, ambassadorStatus, listAmbassadors, followAmbassador } from '../../server/ambassadors.mjs';
function setup(t) {
  const db = openDatabase(':memory:'); installAmbassadors(db); t.after(() => db.close());
  const member = insertUser(db, 'flow_member', 'unused'), unpaid = insertUser(db, 'flow_unpaid', 'unused'), admin = insertUser(db, 'flow_admin', 'unused', 'admin');
  const order = createOrder(db, member.id, { planId: 'basic', consent: true, form: { name: '隔离测试', phone: '13800000000', city: '上海' } }, randomUUID());
  const expected = { appId: 'ISOLATED_FLOW', merchantId: 'ISOLATED_FLOW' };
  applyVerifiedPayment(db, { ...expected, orderId: order.id, transactionId: randomUUID(), currency: 'CNY', amountCents: order.amountCents, status: 'SUCCESS', paidAt: new Date().toISOString() }, expected);
  return { db, member, unpaid, admin };
}
test('direct publication is paid-member-only; removed content remains removed on repeated submission', t => {
  const { db, member, unpaid, admin } = setup(t), key = randomUUID(), body = { title: '会员经验', body: '原创文字' };
  assert.throws(() => publishMemberPost(db, unpaid, body, key), /有效期/);
  const post = publishMemberPost(db, member, body, key); assert.equal(post.status, 'published');
  assert.throws(() => moderateMemberPost(db, unpaid, post.id, { status: 'rejected', reason: '试图越权' }), /管理员/);
  assert.throws(() => moderateMemberPost(db, admin, post.id, { status: 'rejected', reason: '' }), /审核说明/);
  moderateMemberPost(db, admin, post.id, { status: 'rejected', reason: '需要补充来源' });
  moderateMemberPost(db, admin, post.id, { status: 'rejected', reason: '需要补充来源' });
  assert.equal(publishMemberPost(db, member, body, key).status, 'rejected');
  assert.equal(db.prepare("SELECT count(*) n FROM audit_log WHERE action='post.removed'").get().n, 1);
  assert.equal(db.prepare("SELECT count(*) n FROM posts WHERE status='published'").get().n, 0);
});
test('ambassador application persists once, has no reward balance and staff follows up with revision checks', t => {
  const { db, member, unpaid, admin } = setup(t), key = randomUUID(), body = { contact: 'isolated-wechat', introduction: '帮助联系同行', consent: true };
  assert.throws(() => applyAmbassador(db, unpaid, body, key), /付费会员/);
  assert.throws(() => applyAmbassador(db, member, { ...body, consent: false }, key), /同意/);
  const application = applyAmbassador(db, member, body, key);
  assert.equal(applyAmbassador(db, member, body, key).id, application.id);
  assert.equal(applyAmbassador(db, member, body, randomUUID()).id, application.id);
  assert.throws(() => applyAmbassador(db, member, { ...body, contact: 'other' }, key), /已有申请/);
  assert.equal(ambassadorStatus(db, unpaid).application, null);
  assert.throws(() => listAmbassadors(db, unpaid), /管理员/);
  assert.throws(() => followAmbassador(db, member, application.id, { note: '越权', revision: 1 }), /管理员/);
  const result = followAmbassador(db, admin, application.id, { note: '已联系，具体规则后续通知', revision: 1 });
  assert.equal(result.status, 'contacted'); assert.equal(result.revision, 2);
  assert.throws(() => followAmbassador(db, admin, application.id, { note: '过时覆盖', revision: 1 }), /已变化/);
  assert.equal(followAmbassador(db, admin, application.id, { note: result.staffNote, revision: 1 }).revision, 2);
  assert.equal('balance' in result, false);
  db.prepare("UPDATE memberships SET expires_at='2000-01-01T00:00:00Z'").run();
  assert.equal(ambassadorStatus(db, member).canApply, false);
  assert.equal(ambassadorStatus(db, member).application.staffNote, result.staffNote);
  installAmbassadors(db); assert.equal(listAmbassadors(db, admin).applications.length, 1);
});
