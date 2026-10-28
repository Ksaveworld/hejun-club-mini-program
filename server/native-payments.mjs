import {transaction} from './db.mjs';
import {merchantOrderId} from './wechat-pay.mjs';
import {applyVerifiedPayment,ownedOrder,requireRule,plans,orderView} from './domain.mjs';

export function createNativePayments(db,provider){
  const key=id=>'wechat_payment_attempt:'+id;
  const attempted=id=>!!db.prepare('SELECT 1 FROM settings WHERE key=?').get(key(id));
  function identity(order){
    const row=db.prepare('SELECT open_id FROM wechat_identities WHERE app_id=? AND user_id=?').get(provider.appId,order.user_id);
    requireRule(row,'请使用当前小程序微信身份登录后付款',403);return row.open_id;
  }
  function ready(){requireRule(provider?.configured,'微信支付正在配置，暂未开放',503);}
  async function sync(id,notification){
    ready();const tradeNo=merchantOrderId(id);
    const remote=await provider.query(id);
    requireRule(remote.appid===provider.appId&&remote.mchid===provider.merchantId&&remote.out_trade_no===tradeNo,'支付主体或订单不匹配',409);
    if(notification)requireRule(remote.trade_state==='SUCCESS'&&remote.transaction_id===notification.transaction_id,'支付通知与查单结果不一致',409);
    if(remote.trade_state==='SUCCESS'){
      const order=db.prepare('SELECT * FROM orders WHERE id=?').get(id);requireRule(order,'订单不存在',404);
      requireRule(remote.payer?.openid===identity(order),'支付人身份不匹配',409);
      applyVerifiedPayment(db,{appId:remote.appid,merchantId:remote.mchid,orderId:id,transactionId:remote.transaction_id,status:'SUCCESS',currency:remote.amount?.currency,amountCents:remote.amount?.total,paidAt:remote.success_time},provider);
    }
    return remote;
  }
  return {
    attempted,
    async prepay(user,id){
      ready();
      const order=transaction(db,()=>{
        const order=ownedOrder(db,user.id,id);
        requireRule(user.role==='member'&&order.status==='pending'&&!plans[order.plan_id]?.registrationOnly,'当前订单不能付款',409);
        requireRule(!db.prepare("SELECT 1 FROM manual_payments WHERE order_id=? AND status IN ('pending','confirmed')").get(id),'已有付款记录待核对，请勿重复付款',409);
        requireRule(db.prepare('SELECT value FROM settings WHERE key=?').get(key(id))?.value!=='closing','订单正在关闭，请稍后刷新',409);
        identity(order);
        db.prepare('INSERT INTO settings(key,value) VALUES(?,?) ON CONFLICT(key) DO NOTHING').run(key(id),'initiated');
        return order;
      });
      return provider.prepay(order,identity(order));
    },
    async close(user,id){
      ready();const order=ownedOrder(db,user.id,id);requireRule(order.status==='pending','当前订单不能取消',409);
      db.prepare('UPDATE settings SET value=? WHERE key=?').run('closing',key(id));
      await provider.close(id);
    },
    async status(user,id){
      const order=ownedOrder(db,user.id,id);
      if(attempted(id)&&order.status!=='paid')await sync(id);
      return orderView(db,ownedOrder(db,user.id,id));
    },
    async notify(headers,raw){
      ready();const notification=provider.decodeNotification(headers,raw);
      requireRule(notification.appid===provider.appId&&notification.mchid===provider.merchantId,'支付通知主体不匹配',409);
      requireRule(typeof notification.out_trade_no==='string'&&/^[A-F0-9]{32}$/.test(notification.out_trade_no),'支付通知订单不正确',409);
      await sync('HJ'+notification.out_trade_no,notification);
    }
  };
}
