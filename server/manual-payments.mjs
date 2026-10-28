import { transaction, audit } from './db.mjs';
import { requireRule, ownedOrder, textField, nowISO, yearAfter } from './domain.mjs';

export function installManualPayments(db) {
  db.exec(`CREATE TABLE IF NOT EXISTS manual_payments (
    order_id TEXT PRIMARY KEY REFERENCES orders(id), payer TEXT NOT NULL, payer_reference TEXT NOT NULL,
    status TEXT NOT NULL CHECK(status IN ('pending','rejected','confirmed')), revision INTEGER NOT NULL,
    submitted_at TEXT NOT NULL, note TEXT NOT NULL DEFAULT '', reviewed_by TEXT REFERENCES users(id),
    reviewed_at TEXT, transaction_id TEXT UNIQUE, amount_cents INTEGER, paid_at TEXT
  ); INSERT OR IGNORE INTO schema_version VALUES (11);`);
}
export function manualPayment(db, user, orderId) {
  ownedOrder(db,user.id,orderId);
  return db.prepare('SELECT * FROM manual_payments WHERE order_id=?').get(orderId) ?? null;
}
export function submitManualPayment(db,user,orderId,body) {
  const payer=textField(body.payer,'付款人称呼',80,true), reference=textField(body.reference??'','付款单号',100);
  requireRule(body.consent===true,'请确认已完成付款并同意核对');
  return transaction(db,()=>{
    const order=ownedOrder(db,user.id,orderId);
    requireRule(user.role==='member'&&['basic','star'].includes(order.plan_id),'此订单不支持收款码付款',403);
    const previous=db.prepare('SELECT * FROM manual_payments WHERE order_id=?').get(orderId);
    if(previous?.status==='pending'&&previous.payer===payer&&previous.payer_reference===reference)return previous;
    requireRule(order.status==='pending','此订单不能提交付款说明',409);
    requireRule(!previous||previous.status==='rejected','已有待处理的付款说明，请勿重复付款',409);
    db.prepare(`INSERT INTO manual_payments(order_id,payer,payer_reference,status,revision,submitted_at) VALUES (?,?,?,'pending',1,?)
      ON CONFLICT(order_id) DO UPDATE SET payer=excluded.payer,payer_reference=excluded.payer_reference,status='pending',revision=manual_payments.revision+1,submitted_at=excluded.submitted_at,note='',reviewed_by=NULL,reviewed_at=NULL`)
      .run(orderId,payer,reference,nowISO());
    audit(db,user.id,'manual_payment.submitted',orderId);
    return db.prepare('SELECT * FROM manual_payments WHERE order_id=?').get(orderId);
  });
}
export function reviewManualPayment(db,user,orderId,body) {
  requireRule(user.role==='admin','需要管理员权限',403);
  requireRule(['confirm','reject'].includes(body.decision),'核对操作不正确');
  const note=textField(body.note??'','核对说明',500,true);
  return transaction(db,()=>{
    const claim=db.prepare('SELECT * FROM manual_payments WHERE order_id=?').get(orderId);
    requireRule(claim,'付款说明不存在',404);
    const tx=body.decision==='confirm'?textField(body.transactionId,'收款账单交易单号',100,true):null;
    if(claim.status==='confirmed'&&body.decision==='confirm'&&claim.transaction_id===tx&&claim.amount_cents===body.amountCents&&claim.paid_at===body.paidAt&&claim.note===note)return claim;
    requireRule(claim.status==='pending'&&claim.revision===body.revision,'记录已变化，请刷新后核对',409);
    const order=db.prepare('SELECT * FROM orders WHERE id=?').get(orderId);
    requireRule(order.status==='pending'&&['basic','star'].includes(order.plan_id),'订单当前不可核对开通',409);
    if(body.decision==='confirm') {
      requireRule(body.checked===true,'请先核对商户收款账单');
      requireRule(Number.isSafeInteger(body.amountCents)&&body.amountCents===order.amount_cents,'实际到账金额必须与订单一致');
      const paid=Date.parse(body.paidAt);
      requireRule(Number.isFinite(paid)&&paid>=Date.parse(order.created_at)&&paid<=Date.now()+300000,'到账时间不正确');
      requireRule(!db.prepare('SELECT 1 FROM manual_payments WHERE transaction_id=?').get(tx)&&!db.prepare('SELECT 1 FROM payment_receipts WHERE transaction_id=?').get(tx),'该交易单号已登记，不能重复开通',409);
      requireRule(!db.prepare('SELECT 1 FROM memberships WHERE user_id=?').get(order.user_id),'已有会籍，请另行核对，不能重复开通',409);
      const expires=yearAfter(body.paidAt);
      db.prepare("UPDATE orders SET status='paid',actual_paid_cents=?,paid_at=?,expires_at=? WHERE id=?").run(body.amountCents,body.paidAt,expires,orderId);
      db.prepare('INSERT INTO memberships(user_id,order_id,plan_id,starts_at,expires_at) VALUES (?,?,?,?,?)').run(order.user_id,orderId,order.plan_id,body.paidAt,expires);
      db.prepare('UPDATE users SET referrer_id=?,referral_source=?,referral_locked_at=? WHERE id=?').run(order.referrer_id,order.referral_source,nowISO(),order.user_id);
    }
    db.prepare('UPDATE manual_payments SET status=?,revision=revision+1,note=?,reviewed_by=?,reviewed_at=?,transaction_id=?,amount_cents=?,paid_at=? WHERE order_id=?')
      .run(body.decision==='confirm'?'confirmed':'rejected',note,user.id,nowISO(),tx,body.decision==='confirm'?body.amountCents:null,body.decision==='confirm'?body.paidAt:null,orderId);
    audit(db,user.id,'manual_payment.'+body.decision,orderId,{transactionId:tx,note});
    return db.prepare('SELECT * FROM manual_payments WHERE order_id=?').get(orderId);
  });
}
