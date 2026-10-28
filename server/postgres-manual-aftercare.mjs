import {postgresTransaction,safeInteger} from './postgres.mjs';
import {requireRule,digest} from './domain.mjs';

export const manualAftercareKey=id=>'manual_aftercare_completed:'+id;
const one=async(c,sql,args=[])=>(await c.query(sql,args)).rows[0];
const parse=value=>{try{return JSON.parse(value);}catch{return null;}};
const snapshot=row=>({userId:row.user_id,orderId:row.order_id,planId:row.plan_id,startsAt:row.starts_at,expiresAt:row.expires_at});
const fields=['externalRefundId','refundAmountCents','refundCompletedAt','evidenceReference','decisionReference','reason','membershipDisposition','attestation'];

export async function manualAftercareSummaryInTransaction(c,id){
  const saved=await one(c,'SELECT value FROM settings WHERE key=$1',[manualAftercareKey(id)]);
  if(!saved)return null;
  const record=parse(saved.value);
  requireRule(record?.version===1&&record.orderId===id&&record.status==='completed','人工售后记录需核对',409);
  return {status:record.status,membershipDisposition:record.request.membershipDisposition,refundAmountCents:record.request.refundAmountCents,
    refundCompletedAt:record.request.refundCompletedAt,recordedAt:record.recordedAt};
}

