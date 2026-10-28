import {readFileSync} from 'node:fs';
import {createHash,randomUUID} from 'node:crypto';
import {postgresTransaction,safeInteger} from './postgres.mjs';
import {requireRule,plans,yearAfter,digest} from './domain.mjs';
import {VirtualPaymentError} from './wechat-virtual-pay.mjs';
import {manualAftercareKey} from './postgres-manual-aftercare.mjs';

export const virtualPaymentTable='_club_virtual_payment_attempts';
export const virtualPaymentMigrationKey='virtual-payment-schema-v1';
const migration=readFileSync(new URL('./migrations/postgres/002-virtual-payment.sql',import.meta.url),'utf8');
const migrationHash=createHash('sha256').update(migration).digest('hex');
const migrationValue=JSON.stringify({version:1,sha256:migrationHash});
const marker=id=>'virtual_payment_attempt:'+id;
const schemaValid=schema=>/^club_migration_[a-z0-9_]{1,40}$/.test(schema||'');
const one=async(c,sql,args=[])=>(await c.query(sql,args)).rows[0];
const expectedColumns=['order_id:text','user_id:text','app_id:text','env:bigint','snapshot_json:text','issued_at:text',
  'provider_order_id:text','receipt_hash:text','receipt_json:text','state:text','delivery_state:text','delivery_lease:text',
  'last_query_json:text','next_check_at:text','retry_count:bigint','last_error_code:text','updated_at:text'].sort().join(',');

// Called by existing read-only baseline verifiers. An absent marker adds no tables;
// unmarked/partial tables still fail the original exact table-set comparison.
export async function virtualPaymentMigrationTables(client,schema){
  requireRule(schemaValid(schema),'虚拟支付数据区不正确',503);
  const saved=await one(client,'SELECT value FROM settings WHERE key=$1',[virtualPaymentMigrationKey]);
  if(!saved)return [];
  requireRule(saved.value===migrationValue,'虚拟支付迁移记录不一致',503);
  const columns=(await client.query('SELECT column_name,data_type FROM information_schema.columns WHERE table_schema=$1 AND table_name=$2 ORDER BY column_name',[schema,virtualPaymentTable])).rows;
  requireRule(columns.map(c=>c.column_name+':'+c.data_type).sort().join(',')===expectedColumns,'虚拟支付表结构不一致',503);
  return [virtualPaymentTable];
}
export async function initializeVirtualPaymentSchema(pool,{schema}){
  requireRule(schemaValid(schema),'需要显式指定虚拟支付升级数据区');
  return postgresTransaction(pool,async c=>{
    await c.query(`SET LOCAL search_path TO "${schema}"`);await c.query('LOCK TABLE settings IN SHARE ROW EXCLUSIVE MODE');
    if(await one(c,'SELECT 1 FROM settings WHERE key=$1',[virtualPaymentMigrationKey])){
      await virtualPaymentMigrationTables(c,schema);return {initialized:true,reused:true};
    }
    await c.query(migration);await c.query('INSERT INTO settings(key,value) VALUES($1,$2)',[virtualPaymentMigrationKey,migrationValue]);
    return {initialized:true,reused:false};
  });
}
export async function verifyVirtualPaymentSchema(pool,{schema}){
  return postgresTransaction(pool,async c=>{
    requireRule(schemaValid(schema),'虚拟支付数据区不正确',503);
    await c.query('SET TRANSACTION READ ONLY');await c.query(`SET LOCAL search_path TO "${schema}"`);
    requireRule((await virtualPaymentMigrationTables(c,schema)).length===1,'虚拟支付数据表尚未显式升级',503);
    return {verified:true};
  });
}

