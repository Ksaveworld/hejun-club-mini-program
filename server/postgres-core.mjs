import {randomBytes,randomUUID,timingSafeEqual} from 'node:crypto';
import {postgresTransaction,safeInteger} from './postgres.mjs';
import {requireRule,nowISO,digest,hashPassword,checkPassword,validateCredentials,prepareOrder,prepareOrderReview,plans,yearAfter,textField} from './domain.mjs';
import {prepareAuditQuery,auditRecord} from './audit-query.mjs';
import {manualAftercareSummaryInTransaction} from './postgres-manual-aftercare.mjs';
import {isOperationalAccount} from './collaboration/grant-identity.mjs';

// Public consumer projection only: never expose the resolver's raw paid row,
// audit/approval fields, or manufacture a paid order for a gifted entitlement.
function publicEntitlementView(value){
  requireRule(value&&typeof value.active==='boolean'&&Array.isArray(value.planIds)&&Array.isArray(value.sources)&&Array.isArray(value.byPlan),'会员权益暂时不可读取',503);
  const sourceId=s=>({source:s.source,id:s.id});
  const plan=p=>({planId:p.planId,active:p.active,startsAt:p.startsAt,expiresAt:p.expiresAt,sourceIds:p.sourceIds.map(sourceId)});
  const effectiveEntitlements={active:value.active,planIds:[...value.planIds],evaluatedAt:value.evaluatedAt,
    sources:value.sources.map(s=>({...sourceId(s),planId:s.planId,startsAt:s.startsAt,expiresAt:s.expiresAt})),byPlan:value.byPlan.map(plan),paidActive:value.paidActive===true};
  return {effectiveEntitlements,displayMembership:value.displayMembership?plan(value.displayMembership):null};
}