// Records an authenticated administrator's attestation of an externally completed
// refund. References are audit evidence, NOT independent payment-provider proof.
// This module never requests a refund or chooses a refund/entitlement policy.
export function createPostgresManualAftercare(pool,{schema,appId,env:expectedEnv=0,clock=Date.now,authorizeInTransaction}={}){
  requireRule(/^club_migration_[a-z0-9_]{1,40}$/.test(schema||'')&&/^wx[a-f0-9]{16}$/.test(appId||'')&&[0,1].includes(expectedEnv),'人工售后数据区或小程序配置不正确');
  const run=fn=>postgresTransaction(pool,async c=>{
    await c.query(`SET LOCAL search_path TO "${schema}"`);
    await c.query('LOCK TABLE users IN SHARE ROW EXCLUSIVE MODE');
    return fn(c);
  });
  const summaryInTransaction=manualAftercareSummaryInTransaction;
  return {
    summaryInTransaction,
    recordCompleted:(actor,id,input,request)=>run(async c=>{
      if(authorizeInTransaction){
        await c.query('LOCK TABLE sessions IN SHARE ROW EXCLUSIVE MODE');
        const authenticated=await authorizeInTransaction(c,request,new Date(clock()).toISOString());
        requireRule(authenticated?.id===actor?.id,'管理员登录已变化',401);
      }
      requireRule(actor?.role==='admin'&&await one(c,"SELECT 1 FROM users WHERE id=$1 AND role='admin'",[actor.id]),'需要管理员权限',403);
      requireRule(input&&typeof input==='object'&&!Array.isArray(input)&&Object.keys(input).length===fields.length&&fields.every(key=>Object.hasOwn(input,key)),'请完整填写人工售后记录');
      const body={};
      for(const key of fields){
        if(key==='refundAmountCents'){requireRule(Number.isSafeInteger(input[key])&&input[key]>0,'退款金额必须是正整数分');body[key]=input[key];continue;}
        requireRule(typeof input[key]==='string'&&input[key].trim().length>0&&input[key].length<=(key==='reason'?1000:500)&&!/[\u0000-\u001f]/.test(input[key]),'售后字段不正确：'+key);
        body[key]=input[key].trim();
      }
      requireRule(['terminate','retain'].includes(body.membershipDisposition),'必须明确记录已批准的会员资格处理决定');
      requireRule(body.attestation==='externally_verified_refund_completed','仅可登记管理员已核实完成的外部退款');
      const completed=Date.parse(body.refundCompletedAt),timestamp=new Date(clock()).toISOString();
      requireRule(Number.isFinite(completed)&&new Date(completed).toISOString()===body.refundCompletedAt&&completed<=Date.parse(timestamp),'退款完成时间不正确');
      const hash=digest(JSON.stringify(body)),key=manualAftercareKey(id),saved=await one(c,'SELECT value FROM settings WHERE key=$1',[key]);
      if(saved){
        const record=parse(saved.value);
        requireRule(record?.version===1&&record.orderId===id&&record.requestHash===hash,'此订单已登记售后；一期不支持重复或追加退款记录',409);
        return {aftercare:await summaryInTransaction(c,id),replayed:true};
      }
      const order=await one(c,'SELECT * FROM orders WHERE id=$1 FOR UPDATE',[id]);
      requireRule(order,'找不到这笔订单',404);
      requireRule(order.status==='paid'&&['basic','star'].includes(order.plan_id)&&order.currency==='CNY'&&order.actual_paid_cents!==null,'仅支持已付款的基础或星级会员订单',409);
      const paid=safeInteger(order.actual_paid_cents);
      requireRule(paid>0&&paid===safeInteger(order.amount_cents)&&body.refundAmountCents<=paid&&completed>=Date.parse(order.paid_at),'退款金额或时间与原付款不一致',409);
      requireRule(!await one(c,"SELECT 1 FROM orders WHERE user_id=$1 AND id<>$2 AND status IN ('paid','pending','review')",[order.user_id,id]),'存在其他付款或办理中订单，需要人工核对，不更改会员资格',409);
      const transactions=await one(c,'SELECT to_regclass($1) AS name',[schema+'._club_order_transactions']);
      if(transactions.name){
        const transaction=await one(c,'SELECT kind FROM _club_order_transactions WHERE order_id=$1',[id]);
        requireRule(!transaction||transaction.kind==='first_purchase','一期人工售后仅支持首次购买订单',409);
      }
      const attempt=await one(c,'SELECT * FROM _club_virtual_payment_attempts WHERE order_id=$1',[id]);
      const receipt=parse(attempt?.receipt_json),binding=parse(attempt?.snapshot_json),query=parse(attempt?.last_query_json);
      requireRule(attempt&&attempt.user_id===order.user_id&&attempt.app_id===appId&&receipt&&binding&&query?.orderType===0,'仅支持已核实的安卓普通支付原单',409);
      const env=safeInteger(attempt.env);
      requireRule(env===expectedEnv&&receipt.appId===appId&&receipt.env===env&&receipt.orderId===id&&receipt.amountCents===paid&&receipt.paidAt===order.paid_at
        &&receipt.wxOrderId===attempt.provider_order_id&&receipt.openId===binding.openId&&receipt.productId===binding.productId
        &&binding.orderId===id&&binding.userId===order.user_id&&binding.planId===order.plan_id&&binding.amountCents===safeInteger(order.amount_cents)
        &&digest(attempt.receipt_json)===attempt.receipt_hash,'原始付款凭据与订单不一致',409);
      const receipts=(await c.query('SELECT * FROM payment_receipts WHERE order_id=$1',[id])).rows;
      requireRule(receipts.length===1&&receipts[0].transaction_id===`virtual:${appId}:${env}:${receipt.wxOrderId}`&&receipts[0].payload_hash===attempt.receipt_hash&&receipts[0].outcome==='activated','原始付款履约记录需核对',409);
      const member=await one(c,'SELECT * FROM memberships WHERE user_id=$1 FOR UPDATE',[order.user_id]);
      requireRule(member&&member.order_id===id&&member.plan_id===order.plan_id&&member.starts_at===order.paid_at&&member.expires_at===order.expires_at,'会员资格已变化，需要人工核对，不覆盖后续会员资格',409);
      const refundKey='manual_aftercare_refund:'+digest(appId+':'+env+':'+body.externalRefundId);
      requireRule(!await one(c,'SELECT 1 FROM settings WHERE key=$1',[refundKey]),'该外部退款编号已登记',409);
      const before=snapshot(member),expires=body.membershipDisposition==='terminate'&&member.expires_at>timestamp?timestamp:member.expires_at;
      if(expires!==member.expires_at)await c.query('UPDATE memberships SET expires_at=$1 WHERE user_id=$2',[expires,order.user_id]);
      // Invalidate any outstanding delivery lease in this same atomic write so
      // recovery or a late network response cannot restore the old paid attempt.
      await c.query("UPDATE _club_virtual_payment_attempts SET state='reconciliation',delivery_state='blocked',delivery_lease=NULL,updated_at=$1 WHERE order_id=$2",[timestamp,id]);
      const record={version:1,status:'completed',orderId:id,userId:order.user_id,appId,env,request:body,requestHash:hash,
        originalReceiptHash:attempt.receipt_hash,verificationSource:'authenticated_admin_attestation',actorId:actor.id,recordedAt:timestamp,
        membershipBefore:before,membershipAfter:{...before,expiresAt:expires}};
      await c.query('INSERT INTO settings(key,value) VALUES($1,$2)',[key,JSON.stringify(record)]);
      await c.query('INSERT INTO settings(key,value) VALUES($1,$2)',[refundKey,id]);
      await c.query('INSERT INTO audit_log(actor_id,action,target_id,detail,created_at) VALUES($1,$2,$3,$4,$5)',[actor.id,'aftercare.manual_completed',id,JSON.stringify(record),timestamp]);
      return {aftercare:await summaryInTransaction(c,id),replayed:false};
    })
  };
}