// All money/account writes follow the existing core users-table lock. External
// code2Session/query/delivery calls never happen inside a database transaction.
export function createPostgresVirtualPayment(pool,{schema,appId,legal,provider,wechat,core,rewards,renewals,grantPaymentConflict,clock=Date.now}={}){
  if(!provider?.configured)return Object.freeze({configured:false});
  requireRule(schemaValid(schema)&&provider.appId===appId&&wechat?.configured&&wechat.appId===appId
    &&typeof wechat.exchangePaymentCode==='function'&&legal?.status==='approved'&&core,'虚拟支付服务尚未完成配置',503);
  const now=()=>new Date(clock()).toISOString(),later=()=>new Date(clock()+30000).toISOString();
  const run=(fn,write=false)=>postgresTransaction(pool,async c=>{
    await c.query(`SET LOCAL search_path TO "${schema}"`);
    if(write)await c.query('LOCK TABLE users IN SHARE ROW EXCLUSIVE MODE');return fn(c);
  });
  const audit=(c,actor,action,target,detail={})=>c.query('INSERT INTO audit_log(actor_id,action,target_id,detail,created_at) VALUES($1,$2,$3,$4,$5)',[actor,action,target,JSON.stringify(detail),now()]);
  const errorCode=error=>/^[A-Z0-9_]{1,80}$/.test(error?.code||'')?error.code:'VIRTUAL_PAYMENT_UNCONFIRMED';
  async function checkAvailability(){
    let result;
    try{if(typeof provider.checkAvailability==='function')result=await provider.checkAvailability();}catch{}
    if(result?.available!==true)throw new VirtualPaymentError('虚拟支付接口凭证暂不可用，暂不发起付款；请稍后重试',503,'VIRTUAL_TOKEN_UNAVAILABLE');
    return {available:true};
  }
  async function context(c,user,id,pending=false){
    requireRule(user?.id&&await one(c,"SELECT 1 FROM users WHERE id=$1 AND role='member'",[user.id]),'需要当前会员账号',403);
    const row=await one(c,'SELECT * FROM orders WHERE id=$1 AND user_id=$2',[id,user.id]);requireRule(row,'找不到这笔订单',404);
    const identity=await one(c,'SELECT open_id FROM wechat_identities WHERE app_id=$1 AND user_id=$2',[appId,user.id]);
    requireRule(identity,'微信身份未关联',403);
    if(pending){
      requireRule(row.status==='pending'&&['basic','star'].includes(row.plan_id)&&safeInteger(row.amount_cents)===plans[row.plan_id].amountCents&&row.currency==='CNY','当前订单不能付款',409);
      requireRule(!await one(c,"SELECT 1 FROM payment_receipts r JOIN orders o ON o.id=r.order_id WHERE o.user_id=$1 AND r.outcome='needs_reconciliation'",[user.id]),'已有到账记录待人工核对，请先联系客服，暂不重复付款',409);
      if(renewals)await renewals.assertPayableInTransaction(c,row);
      else requireRule(!await one(c,'SELECT 1 FROM memberships WHERE user_id=$1',[user.id]),'已有会籍，请核对现有会员订单',409);
      const accepted=await one(c,"SELECT details_confirmed FROM legal_consents WHERE user_id=$1 AND scope='payment' AND target_id=$2 AND release_id=$3",[user.id,id,legal.id]);
      requireRule(accepted&&safeInteger(accepted.details_confirmed)===1,'请先确认订单资料与当前协议',409);
      requireRule(!await one(c,"SELECT 1 FROM manual_payments WHERE order_id=$1 AND status IN ('pending','confirmed')",[id]),'已有人工付款记录，请勿重复付款',409);
      requireRule(!await one(c,'SELECT 1 FROM settings WHERE key=$1',['wechat_payment_attempt:'+id]),'已有其他支付渠道的尝试，请先核对结果',409);
    }
    return {row,identity:{appId,userId:user.id,openId:identity.open_id}};
  }
  async function readAttempt(user,id){return run(async c=>{
    const {row,identity}=await context(c,user,id),saved=await one(c,`SELECT * FROM ${virtualPaymentTable} WHERE order_id=$1`,[id]);
    if(!saved)return {row,identity};
    let attempt;try{attempt=JSON.parse(saved.snapshot_json);}catch{requireRule(false,'虚拟支付记录需核对',409);}
    requireRule(saved.user_id===user.id&&saved.app_id===appId&&safeInteger(saved.env)===provider.env
      &&attempt.orderId===id&&attempt.userId===user.id&&attempt.openId===identity.openId
      &&attempt.planId===row.plan_id&&attempt.amountCents===safeInteger(row.amount_cents),'虚拟支付记录归属或金额不一致',409);
    return {row,identity,saved,attempt};
  });}
  async function persistQuery(user,id,attempt,state){return run(async c=>{
    const {row,identity}=await context(c,user,id),saved=await one(c,`SELECT * FROM ${virtualPaymentTable} WHERE order_id=$1`,[id]);
    requireRule(saved&&saved.snapshot_json===JSON.stringify(attempt)&&identity.openId===attempt.openId,'支付记录或身份已变化',409);
    if(await one(c,'SELECT 1 FROM settings WHERE key=$1',[manualAftercareKey(id)]))return state;
    requireRule(state.orderId===id&&state.env===provider.env&&state.orderFeeCents===safeInteger(row.amount_cents),'支付结果与订单不一致',409);
    await c.query(`UPDATE ${virtualPaymentTable} SET last_query_json=$1,next_check_at=CASE WHEN delivery_state='processing' THEN next_check_at ELSE $2 END,last_error_code=NULL,updated_at=$3 WHERE order_id=$4`,[JSON.stringify(state),later(),now(),id]);
    if(!state.fulfillable){
      if(state.status===6&&!saved.receipt_hash){
        await c.query(`UPDATE ${virtualPaymentTable} SET state='closed',delivery_state='blocked' WHERE order_id=$1`,[id]);
        await c.query('UPDATE settings SET value=$1 WHERE key=$2',['closed',marker(id)]);
      }else if(saved.receipt_hash||[5,7,8].includes(state.status)){
        await c.query(`UPDATE ${virtualPaymentTable} SET state='reconciliation',delivery_state='blocked',delivery_lease=NULL WHERE order_id=$1`,[id]);
        if(saved.state!=='reconciliation')await audit(c,null,'payment.virtual_reconciliation',id,{status:state.status,leftFeeCents:state.leftFeeCents});
      }
      return state;
    }
    requireRule([2,3,4].includes(state.status)&&[0,7].includes(state.orderType)&&state.paidFeeCents===attempt.amountCents
      &&state.leftFeeCents===attempt.amountCents&&typeof state.wxOrderId==='string'&&Number.isSafeInteger(state.paidTimeSeconds),'虚拟支付付款状态未核实',409);
    const paidAt=new Date(state.paidTimeSeconds*1000).toISOString();
    const receipt={appId,env:provider.env,offerId:provider.offerId,orderId:id,openId:identity.openId,productId:attempt.productId,
      amountCents:state.paidFeeCents,paidAt,wxOrderId:state.wxOrderId};
    const receiptHash=digest(JSON.stringify(receipt)),transactionId=`virtual:${appId}:${provider.env}:${state.wxOrderId}`;
    if(saved.receipt_hash)requireRule(saved.receipt_hash===receiptHash,'重复虚拟支付流水不一致',409);
    const previous=await one(c,'SELECT * FROM payment_receipts WHERE transaction_id=$1',[transactionId]);
    if(previous)requireRule(previous.order_id===id&&previous.payload_hash===receiptHash,'虚拟支付流水已用于其他订单',409);
    let outcome=previous?.outcome;
    if(!previous){
      const member=await one(c,'SELECT * FROM memberships WHERE user_id=$1',[user.id]);
      const renewal=renewals?await renewals.fulfillmentInTransaction(c,row,paidAt):null;
      outcome=renewal?.outcome??(row.status==='pending'&&!member?'activated':'needs_reconciliation');
      if(outcome==='activated'&&grantPaymentConflict&&await grantPaymentConflict(c,user.id,{startsAt:renewal?.startsAt??paidAt,expiresAt:renewal?.expiresAt??yearAfter(paidAt)}))outcome='needs_reconciliation';
      if(outcome==='activated'){
        const expires=renewal?.expiresAt??yearAfter(paidAt);
        await c.query("UPDATE orders SET status='paid',actual_paid_cents=$1,paid_at=$2,expires_at=$3 WHERE id=$4",[state.paidFeeCents,paidAt,expires,id]);
        if(renewal)await c.query('UPDATE memberships SET order_id=$1,starts_at=$2,expires_at=$3 WHERE user_id=$4',[id,renewal.startsAt,expires,user.id]);
        else await c.query('INSERT INTO memberships(user_id,order_id,plan_id,starts_at,expires_at) VALUES($1,$2,$3,$4,$5)',[user.id,id,row.plan_id,paidAt,expires]);
        if(renewals)await renewals.commitFulfillmentInTransaction(c,row,paidAt,expires);
        await c.query('UPDATE users SET referrer_id=$1,referral_source=$2,referral_locked_at=$3 WHERE id=$4',[row.referrer_id,row.referral_source,now(),user.id]);
      }
      await c.query('INSERT INTO payment_receipts(transaction_id,order_id,payload_hash,received_at,outcome) VALUES($1,$2,$3,$4,$5)',[transactionId,id,receiptHash,now(),outcome]);
      if(outcome==='activated'&&rewards?.recordPaidOrderInTransaction)await rewards.recordPaidOrderInTransaction(c,id);
      await audit(c,null,'payment.'+outcome,id,{paymentChannel:'virtual',amountCents:state.paidFeeCents});
    }
    // A later legitimate renewal replaces memberships.order_id. The original
    // atomic paid receipt remains proof that this purchase was fulfilled once.
    const active=outcome==='activated'&&!!await one(c,"SELECT 1 FROM orders WHERE id=$1 AND user_id=$2 AND status='paid'",[id,user.id]);
    const delivery=active?(state.delivered||saved.delivery_state==='confirmed'?'confirmed':saved.delivery_state==='processing'?'processing':'pending'):'blocked';
    await c.query(`UPDATE ${virtualPaymentTable} SET provider_order_id=$1,receipt_hash=$2,receipt_json=$3,state=$4,delivery_state=$5,updated_at=$6 WHERE order_id=$7`,
      [state.wxOrderId,receiptHash,JSON.stringify(receipt),active?(delivery==='confirmed'?'delivered':'paid'):'reconciliation',delivery,now(),id]);
    return state;
  },true);}
  async function deliver(user,id,attempt,identity){
    const lease=randomUUID();
    const claimed=await run(async c=>{
      if(await one(c,'SELECT 1 FROM settings WHERE key=$1',[manualAftercareKey(id)]))return false;
      const saved=await one(c,`SELECT * FROM ${virtualPaymentTable} WHERE order_id=$1`,[id]);
      if(saved?.state!=='paid'||!(saved.delivery_state==='pending'||(saved.delivery_state==='processing'&&saved.next_check_at<=now())))return false;
      requireRule(!!await one(c,"SELECT 1 FROM orders o JOIN payment_receipts r ON r.order_id=o.id WHERE o.id=$1 AND o.user_id=$2 AND o.status='paid' AND r.outcome='activated'",[id,user.id]),'会籍付款履约尚未持久化',409);
      await c.query(`UPDATE ${virtualPaymentTable} SET delivery_state='processing',delivery_lease=$1,next_check_at=$2,retry_count=retry_count+1 WHERE order_id=$3`,[lease,later(),id]);return true;
    },true);
    if(!claimed)return;
    let result,error;
    try{result=await provider.confirmDelivery(attempt,identity,{fulfillmentCommitted:true});}catch(value){error=value;}
    await run(async c=>{
      const saved=await one(c,`SELECT * FROM ${virtualPaymentTable} WHERE order_id=$1`,[id]);
      if(saved?.delivery_state!=='processing'||saved.delivery_lease!==lease)return;
      const confirmed=result?.confirmed===true;
      await c.query(`UPDATE ${virtualPaymentTable} SET state=$1,delivery_state=$2,delivery_lease=NULL,next_check_at=$3,last_error_code=$4,updated_at=$5 WHERE order_id=$6`,
        [confirmed?'delivered':'paid',confirmed?'confirmed':'pending',later(),error?errorCode(error):confirmed?null:'VIRTUAL_DELIVERY_PENDING',now(),id]);
      if(confirmed)await audit(c,null,'payment.virtual_delivered',id);
    },true);
  }
  const inFlight=new Map();let timer;
  const service={
    configured:true,appId,paymentChannel:'virtual',env:provider.env,
    checkAvailability,
    async prepare(user,id,input){
      requireRule(input&&Object.keys(input).length===1&&typeof input.code==='string'&&input.code.length>0&&input.code.length<=512&&!/\s/.test(input.code),'需要新的微信支付登录凭证');
      const initial=await run(c=>context(c,user,id,true));
      // No network work inside PG transactions. Recheck current order/identity
      // below after availability and code exchange before signing or persisting.
      await checkAvailability();
      let exchanged=await wechat.exchangePaymentCode(input.code);
      requireRule(exchanged.appId===appId&&exchanged.openId===initial.identity.openId,'付款微信身份与当前登录账号不一致',403);
      // sessionKey is not placed in settings, attempt JSON, logs or the HTTP response.
      try{return await run(async c=>{
        const current=await context(c,user,id,true);
        requireRule(current.identity.openId===exchanged.openId,'付款微信身份已变化',403);
        requireRule(!await one(c,`SELECT 1 FROM ${virtualPaymentTable} WHERE order_id=$1`,[id])
          &&!await one(c,'SELECT 1 FROM settings WHERE key=$1',[marker(id)]),'已有支付尝试，请刷新查单；不要重复发起付款',409);
        const row=current.row;
        const prepared=provider.prepare({id,userId:user.id,planId:row.plan_id,amountCents:safeInteger(row.amount_cents),currency:row.currency,createdAt:row.created_at,status:row.status},
          {...current.identity,sessionKey:exchanged.sessionKey});
        await c.query(`INSERT INTO ${virtualPaymentTable}(order_id,user_id,app_id,env,snapshot_json,issued_at,state,delivery_state,next_check_at,updated_at) VALUES($1,$2,$3,$4,$5,$6,'issued','waiting',$7,$6)`,
          [id,user.id,appId,provider.env,JSON.stringify(prepared.attempt),now(),later()]);
        await c.query('INSERT INTO settings(key,value) VALUES($1,$2)',[marker(id),'issued']);
        await audit(c,user.id,'payment.virtual_prepared',id,{env:provider.env,planId:row.plan_id});
        return {paymentChannel:'virtual',payment:prepared.payment};
      },true);}finally{exchanged=undefined;}
    },
    async sync(user,id){
      const context=await readAttempt(user,id);if(!context.saved)return null;
      if(await run(c=>one(c,'SELECT 1 FROM settings WHERE key=$1',[manualAftercareKey(id)])))return null;
      if(inFlight.has(id))return inFlight.get(id);
      const pending=(async()=>{
        const state=await provider.query(context.attempt,context.identity);
        await persistQuery(user,id,context.attempt,state);
        if(state.fulfillable)await deliver(user,id,context.attempt,context.identity);
        return state;
      })();
      inFlight.set(id,pending);try{return await pending;}finally{inFlight.delete(id);}
    },
    async cancel(user,id){
      const before=await readAttempt(user,id);
      if(before.row.status==='cancelled')return core.order(user,id);
      if(!before.saved)return core.cancelOrder(user,id);
      const state=await service.sync(user,id);
      requireRule(state&&[0,1,6].includes(state.status),'支付结果未确认可取消，请刷新；已付款订单需走售后',409);
      await run(async c=>{
        const {row}=await context(c,user,id),saved=await one(c,`SELECT * FROM ${virtualPaymentTable} WHERE order_id=$1`,[id]);
        requireRule(saved&&!saved.receipt_hash&&(state.status===6?saved.state==='closed':saved.state==='issued')&&['pending','cancelled'].includes(row.status),'订单状态已变化，请刷新',409);
        requireRule(!await one(c,'SELECT 1 FROM settings WHERE key=$1',[manualAftercareKey(id)]),'订单已办理售后',409);
        if(row.status!=='cancelled'){
          await c.query("UPDATE orders SET status='cancelled' WHERE id=$1",[id]);
          // This closes the local application only. Keep the issued attempt for
          // recovery; any late real payment becomes needs_reconciliation.
          if(state.status!==6)await c.query('INSERT INTO settings(key,value) VALUES($1,$2) ON CONFLICT(key) DO NOTHING',['virtual_application_cancelled:'+id,'local']);
          await audit(c,user.id,'order.cancelled',id,{paymentChannel:'virtual',authoritativeStatus:state.status,localOnly:state.status!==6});
        }
      },true);
      return core.order(user,id);
    },
    async recover({limit=10}={}){
      requireRule(Number.isInteger(limit)&&limit>0&&limit<=50,'恢复批次不正确');
      const due=await run(async c=>(await c.query(`SELECT a.order_id,u.* FROM ${virtualPaymentTable} a JOIN users u ON u.id=a.user_id WHERE a.state IN ('issued','paid') AND a.next_check_at<=$1 ORDER BY a.next_check_at,a.order_id LIMIT $2`,[now(),limit])).rows);
      for(const row of due){
        try{await service.sync(row,row.order_id);}catch(error){
          await run(c=>c.query(`UPDATE ${virtualPaymentTable} SET next_check_at=$1,last_error_code=$2,updated_at=$3 WHERE order_id=$4`,[later(),errorCode(error),now(),row.order_id]),true);
        }
      }
      return {checked:due.length};
    },
    startRecovery(){
      if(timer)return;timer=setInterval(()=>{service.recover().catch(()=>{});},30000);timer.unref();
      service.recover().catch(()=>{});
    },
    stopRecovery(){if(timer)clearInterval(timer);timer=undefined;}
  };
  return Object.freeze(service);
}