// Core writes serialize on users during the migration phase. All account/order/payment
// operations share one connection, one schema and one transaction; no SQLite fallback.
export function createPostgresCore(pool,{schema,appId,legal=null,rewards,renewals,entitlementResolver,grantPaymentConflict}={}){
  requireRule(/^club_migration_[a-z0-9_]{1,40}$/.test(schema||''),'需要指定迁移隔离区');
  requireRule(/^wx[a-f0-9]{16}$/.test(appId||''),'需要正确的小程序AppID');
  requireRule(entitlementResolver===undefined||typeof entitlementResolver==='function','会员权益解析器配置不正确',503);
  requireRule(grantPaymentConflict===undefined||typeof grantPaymentConflict==='function','赠送与付款协调配置不正确',503);
  const run=(fn,write=false)=>postgresTransaction(pool,async client=>{
    await client.query(`SET LOCAL search_path TO "${schema}"`);
    if(write)await client.query('LOCK TABLE users IN SHARE ROW EXCLUSIVE MODE');
    return fn(client);
  });
  const one=async(c,sql,args=[]) => (await c.query(sql,args)).rows[0];
  const audit=(c,actor,action,target,detail={})=>c.query('INSERT INTO audit_log(actor_id,action,target_id,detail,created_at) VALUES($1,$2,$3,$4,$5)',[actor,action,target,JSON.stringify(detail),nowISO()]);
  async function editor(c,actor){requireRule(actor?.role==='admin'&&await one(c,"SELECT 1 FROM users WHERE id=$1 AND role='admin'",[actor.id]),'需要管理员权限',403);}
  async function publicUser(c,user){
    const ref=user.referrer_id?await one(c,'SELECT referral_code FROM users WHERE id=$1',[user.referrer_id]):null;
    return {id:user.id,username:user.username,role:user.role,referralCode:user.referral_code,sourceCode:ref?.referral_code??null,referralSource:user.referral_source,referralLockedAt:user.referral_locked_at,phoneVerified:false};
  }
  async function member(c,id,now=nowISO()){
    const row=await one(c,'SELECT * FROM memberships WHERE user_id=$1',[id]);
    return row?{planId:row.plan_id,orderId:row.order_id,startsAt:row.starts_at,expiresAt:row.expires_at,active:row.starts_at<=now&&row.expires_at>now}:null;
  }
  async function consumption(c,user,now){
    if(!entitlementResolver)return {};
    requireRule(user?.role==='member'&&await one(c,"SELECT 1 FROM users WHERE id=$1 AND role='member'",[user.id])&&!await isOperationalAccount(c,user.id),'请使用当前消费会员账号',403);
    return publicEntitlementView(await entitlementResolver(c,user.id,now));
  }
  const orderNeedsPaymentReconciliation=(c,orderId)=>one(c,"SELECT 1 FROM payment_receipts WHERE order_id=$1 AND outcome='needs_reconciliation'",[orderId]);
  const needsPaymentReconciliation=(c,userId)=>one(c,"SELECT 1 FROM payment_receipts p JOIN orders o ON o.id=p.order_id WHERE o.user_id=$1 AND p.outcome='needs_reconciliation' LIMIT 1",[userId]);
  async function orderView(c,row){
    const aftercare=await manualAftercareSummaryInTransaction(c,row.id);
    const paymentAttempted=!!await one(c,'SELECT 1 FROM settings WHERE key=$1',['virtual_payment_attempt:'+row.id]);
    const locallyCancelled=!!await one(c,'SELECT 1 FROM settings WHERE key=$1 AND value=$2',['virtual_application_cancelled:'+row.id,'local']);
    const paymentReconciliationRequired=!!await orderNeedsPaymentReconciliation(c,row.id);
    const cancellation=locallyCancelled?{localOnly:true,paymentReconciliationRequired}:null;
    const ref=row.referrer_id?await one(c,'SELECT referral_code FROM users WHERE id=$1',[row.referrer_id]):null;
    return {id:row.id,userId:row.user_id,planId:row.plan_id,amountCents:safeInteger(row.amount_cents),actualPaidCents:row.actual_paid_cents===null?null:safeInteger(row.actual_paid_cents),currency:row.currency,status:row.status,form:JSON.parse(row.profile_json),createdAt:row.created_at,paidAt:row.paid_at,expiresAt:row.expires_at,reviewNote:row.review_note,reviewedAt:row.reviewed_at,sourceCode:ref?.referral_code??null,referralSource:row.referral_source,registrationOnly:plans[row.plan_id]?.registrationOnly===true,
      aftercare,paymentAttempted,paymentReconciliationRequired,cancellation,...(renewals?await renewals.orderInfoInTransaction(c,row):{transactionKind:'first_purchase'})};
  }
  async function owned(c,user,id){const row=await one(c,'SELECT * FROM orders WHERE id=$1 AND user_id=$2',[id,user.id]);requireRule(row,'找不到这笔订单',404);return row;}
  function requireConsent(body){
    if(!legal)return;
    requireRule(legal.status==='approved'&&body?.accepted===true&&body.releaseId===legal.id&&(!legal.requireHongKongConsent||body.hongKongAccepted===true),'请阅读当前协议并确认适用的存储安排',409);
  }
  async function recordConsent(c,userId,scope,targetId,body){
    if(!legal)return;requireConsent(body);
    requireRule(Array.isArray(legal.documents)&&legal.documents.length>=2&&legal.documents.every(d=>d.id&&d.version&&/^[a-f0-9]{64}$/.test(d.sha256)),'协议文件配置不完整',503);
    const snapshot=JSON.stringify([...legal.documents].sort((a,b)=>a.id.localeCompare(b.id)).map(({id,version,sha256})=>({id,version,sha256})));
    const previous=await one(c,'SELECT documents_json FROM legal_consents WHERE user_id=$1 AND scope=$2 AND target_id=$3 AND release_id=$4',[userId,scope,targetId,legal.id]);
    if(previous){requireRule(previous.documents_json===snapshot,'同一协议版本内容已变化',409);return;}
    await c.query('INSERT INTO legal_consents(id,user_id,scope,target_id,release_id,documents_json,accepted_at,hong_kong_accepted,details_confirmed) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9)',[randomUUID(),userId,scope,targetId,legal.id,snapshot,nowISO(),body.hongKongAccepted===true?1:0,body.detailsConfirmed===true?1:0]);
  }
  async function referral(c,user,code=''){
    const normalized=textField(code,'推荐码',6).toUpperCase();
    if(user.referral_locked_at||user.referral_source==='explicit')return;
    const fallback=(await one(c,"SELECT value FROM settings WHERE key='default_referral_code'"))?.value;
    const candidate=normalized||(!user.referrer_id?fallback:null);if(!candidate)return;
    requireRule(/^[A-Z0-9]{6}$/.test(candidate),'推荐码应为6位字母或数字');
    const owner=await one(c,"SELECT * FROM users WHERE referral_code=$1 AND role='member'",[candidate]);requireRule(owner,'推荐码无效');
    if(!normalized&&owner.id===user.id)return;
    const seen=new Set([user.id]);let ancestor=owner;
    while(ancestor){requireRule(!seen.has(ancestor.id),'该推荐关系存在循环');seen.add(ancestor.id);ancestor=ancestor.referrer_id?await one(c,'SELECT * FROM users WHERE id=$1',[ancestor.referrer_id]):null;}
    const source=normalized?'explicit':'default';
    await c.query('UPDATE users SET referrer_id=$1,referral_source=$2,referral_at=$3 WHERE id=$4',[owner.id,source,nowISO(),user.id]);
    await audit(c,user.id,'referral.captured',user.id,{source,referrerId:owner.id});
  }
  async function session(c,user){
    const token=randomBytes(32).toString('hex'),expiresAt=new Date(Date.now()+12*3600000).toISOString();
    await c.query('DELETE FROM native_sessions WHERE expires_at<=$1',[nowISO()]);
    await c.query('INSERT INTO native_sessions VALUES($1,$2,$3,$4)',[digest(token),user.id,expiresAt,'wechat']);
    return {user:await publicUser(c,user),accessToken:token,tokenType:'Bearer',expiresAt,authMode:'wechat'};
  }
  const proofKey=id=>'native_account_transfer:'+id;
  const paymentKey=id=>'wechat_payment_attempt:'+id;
  const core={
    storage:'postgres',appId,legal,
    async login(body,adapter){
      requireRule(adapter?.configured&&adapter.appId===appId,'微信登录尚未配置',503);
      requireRule(body.consent===true,'请同意资料保存说明');requireConsent(body.legalConsent);
      requireRule(!(body.existingAccount&&body.transferCode),'不能混用两种接续方式');
      let legacy;
      if(body.existingAccount){
        const username=validateCredentials(body.existingAccount);
        legacy=await run(c=>one(c,'SELECT * FROM users WHERE username=$1',[username]));
        const valid=await checkPassword(body.existingAccount.password,legacy?.password_hash??await hashPassword(randomBytes(32).toString('hex')));
        requireRule(legacy?.role==='member'&&valid,'原会员账号或密码不正确',401);
      }
      requireRule(typeof body.code==='string'&&body.code.length>0&&body.code.length<=512&&!/\s/.test(body.code),'微信登录凭证不正确');
      const identity=await adapter.exchangeCode(body.code);
      requireRule(identity?.appId===appId&&/^[A-Za-z0-9_-]{1,128}$/.test(identity.openId||''),'微信身份返回异常',503);
      const randomHash=await hashPassword(randomBytes(64).toString('hex'));
      return run(async c=>{
        let user;
        const linked=await one(c,'SELECT user_id FROM wechat_identities WHERE app_id=$1 AND open_id=$2',[appId,identity.openId]);
        if(body.transferCode!==undefined){
          requireRule(typeof body.transferCode==='string'&&/^[a-f0-9-]{36}\.[A-Za-z0-9_-]{32}$/.test(body.transferCode),'接续码无效或已过期',401);
          const [id,proof]=body.transferCode.split('.');const saved=await one(c,'SELECT value FROM settings WHERE key=$1',[proofKey(id)]);
          let record;try{record=JSON.parse(saved?.value??'null');}catch{}
          requireRule(record?.appId===appId&&record.expiresAt>nowISO()&&/^[a-f0-9]{64}$/.test(record.hash)&&timingSafeEqual(Buffer.from(record.hash,'hex'),Buffer.from(digest(proof),'hex')),'接续码无效或已过期',401);
          user=await one(c,"SELECT * FROM users WHERE id=$1 AND role='member'",[id]);requireRule(user,'原账号不可用',409);
          await c.query('DELETE FROM settings WHERE key=$1',[proofKey(id)]);
          await audit(c,user.id,'account.native_transfer_consumed',user.id,{appId});
        }else if(legacy){
          user=await one(c,'SELECT * FROM users WHERE id=$1',[legacy.id]);requireRule(user?.role==='member'&&user.password_hash===legacy.password_hash,'原账号状态已变化',409);
        }else if(linked)user=await one(c,'SELECT * FROM users WHERE id=$1',[linked.user_id]);
        if(user){
          requireRule(user.role==='member','小程序登录仅供会员使用',403);
          const other=await one(c,'SELECT open_id FROM wechat_identities WHERE app_id=$1 AND user_id=$2',[appId,user.id]);
          requireRule((!linked||linked.user_id===user.id)&&(!other||other.open_id===identity.openId),'微信或原账号已有其他关联，不能自动合并',409);
        }else{
          let ref;do{ref=randomBytes(3).toString('hex').toUpperCase();}while(await one(c,'SELECT 1 FROM users WHERE referral_code=$1',[ref]));
          user=await one(c,'INSERT INTO users(id,username,password_hash,role,created_at,referral_code,consent_version) VALUES($1,$2,$3,$4,$5,$6,$7) RETURNING *',[randomUUID(),'wx_'+randomBytes(14).toString('hex'),randomHash,'member',nowISO(),ref,legal?.id??'local-trial-v1']);
          await audit(c,user.id,'account.wechat_registered',user.id);
        }
        if(!linked){await c.query('INSERT INTO wechat_identities VALUES($1,$2,$3,$4)',[appId,identity.openId,user.id,nowISO()]);await audit(c,user.id,'account.native_wechat_linked',user.id,{appId});}
        if(!legacy&&!body.transferCode&&!await one(c,"SELECT 1 FROM orders WHERE user_id=$1 AND status IN ('pending','review')",[user.id]))await referral(c,user,body.referral??'');
        await recordConsent(c,user.id,'registration',user.id,body.legalConsent);
        return session(c,await one(c,'SELECT * FROM users WHERE id=$1',[user.id]));
      },true);
    },
    async authenticate(token){
      requireRule(typeof token==='string'&&/^[a-f0-9]{64}$/.test(token),'请重新登录',401);
      return run(async c=>{const user=await one(c,"SELECT u.* FROM native_sessions s JOIN users u ON u.id=s.user_id WHERE s.token_hash=$1 AND s.expires_at>$2 AND s.auth_mode='wechat' AND u.role='member'",[digest(token),nowISO()]);requireRule(user,'登录已失效，请重新登录',401);if(entitlementResolver)requireRule(!await isOperationalAccount(c,user.id),'请使用消费会员账号',403);return user;});
    },
    logout:token=>run(c=>c.query('DELETE FROM native_sessions WHERE token_hash=$1',[digest(token)]),true),
    captureReferral:(user,body)=>run(async c=>{
      requireRule(user?.role==='member','需要会员账号',403);
      requireRule(!await one(c,"SELECT 1 FROM orders WHERE user_id=$1 AND status IN ('review','pending')",[user.id]),'订单已保存推荐来源，请先处理现有订单',409);
      const current=await one(c,'SELECT * FROM users WHERE id=$1',[user.id]);requireRule(current,'请重新登录',401);
      await referral(c,current,body.code??'');
      return publicUser(c,await one(c,'SELECT * FROM users WHERE id=$1',[user.id]));
    },true),
    me:user=>run(async c=>{
      if(entitlementResolver)await c.query('SET TRANSACTION ISOLATION LEVEL REPEATABLE READ READ ONLY');
      const now=nowISO(),view=await consumption(c,user,now);
      return {user:await publicUser(c,user),membership:await member(c,user.id,now),...view,defaultReferralConfigured:!!await one(c,"SELECT 1 FROM settings WHERE key='default_referral_code'"),renewals:renewals?await renewals.statusInTransaction(c,user.id):{enabled:false,canRenew:false,reason:'同档续费配置尚未启用，暂未开放'}};
    }),
    listOrders:user=>run(async c=>{const {rows}=await c.query('SELECT * FROM orders WHERE user_id=$1 ORDER BY created_at DESC',[user.id]);return Promise.all(rows.map(row=>orderView(c,row)));}),
    managedOrders:actor=>run(async c=>{await c.query('SET TRANSACTION ISOLATION LEVEL REPEATABLE READ READ ONLY');await editor(c,actor);return Promise.all((await c.query('SELECT * FROM orders ORDER BY created_at DESC,id')).rows.map(row=>orderView(c,row)));}),
    managedMembers:actor=>run(async c=>{
      await c.query('SET TRANSACTION ISOLATION LEVEL REPEATABLE READ READ ONLY');await editor(c,actor);
      const rows=(await c.query("SELECT * FROM users WHERE role='member' ORDER BY created_at DESC,id")).rows,now=nowISO(),results=[];
      for(const row of rows){
        if(entitlementResolver&&await isOperationalAccount(c,row.id))continue;
        results.push({...await publicUser(c,row),membership:await member(c,row.id,now),...await consumption(c,row,now)});
      }
      return results;
    }),
    reviewOrder:(actor,id,body)=>run(async c=>{
      await editor(c,actor);const {decision,note}=prepareOrderReview(body),row=await one(c,'SELECT * FROM orders WHERE id=$1 FOR UPDATE',[id]);
      requireRule(row,'申请不存在',404);requireRule(row.plan_id==='organization'&&row.status==='review','申请已处理，请刷新查看',409);
      await c.query('UPDATE orders SET status=$1,reviewed_by=$2,reviewed_at=$3,review_note=$4 WHERE id=$5',[decision==='approve'?(plans[row.plan_id].registrationOnly?'review':'pending'):'rejected',actor.id,nowISO(),note,id]);
      await audit(c,actor.id,'application.'+decision,id,{note});return orderView(c,await one(c,'SELECT * FROM orders WHERE id=$1',[id]));
    },true),
    managedAudit:(actor,params)=>run(async c=>{
      await c.query('SET TRANSACTION ISOLATION LEVEL REPEATABLE READ READ ONLY');await editor(c,actor);
      const {group,target,before}=prepareAuditQuery(params),conditions=[],values=[];
      if(group!=='all'){values.push(group+'.%');conditions.push(`a.action LIKE $${values.length}`);}
      if(target){values.push(target);conditions.push(`a.target_id=$${values.length}`);}
      if(before){values.push(Number(before));conditions.push(`a.id<$${values.length}`);}
      const rows=(await c.query(`SELECT a.id,a.action,a.target_id,a.created_at,a.detail,a.actor_id,u.username FROM audit_log a LEFT JOIN users u ON u.id=a.actor_id ${conditions.length?'WHERE '+conditions.join(' AND '):''} ORDER BY a.id DESC LIMIT 31`,values)).rows;
      const visible=rows.slice(0,30).map(row=>({...row,id:safeInteger(row.id)}));return {records:visible.map(auditRecord),nextCursor:rows.length>30?String(visible.at(-1).id):null};
    }),
    order:(user,id)=>run(async c=>orderView(c,await owned(c,user,id))),
    async createOrder(user,body,key){
      const prepared=prepareOrder(body,key),{plan,form,referral:code}=prepared;requireConsent(body.legalConsent);
      const kind=body.transactionKind??'first_purchase';requireRule(['first_purchase','renewal'].includes(kind),'交易类型无效');
      if(kind==='renewal')requireRule(Object.keys(body).every(field=>['planId','form','consent','legalConsent','transactionKind'].includes(field)),'续费请求不能指定金额、期限或会籍');
      const requestHash=kind==='first_purchase'?prepared.requestHash:digest(JSON.stringify({requestHash:prepared.requestHash,transactionKind:kind}));
      return run(async c=>{
        requireRule(await one(c,"SELECT 1 FROM users WHERE id=$1 AND role='member'",[user.id]),'请使用当前会员账号',403);
        const previous=await one(c,'SELECT * FROM orders WHERE user_id=$1 AND idempotency_key=$2',[user.id,key]);
        if(previous){requireRule(previous.request_hash===requestHash,'提交编号已用于其他内容',409);return orderView(c,previous);}
        requireRule(!await needsPaymentReconciliation(c,user.id),'已有付款待核对，请保留原订单，勿重复下单或付款',409);
        const membership=await one(c,'SELECT * FROM memberships WHERE user_id=$1 FOR UPDATE',[user.id]);
        if(kind==='renewal'){
          requireRule(renewals,'同档续费尚未开放',503);const readiness=await renewals.statusInTransaction(c,user.id);
          requireRule(readiness.enabled&&readiness.canRenew&&membership?.plan_id===plan.id&&['basic','star'].includes(plan.id),'同档续费尚未开放或方案与当前会籍不一致',409);
        }else requireRule(plan.registrationOnly||!membership,'已有会员记录，续费和升级尚未开放',409);
        requireRule(!await one(c,"SELECT 1 FROM orders WHERE user_id=$1 AND status IN ('pending','review')",[user.id]),'你已有待处理订单',409);
        const latest=await one(c,'SELECT * FROM users WHERE id=$1',[user.id]);if(kind==='first_purchase')await referral(c,latest,code);else requireRule(!code,'续费沿用原推荐来源，不接受修改来源');
        const current=await one(c,'SELECT * FROM users WHERE id=$1',[user.id]),id='HJ'+randomUUID().replaceAll('-','').toUpperCase();
        const row=await one(c,'INSERT INTO orders(id,user_id,plan_id,amount_cents,status,profile_json,created_at,referrer_id,referral_source,idempotency_key,request_hash) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11) RETURNING *',[id,user.id,plan.id,plan.amountCents,plan.review?'review':'pending',JSON.stringify(form),nowISO(),current.referrer_id,current.referral_source,key,requestHash]);
        if(renewals)await renewals.saveOrderInTransaction(c,row,{kind,membership});
        if(!plan.registrationOnly&&rewards?.captureOrderSnapshotInTransaction)await rewards.captureOrderSnapshotInTransaction(c,id,{kind});
        await recordConsent(c,user.id,'order',id,body.legalConsent);await audit(c,user.id,'order.created',id,{planId:plan.id,amountCents:plan.amountCents,transactionKind:kind});return orderView(c,row);
      },true);
    },
    async acceptPayment(user,id,body){return run(async c=>{const order=await owned(c,user,id);requireRule(order.status==='pending'&&body.detailsConfirmed===true,'请核对订单资料',409);await recordConsent(c,user.id,'payment',id,body);return {accepted:true};},true);},
    paymentAccepted:(user,id)=>run(async c=>{await owned(c,user,id);return !legal||!!await one(c,"SELECT 1 FROM legal_consents WHERE user_id=$1 AND scope='payment' AND target_id=$2 AND release_id=$3",[user.id,id,legal.id]);}),
    async preparePayment(user,id){return run(async c=>{
      const order=await owned(c,user,id);requireRule(order.status==='pending'&&!plans[order.plan_id]?.registrationOnly,'当前订单不能付款',409);
      requireRule(!await needsPaymentReconciliation(c,user.id),'已有付款待核对，请保留原订单，勿重复付款',409);
      if(renewals)await renewals.assertPayableInTransaction(c,order);
      requireRule(!await one(c,'SELECT 1 FROM settings WHERE key=$1',['virtual_payment_attempt:'+id]),'已有虚拟支付尝试，请先核对结果',409);
      requireRule(!legal||!!await one(c,"SELECT 1 FROM legal_consents WHERE user_id=$1 AND scope='payment' AND target_id=$2 AND release_id=$3",[user.id,id,legal.id]),'请先确认订单与协议',409);
      requireRule(!await one(c,"SELECT 1 FROM manual_payments WHERE order_id=$1 AND status IN ('pending','confirmed')",[id]),'已有人工付款记录，请勿重复付款',409);
      const attempt=await one(c,'SELECT value FROM settings WHERE key=$1',[paymentKey(id)]);requireRule(attempt?.value!=='closing','订单正在关闭',409);
      const identity=await one(c,'SELECT open_id FROM wechat_identities WHERE app_id=$1 AND user_id=$2',[appId,user.id]);requireRule(identity,'微信身份未关联',403);
      await c.query('INSERT INTO settings VALUES($1,$2) ON CONFLICT(key) DO NOTHING',[paymentKey(id),'initiated']);return {order:{...order,amount_cents:safeInteger(order.amount_cents)},openId:identity.open_id};
    },true);},
    attempted:id=>run(async c=>!!await one(c,'SELECT 1 FROM settings WHERE key=$1',[paymentKey(id)])),
    async cancelOrder(user,id,provider){
      const cancellation=await run(async c=>{
        const order=await owned(c,user,id);requireRule(['pending','review','cancelled'].includes(order.status),'当前状态不能取消',409);
        if(order.status==='cancelled')return {order:await orderView(c,order)};
        requireRule(!await orderNeedsPaymentReconciliation(c,id),'订单已有付款待核对，不能取消，请保留原订单',409);
        const virtual=await one(c,'SELECT value FROM settings WHERE key=$1',['virtual_payment_attempt:'+id]);
        requireRule(!virtual||virtual.value==='closed','虚拟付款参数已发出，请保留订单并刷新权威结果后办理',409);
        requireRule(!await one(c,"SELECT 1 FROM manual_payments WHERE order_id=$1 AND status='pending'",[id]),'人工付款正在核对',409);
        const attempted=!!await one(c,'SELECT 1 FROM settings WHERE key=$1',[paymentKey(id)]);
        if(!attempted){
          await c.query("UPDATE orders SET status='cancelled' WHERE id=$1",[id]);
          await audit(c,user.id,'order.cancelled',id);
          return {order:await orderView(c,await owned(c,user,id))};
        }
        requireRule(provider?.configured,'支付尚未核实，暂不能取消',409);
        await c.query('INSERT INTO settings VALUES($1,$2) ON CONFLICT(key) DO UPDATE SET value=excluded.value',[paymentKey(id),'closing']);
        return {needsClose:true};
      },true);
      if(cancellation.order)return cancellation.order;
      if(cancellation.needsClose){
        try{await provider.close(id);}catch(error){
          // A failed close is resolved only by the provider's own order state:
          // paid orders activate and stay uncancelled; closed/nonexistent orders may cancel.
          let remote;
          try{remote=await provider.query(id);}catch(queryError){if(queryError?.providerCode!=='ORDER_NOT_EXIST')throw error;}
          if(remote){
            requireRule(remote.appid===appId&&remote.mchid===provider.merchantId&&remote.out_trade_no===id.slice(2),'支付查单主体不一致',409);
            if(remote.trade_state==='SUCCESS'){await core.applyPayment(remote,provider);requireRule(false,'订单已付款，不能取消，请刷新订单',409);}
            if(remote.trade_state!=='CLOSED')throw error;
          }
        }
      }
      return run(async c=>{
        const row=await owned(c,user,id);requireRule(['pending','review','cancelled'].includes(row.status),'当前状态不能取消',409);
        if(row.status==='cancelled')return orderView(c,row);
        requireRule(!await orderNeedsPaymentReconciliation(c,id),'订单已有付款待核对，不能取消，请保留原订单',409);
        await c.query("UPDATE orders SET status='cancelled' WHERE id=$1",[id]);await audit(c,user.id,'order.cancelled',id);return orderView(c,await owned(c,user,id));
      },true);
    },
    // Re-check after the provider prepay call: a cancel may have started meanwhile.
    prepayStillOpen:(user,id)=>run(async c=>{
      const order=await owned(c,user,id);
      if(await needsPaymentReconciliation(c,user.id))return false;
      if(order.status!=='pending'||(await one(c,'SELECT value FROM settings WHERE key=$1',[paymentKey(id)]))?.value!=='initiated')return false;
      if(renewals){
        try{await renewals.assertPayableInTransaction(c,order);}
        catch(error){if(['RENEWAL_DISABLED','RENEWAL_MEMBERSHIP_CHANGED'].includes(error.code))return false;throw error;}
      }
      return true;
    }),
    async applyPayment(remote,expected){
      requireRule(remote.appid===appId&&remote.appid===expected.appId&&remote.mchid===expected.merchantId&&remote.trade_state==='SUCCESS','支付主体或状态不匹配',409);
      requireRule(/^[A-F0-9]{32}$/.test(remote.out_trade_no||'')&&typeof remote.transaction_id==='string'&&remote.transaction_id.length>=6&&remote.transaction_id.length<=100,'支付流水不正确');
      requireRule(remote.amount?.currency==='CNY'&&Number.isSafeInteger(remote.amount.total)&&remote.amount.total>0,'支付金额不正确');
      const parsed=Date.parse(remote.success_time);requireRule(Number.isFinite(parsed)&&parsed<=Date.now()+300000,'支付时间不正确');
      const id='HJ'+remote.out_trade_no,paidAt=new Date(parsed).toISOString();
      const hash=digest(JSON.stringify({transactionId:remote.transaction_id,orderId:id,merchantId:remote.mchid,appId:remote.appid,currency:'CNY',amountCents:remote.amount.total,status:'SUCCESS',paidAt}));
      return run(async c=>{
        const previous=await one(c,'SELECT * FROM payment_receipts WHERE transaction_id=$1',[remote.transaction_id]);
        if(previous){requireRule(previous.payload_hash===hash,'重复流水内容不一致',409);return {outcome:previous.outcome,duplicate:true};}
        const order=await one(c,'SELECT * FROM orders WHERE id=$1',[id]);requireRule(order,'订单不存在',404);
        requireRule(safeInteger(order.amount_cents)===remote.amount.total&&parsed>=Date.parse(order.created_at),'支付金额或时间与订单不一致');
        const identity=await one(c,'SELECT open_id FROM wechat_identities WHERE app_id=$1 AND user_id=$2',[appId,order.user_id]);requireRule(identity?.open_id===remote.payer?.openid,'支付人身份不匹配',409);
        const renewal=renewals?await renewals.fulfillmentInTransaction(c,order,paidAt):null;
        let outcome=renewal?.outcome??(order.status==='pending'&&!plans[order.plan_id]?.registrationOnly&&!await member(c,order.user_id)?'activated':'needs_reconciliation');
        const expires=renewal?.expiresAt??yearAfter(paidAt);
        if(outcome==='activated'&&grantPaymentConflict&&await grantPaymentConflict(c,order.user_id,{startsAt:renewal?.startsAt??paidAt,expiresAt:expires}))outcome='needs_reconciliation';
        if(outcome==='activated'){
          await c.query("UPDATE orders SET status='paid',actual_paid_cents=$1,paid_at=$2,expires_at=$3 WHERE id=$4",[remote.amount.total,paidAt,expires,id]);
          if(renewal)await c.query('UPDATE memberships SET order_id=$1,starts_at=$2,expires_at=$3 WHERE user_id=$4',[id,renewal.startsAt,expires,order.user_id]);
          else await c.query('INSERT INTO memberships VALUES($1,$2,$3,$4,$5)',[order.user_id,id,order.plan_id,paidAt,expires]);
          if(renewals)await renewals.commitFulfillmentInTransaction(c,order,paidAt,expires);
          await c.query('UPDATE users SET referrer_id=$1,referral_source=$2,referral_locked_at=$3 WHERE id=$4',[order.referrer_id,order.referral_source,nowISO(),order.user_id]);
        }
        await c.query('INSERT INTO payment_receipts VALUES($1,$2,$3,$4,$5)',[remote.transaction_id,id,hash,nowISO(),outcome]);
        if(outcome==='activated'&&rewards?.recordPaidOrderInTransaction)await rewards.recordPaidOrderInTransaction(c,id);
        await audit(c,null,'payment.'+outcome,id,{transactionId:remote.transaction_id});return {outcome,duplicate:false};
      },true);
    }
  };
  return core;
}
