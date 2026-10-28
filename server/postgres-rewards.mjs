import {readFileSync} from 'node:fs';
import {createHash} from 'node:crypto';
import {postgresTransaction,safeInteger} from './postgres.mjs';
import {createRewardLedgerState,applyRewardLedgerCommand,rewardBalance,buildRewardStatement,matureRewardIds} from './reward-ledger.mjs';

export const rewardMigrationTables=['_club_reward_ledger_state','_club_reward_ledger_commands','_club_reward_order_snapshots'];
export const rewardMigrationMarker={key:'_club_reward_ledger_migration',value:'003-reward-ledger-v1'};
const migration=readFileSync(new URL('./migrations/postgres/003-reward-ledger.sql',import.meta.url),'utf8');
const error=(code,message,status=409)=>Object.assign(new Error(message),{code,status});
const need=(condition,code,message,status)=>{if(!condition)throw error(code,message,status);};
const hash=value=>createHash('sha256').update(JSON.stringify(value)).digest('hex');
const schemaName=schema=>{need(/^club_migration_[a-z0-9_]{1,40}$/.test(schema||''),'REWARD_SCHEMA_INVALID','需要指定迁移隔离区',400);return schema;};
const object=value=>value&&typeof value==='object'&&!Array.isArray(value);
const string=(value,max=160)=>typeof value==='string'&&value.length>0&&value.length<=max&&!/[\x00-\x1f\x7f]/.test(value);
const canonical=value=>Array.isArray(value)?value.map(canonical):object(value)?Object.fromEntries(Object.keys(value).sort().map(key=>[key,canonical(value[key])])):value;
const one=async(c,sql,args=[])=>(await c.query(sql,args)).rows[0];
const json=value=>typeof value==='string'?JSON.parse(value):value;
const closed=code=>({configured:false,code,message:code==='REWARDS_DISABLED'?'奖励及提现尚未启用':'奖励及提现规则或权限尚未批准配置'});
const publicWithdrawal=row=>({id:row.id,amountCents:row.amountCents,status:row.status,createdAt:row.createdAt,updatedAt:row.updatedAt,
  reason:row.payoutReconciliationRequired&&!row.payoutReconciledAt?'关联订单已退款，实际打款结果待财务核对':row.history?.at(-1)?.reason??'',
  paidAt:row.status==='paid'?row.payout?.paidAt??null:null,recipientMethod:row.recipientMethod});
function publicReward(row,ledger){
  const amountCents=row.grossCents-row.reversedCents;
  const frozen=ledger.refundHolds.some(hold=>hold.orderId===row.orderId&&hold.status==='pending')||ledger.withdrawals.some(withdrawal=>withdrawal.payoutReconciliationRequired&&!withdrawal.payoutReconciledAt&&withdrawal.allocations.some(allocation=>allocation.rewardId===row.id));
  return {id:row.id,orderId:row.orderId,amountCents,grossCents:row.grossCents,reversedCents:row.reversedCents,
    status:amountCents===0?'reversed':frozen?'frozen':row.confirmedAt?'confirmed':'pending',createdAt:row.createdAt,confirmedAt:row.confirmedAt,ruleVersion:row.ruleVersion};
}
function publicStatement(statement){
  const {beneficiaryId,entries,...summary}=statement;
  return {...summary,openingBalance:statementBalance(statement.openingBalance),closingBalance:statementBalance(statement.closingBalance),entries:entries.map(row=>Object.fromEntries(['type','at','amountCents','orderId','withdrawalId','ruleVersion'].filter(key=>row[key]!==undefined).map(key=>[key,row[key]])))};
}
const statementTypes=new Set(['reward_accrued','reward_confirmed','reward_reversed','refund_frozen','refund_unfrozen','withdrawal_submitted','finance_reviewed','secretary_approved','withdrawal_rejected','withdrawal_failed','withdrawal_paid','payout_reconciliation_required']);
function statementBalance(balance){
  const netCents=Number(BigInt(balance.pendingCents)+BigInt(balance.confirmedCents)-BigInt(balance.paidCents));
  need(Number.isSafeInteger(netCents),'REWARD_STATE_INVALID','账单净额超出范围',503);
  return {...Object.fromEntries(['pendingCents','confirmedCents','reservedCents','paidCents','reversedCents','frozenCents','withdrawableCents','debtCents','blockedReasons'].map(key=>[key,balance[key]])),
    netCents};
}
function verifiedStatementPayout(withdrawal,amountCents,feeCents){
  const payout=withdrawal?.payout,recipient=withdrawal?.recipientSnapshot;
  need(payout?.verified===true&&string(payout.evidenceRef)&&string(payout.id)&&payout.amountCents===amountCents
    &&payout.withdrawalId===withdrawal.id&&payout.recipientRef===withdrawal.recipientRef&&recipient?.verified===true
    &&recipient.id===payout.recipientRef&&recipient.ownerId===withdrawal.beneficiaryId&&string(recipient.evidenceRef)
    &&Number.isFinite(Date.parse(payout.paidAt))&&Number.isSafeInteger(payout.feeCents)&&payout.feeCents>=0&&(feeCents===undefined||payout.feeCents===feeCents),
    'REWARD_PAYOUT_UNVERIFIED','实际转出或收款资料核验依据不完整，请核对账本',503);
}
function statementRange(month,asOf){
  need(typeof month==='string'&&/^\d{4}-(0[1-9]|1[0-2])$/.test(month),'REWARD_MONTH_INVALID','账单月份须为YYYY-MM',400);
  const [year,number]=month.split('-').map(Number),at=Date.parse(asOf);
  need(year>=1970&&year<=9998,'REWARD_MONTH_INVALID','账单年份不正确',400);
  const begin=Date.UTC(year,number-1,1)-8*3600000,end=Date.UTC(year,number,1)-8*3600000;
  need(begin<=at,'REWARD_MONTH_INVALID','不能查询尚未开始的账单月份',400);
  return {begin,end,cutoff:Math.min(at,end-1),provisional:at<end,nextMonth:new Date(Date.UTC(year,number,1)).toISOString().slice(0,7)};
}
function memberMonthStatement(ledger,beneficiaryId,month,asOf){
  const {begin,end,cutoff,provisional,nextMonth}=statementRange(month,asOf);
  const ownedRewards=ledger.rewards.filter(row=>row.beneficiaryId===beneficiaryId),rewardIds=new Set(ownedRewards.map(row=>row.id)),orderIds=new Set(ownedRewards.map(row=>row.orderId));
  const withdrawals=ledger.withdrawals.filter(row=>row.beneficiaryId===beneficiaryId),byWithdrawal=new Map(withdrawals.map(row=>[row.id,row]));
  for(const withdrawal of withdrawals){
    if(!withdrawal.payout)continue;
    need(Number.isFinite(Date.parse(withdrawal.payoutRegisteredAt)),'REWARD_PAYOUT_UNVERIFIED','实际转出记账时间不完整，请核对账本',503);
    if(Date.parse(withdrawal.payoutRegisteredAt)<=cutoff)verifiedStatementPayout(withdrawal,withdrawal.amountCents);
  }
  const unique=new Map(),entries=[];
  for(const row of ledger.events){
    if(!statementTypes.has(row.type))continue;
    const owned=row.beneficiaryId===beneficiaryId||(!row.beneficiaryId&&(rewardIds.has(row.rewardId)||orderIds.has(row.orderId)||byWithdrawal.has(row.withdrawalId)));
    if(!owned)continue;
    need(string(row.id)&&Number.isFinite(Date.parse(row.at)),'REWARD_STATE_INVALID','账单流水缺少有效编号或时间',503);
    const key=row.type+':'+(row.type==='reward_reversed'?row.refundId:row.type.startsWith('refund_')?row.refundRequestId:row.type==='payout_reconciliation_required'?row.withdrawalId+':'+row.refundId:row.withdrawalId??row.rewardId);
    const {id,...facts}=row,previous=unique.get(key);
    if(previous){need(hash(canonical(previous))===hash(canonical(facts)),'REWARD_STATE_INVALID','账单同一事实出现冲突，请核对账本',503);continue;}
    unique.set(key,facts);
    const at=Date.parse(row.at);if(at<begin||at>cutoff)continue;
    if(row.type==='withdrawal_paid'){
      const withdrawal=byWithdrawal.get(row.withdrawalId);verifiedStatementPayout(withdrawal,row.amountCents,row.feeCents);
      need(Date.parse(withdrawal.payout.paidAt)<=at&&withdrawal.payoutRegisteredAt===row.at,'REWARD_PAYOUT_UNVERIFIED','实际转出与记账时间不一致，请核对账本',503);
    }
    const projected=Object.fromEntries(['id','type','at','amountCents','orderId','withdrawalId','ruleVersion','reason','feeCents'].filter(key=>row[key]!==undefined).map(key=>[key,row[key]]));
    if(row.type==='withdrawal_paid')projected.paidAt=byWithdrawal.get(row.withdrawalId).payout.paidAt;
    entries.push(projected);
  }
  entries.sort((a,b)=>a.at.localeCompare(b.at)||a.id.localeCompare(b.id));
  const sum=type=>entries.filter(row=>row.type===type).reduce((value,row)=>{need(Number.isSafeInteger(row.amountCents)&&row.amountCents>=0,'REWARD_STATE_INVALID','账单金额不正确',503);const result=value+row.amountCents;need(Number.isSafeInteger(result),'REWARD_STATE_INVALID','账单金额超出范围',503);return result;},0);
  const openingBalance=statementBalance(rewardBalance(ledger,beneficiaryId,new Date(begin-1).toISOString()));
  const closingBalance=statementBalance(rewardBalance(ledger,beneficiaryId,new Date(cutoff).toISOString()));
  const earnedCents=sum('reward_accrued'),reversedCents=sum('reward_reversed'),paidCents=sum('withdrawal_paid');
  need(BigInt(openingBalance.netCents)+BigInt(earnedCents)-BigInt(reversedCents)-BigInt(paidCents)===BigInt(closingBalance.netCents),'REWARD_STATE_INVALID','月账单与奖励账本不一致，请核对后查看',503);
  const releasedCents=sum('withdrawal_rejected')+sum('withdrawal_failed'),feesCoveredByClubCents=entries.filter(row=>row.type==='withdrawal_paid').reduce((sum,row)=>sum+(row.feeCents??0),0);
  need(Number.isSafeInteger(releasedCents)&&Number.isSafeInteger(feesCoveredByClubCents),'REWARD_STATE_INVALID','账单汇总超出范围',503);
  return {month,timezone:'Asia/Shanghai',basis:'ledger_recorded_at',startAt:new Date(begin).toISOString(),endAtExclusive:new Date(end).toISOString(),asOf:new Date(cutoff).toISOString(),provisional,
    statementDueDate:nextMonth+'-05',payoutDueDate:nextMonth+'-15',openingBalance,closingBalance,
    totals:{earnedCents,confirmedCents:sum('reward_confirmed'),reversedCents,requestedCents:sum('withdrawal_submitted'),paidCents,
      releasedCents,feesCoveredByClubCents},entries,
    explanations:['按北京时间的账本记账时间归属月份；实际转出时间另列，迟到凭据在登记月份体现。',
      '期初净额＋本月新增－本月冲回－本月实际转出＝期末净额。确认奖励只改变可用状态，不重复增加净额。',
      '申请仅占用余额，审批不代表转出；实际转出只依据已核实流水，俱乐部承担手续费不从本人奖励扣减。',
      '退款处理中可能冻结待确认或已确认奖励；待打款申请关联退款时仍保留占用，实际转账结果核对前暂停新提现。净额包含冻结和申请占用，不能直接视为可提现金额。']};
}

// The caller must explicitly authorize this additive migration. Existing schemas,
// historical data, rules and permissions are never initialized by create below.
export async function initializePostgresRewards(pool,{schema}={}){
  schemaName(schema);
  return postgresTransaction(pool,async c=>{
    await c.query(`SET LOCAL search_path TO "${schema}"`);
    await c.query('LOCK TABLE settings IN SHARE ROW EXCLUSIVE MODE');
    const marker=await one(c,'SELECT value FROM settings WHERE key=$1',[rewardMigrationMarker.key]);
    const names=(await c.query('SELECT tablename FROM pg_tables WHERE schemaname=$1',[schema])).rows.map(row=>row.tablename);
    const found=rewardMigrationTables.filter(name=>names.includes(name));
    if(marker){need(marker.value===rewardMigrationMarker.value&&found.length===3,'REWARD_MIGRATION_INVALID','奖励迁移标记或表集合不一致');return {initialized:false};}
    need(found.length===0,'REWARD_MIGRATION_INVALID','发现未标记奖励表，须先核对迁移');
    await c.query(migration);
    await c.query('INSERT INTO _club_reward_ledger_state VALUES($1,$2,$3,$4)',['main',JSON.stringify(createRewardLedgerState()),0,new Date().toISOString()]);
    return {initialized:true};
  });
}

export function createPostgresRewards(pool,{schema,enabled=false,rulesSettingKey='reward_rules_v1',permissionsSettingKey='reward_permissions_v1',recipientCollection,now=()=>new Date().toISOString()}={}){
  schemaName(schema);
  need(typeof enabled==='boolean'&&typeof now==='function'&&string(rulesSettingKey)&&string(permissionsSettingKey),'REWARD_CONFIG_INVALID','奖励配置格式不正确',400);
  const time=()=>{const at=now();need(typeof at==='string'&&Number.isFinite(Date.parse(at)),'REWARD_CLOCK_INVALID','奖励服务时间无效',500);return new Date(at).toISOString();};
  const collectionAllowed=()=>recipientCollection?.approved===true&&string(recipientCollection.approvalRef)&&typeof recipientCollection.collectAndVerify==='function';
  const run=(fn,write=false)=>postgresTransaction(pool,async c=>{
    await c.query(`SET LOCAL search_path TO "${schema}"`);
    if(write)await c.query('LOCK TABLE users IN SHARE ROW EXCLUSIVE MODE');
    else await c.query('SET TRANSACTION ISOLATION LEVEL REPEATABLE READ READ ONLY');
    return fn(c);
  });
  async function setting(c,key,lock=false){
    const row=await one(c,'SELECT value FROM settings WHERE key=$1'+(lock?' FOR SHARE':''),[key]);
    if(!row)return null;
    try{return JSON.parse(row.value);}catch{throw error('REWARD_CONFIG_INVALID','奖励批准配置不是有效JSON',503);}
  }
  async function configuration(c,lock=false){
    if(!enabled)return {closed:closed('REWARDS_DISABLED')};
    const rules=await setting(c,rulesSettingKey,lock),permissions=await setting(c,permissionsSettingKey,lock);
    if(rules?.status!=='approved'||permissions?.status!=='approved')return {closed:closed('REWARD_RULES_UNCONFIGURED')};
    need(string(rules.activeVersion)&&Array.isArray(rules.rules)&&object(rules.sourcePolicy)&&rules.sourcePolicy.approved===true&&string(rules.sourcePolicy.approvalRef),'REWARD_CONFIG_INVALID','请批准奖励规则及来源资格政策',503);
    need(['order_created_at','verified_paid_at'].includes(rules.sourcePolicy.eligibilityAnchor),'REWARD_CONFIG_INVALID','请批准资格核对时点',503);
    need(string(permissions.version)&&string(permissions.approvalRef)&&object(permissions.grants),'REWARD_CONFIG_INVALID','请配置获准岗位及资料权限',503);
    const rule=rules.rules.find(rule=>rule?.version===rules.activeVersion);
    need(rule?.approved===true,'REWARD_CONFIG_INVALID','当前奖励规则没有批准版本',503);
    // Validate approval, rates, rounding, cooling and refund scope before exposing
    // readiness. Pure validation does not register a rule or create any balance.
    applyRewardLedgerCommand(createRewardLedgerState(),{type:'register_rule',idempotencyKey:'configuration-validation'},
      {service:'reward_ledger',serviceVerified:true,approvedRule:rule,now:time()});
    return {rules,permissions,rule};
  }
  async function actor(c,user,config,role,lock=false){
    need(string(user?.id),'REWARD_AUTH_REQUIRED','请先登录',401);
    const current=await one(c,'SELECT id,role FROM users WHERE id=$1'+(lock?' FOR SHARE':''),[user.id]);
    need(current,'REWARD_AUTH_REQUIRED','账号不存在或已失效',401);
    if(role==='member')need(current.role==='member','REWARD_FORBIDDEN','请使用本人会员账号',403);
    else need(current.role==='admin'&&Array.isArray(config.permissions?.grants[current.id])&&config.permissions.grants[current.id].includes(role),'REWARD_FORBIDDEN','当前账号未获准该资金操作',403);
    return {id:current.id,role,active:true};
  }
  async function state(c,write=false){
    const marker=await one(c,'SELECT value FROM settings WHERE key=$1',[rewardMigrationMarker.key]);
    need(marker?.value===rewardMigrationMarker.value,'REWARD_STORAGE_UNCONFIGURED','奖励持久化迁移尚未完成',503);
    const row=await one(c,'SELECT state_json,revision FROM _club_reward_ledger_state WHERE id=$1'+(write?' FOR UPDATE':''),['main']);
    need(row,'REWARD_STORAGE_UNCONFIGURED','奖励持久化状态尚未初始化',503);
    const ledger=json(row.state_json);need(ledger.revision===safeInteger(row.revision),'REWARD_STATE_INVALID','奖励账本版本不一致',503);return ledger;
  }
  async function execute(c,scope,command,authority,inputFingerprint){
    need(string(command.idempotencyKey,128),'REWARD_IDEMPOTENCY_INVALID','请提供有效提交编号',400);
    const fingerprint=inputFingerprint??hash(canonical({command,approvedRule:authority.approvedRule,order:authority.order,payment:authority.payment,
      refund:authority.refund,payout:authority.payout,payoutFailure:authority.payoutFailure,recipient:authority.recipient,role:authority.currentActor?.role}));
    const current=await state(c,true); // Serializes every command across connections/pools.
    const prior=await one(c,'SELECT request_hash,result_json FROM _club_reward_ledger_commands WHERE actor_id=$1 AND idempotency_key=$2',[scope,command.idempotencyKey]);
    if(prior){need(prior.request_hash===fingerprint,'IDEMPOTENCY_CONFLICT','提交编号已用于其他内容');return json(prior.result_json);}
    const reduced=applyRewardLedgerCommand(current,{...command,idempotencyKey:scope+':'+command.idempotencyKey},{...authority,now:time()});
    await c.query('UPDATE _club_reward_ledger_state SET state_json=$1,revision=$2,updated_at=$3 WHERE id=$4',[JSON.stringify(reduced.state),reduced.state.revision,time(),'main']);
    await c.query('INSERT INTO _club_reward_ledger_commands VALUES($1,$2,$3,$4,$5)',[scope,command.idempotencyKey,fingerprint,JSON.stringify(reduced.result),time()]);
    await c.query('INSERT INTO audit_log(actor_id,action,target_id,detail,created_at) VALUES($1,$2,$3,$4,$5)',[authority.actorId??null,'reward.'+command.type,reduced.result?.id??command.withdrawalId??authority.order?.id??authority.approvedRule?.version??'reward-ledger-main',JSON.stringify({ledgerRevision:reduced.state.revision}),time()]);
    return reduced.result;
  }
  async function eligibility(c,beneficiaryId,at,policy){
    const user=await one(c,'SELECT id,role FROM users WHERE id=$1',[beneficiaryId]);
    if(user?.role!=='member')return null;
    const membership=await one(c,'SELECT * FROM memberships WHERE user_id=$1',[beneficiaryId]);
    if(membership&&membership.starts_at<=at&&membership.expires_at>at)return {eligible:true,kind:'paid_member',evidenceRef:'membership:'+membership.order_id};
    const channel=policy.invitedChannels?.[beneficiaryId];
    if(channel?.approved===true&&string(channel.evidenceRef))return {eligible:true,kind:'invited_channel',evidenceRef:channel.evidenceRef};
    return null;
  }
  async function captureOrderSnapshotInTransaction(c,orderId,{kind='first_purchase',membershipCycleId}={}){
    const config=await configuration(c,true);if(config.closed)return config.closed;
    await state(c,true);
    need(['first_purchase','renewal','upgrade'].includes(kind),'REWARD_ORDER_INVALID','奖励交易类型无效',400);
    const order=await one(c,'SELECT * FROM orders WHERE id=$1 FOR UPDATE',[orderId]);
    need(order&&['pending','review'].includes(order.status),'REWARD_ORDER_INVALID','仅新待处理订单可创建奖励规则快照');
    const existing=await one(c,'SELECT snapshot_json FROM _club_reward_order_snapshots WHERE order_id=$1',[orderId]);
    if(existing){const prior=json(existing.snapshot_json);need(prior.kind===kind&&prior.membershipCycleId===(membershipCycleId??null),'REWARD_ORDER_INVALID','订单奖励快照不能修改');return {configured:true,captured:false};}
    const at=time(),policy=config.rules.sourcePolicy;
    let source=null;
    if(order.referrer_id){
      const sourceKind=order.referral_source==='default'?'configured_default':'explicit';
      if(sourceKind==='configured_default')need(policy.defaultBeneficiaryId===order.referrer_id&&string(policy.defaultApprovalRef),'REWARD_SOURCE_UNCONFIGURED','默认推荐归属尚未批准',503);
      source={id:order.id+':source',version:policy.version??config.rules.activeVersion,beneficiaryId:order.referrer_id,depth:1,kind:sourceKind,
        sourceEvidence:{type:'order_referral_snapshot',orderId:order.id,referralSource:order.referral_source,referrerId:order.referrer_id},
        capturedAt:at,eligibility:await eligibility(c,order.referrer_id,at,policy)};
    }
    const snapshot={orderId,userId:order.user_id,planId:order.plan_id,amountCents:safeInteger(order.amount_cents),currency:order.currency,referrerId:order.referrer_id??null,referralSource:order.referral_source??null,kind,membershipCycleId:membershipCycleId??null,rule:config.rule,sourcePolicy:policy,source};
    await c.query('INSERT INTO _club_reward_order_snapshots VALUES($1,$2,$3)',[orderId,JSON.stringify(snapshot),at]);
    return {configured:true,captured:true};
  }
  async function recordPaidOrderInTransaction(c,orderId){
    const config=await configuration(c,true);if(config.closed)return config.closed;
    await state(c,true);
    const order=await one(c,'SELECT * FROM orders WHERE id=$1 FOR UPDATE',[orderId]);
    need(order?.status==='paid'&&order.currency==='CNY'&&order.actual_paid_cents!=null&&order.paid_at,'REWARD_PAYMENT_UNVERIFIED','订单尚未核实付款');
    const receipt=await one(c,"SELECT * FROM payment_receipts WHERE order_id=$1 AND outcome='activated' ORDER BY received_at,transaction_id",[orderId]);
    need(receipt&&string(receipt.transaction_id)&&string(receipt.payload_hash),'REWARD_PAYMENT_UNVERIFIED','缺少对应已核实付款回执');
    const stored=await one(c,'SELECT snapshot_json FROM _club_reward_order_snapshots WHERE order_id=$1',[orderId]);
    if(!stored)return closed('REWARD_ORDER_RULE_UNCONFIGURED'); // Never reconstruct history after approval.
    const snapshot=json(stored.snapshot_json),amountCents=safeInteger(order.actual_paid_cents);
    need(snapshot.orderId===order.id&&snapshot.userId===order.user_id&&snapshot.planId===order.plan_id&&snapshot.amountCents===safeInteger(order.amount_cents)&&snapshot.currency===order.currency&&snapshot.referrerId===(order.referrer_id??null)&&snapshot.referralSource===(order.referral_source??null)&&snapshot.rule?.approved===true&&amountCents>0,'REWARD_ORDER_INVALID','付款奖励快照无效或订单资料已变化');
    const payment={id:receipt.transaction_id,orderId:order.id,verified:true,amountCents,paidAt:order.paid_at,evidenceRef:'payment_receipt:'+receipt.transaction_id+':'+receipt.payload_hash};
    const prior=await one(c,'SELECT result_json FROM _club_reward_ledger_commands WHERE actor_id=$1 AND idempotency_key=$2',['service','payment:'+receipt.transaction_id]);
    if(prior){const result=json(prior.result_json);need(hash(canonical(result.paymentSnapshot))===hash(canonical(payment))&&result.orderSnapshot?.ruleVersion===snapshot.rule.version&&result.orderSnapshot?.planId===order.plan_id&&result.orderSnapshot?.userId===order.user_id,'IDEMPOTENCY_CONFLICT','已记录付款事实与数据库不一致');return result;}
    const service={service:'reward_ledger',serviceVerified:true};
    await execute(c,'service',{type:'register_rule',idempotencyKey:'rule:'+snapshot.rule.version},{...service,approvedRule:snapshot.rule});
    let source=snapshot.source;
    if(source){
      need(source.beneficiaryId===order.referrer_id,'REWARD_SOURCE_INVALID','订单来源与快照不一致');
      const qualified=snapshot.sourcePolicy.eligibilityAnchor==='verified_paid_at'?await eligibility(c,source.beneficiaryId,order.paid_at,config.rules.sourcePolicy):source.eligibility;
      source=qualified?{...source,eligibility:qualified,lockedAt:order.paid_at}:null;
    }
    return execute(c,'service',{type:'record_payment',idempotencyKey:'payment:'+receipt.transaction_id},{...service,
      order:{id:order.id,userId:order.user_id,planId:order.plan_id,kind:snapshot.kind,ruleVersion:snapshot.rule.version,membershipCycleId:snapshot.membershipCycleId,sourceSnapshot:source},
      payment});
  }
  async function staffCommand(user,role,command,authorityExtra={}){
    need(['finance','secretary_general'].includes(role),'REWARD_FORBIDDEN','资金操作岗位不正确',403);
    return run(async c=>{
      const config=await configuration(c,true);if(config.closed)return config.closed;
      const currentActor=await actor(c,user,config,role,true);
      return execute(c,currentActor.id,command,{...authorityExtra,actorId:currentActor.id,currentActor});
    },true);
  }
  const api={
    captureOrderSnapshotInTransaction,recordPaidOrderInTransaction,
    captureOrderSnapshot:(id,options)=>run(c=>captureOrderSnapshotInTransaction(c,id,options),true),
    recordPaidOrder:id=>run(c=>recordPaidOrderInTransaction(c,id),true),
    readiness:()=>run(async c=>{const config=await configuration(c);if(config.closed)return config.closed;await state(c);return {configured:true,ruleVersion:config.rule.version,permissionsVersion:config.permissions.version};}),
    monthlyStatement:(user,input)=>run(async c=>{
      need(object(input)&&Object.keys(input).length===1&&Object.hasOwn(input,'month'),'REWARD_MONTH_INVALID','仅接受本人账单月份',400);
      const at=time();statementRange(input.month,at);
      const config=await configuration(c),current=await actor(c,user,config,'member');
      if(config.closed)return {enabled:false,reason:config.closed.message,reasonCode:config.closed.code};
      return {enabled:true,statement:memberMonthStatement(await state(c),current.id,input.month,at)};
    }),
    memberSummary:(user,{month}={})=>run(async c=>{
      const config=await configuration(c),current=await actor(c,user,config,'member');if(config.closed)return config.closed;
      const ledger=await state(c),rows=(await c.query("SELECT value FROM settings WHERE key LIKE 'reward_recipient:%'")).rows;
      const verifiedRecipients=[];
      for(const row of rows){let recipient;try{recipient=JSON.parse(row.value);}catch{continue;}
        if(recipient.ownerId===current.id&&recipient.verified===true&&string(recipient.id)&&['bank','wechat','alipay'].includes(recipient.method)&&string(recipient.evidenceRef))verifiedRecipients.push({id:recipient.id,method:recipient.method,maskedLabel:string(recipient.maskedLabel,60)?recipient.maskedLabel:{bank:'已核验银行卡',wechat:'已核验微信收款资料',alipay:'已核验支付宝收款资料'}[recipient.method]});
      }
      return {configured:true,balance:rewardBalance(ledger,current.id,time()),rewards:ledger.rewards.filter(row=>row.beneficiaryId===current.id).map(row=>publicReward(row,ledger)),withdrawals:ledger.withdrawals.filter(row=>row.beneficiaryId===current.id).map(publicWithdrawal),verifiedRecipients,...(month?{statement:publicStatement(buildRewardStatement(ledger,{beneficiaryId:current.id,month}))}:{})};
    }),
    async summary(user){
      const result=await api.memberSummary(user);
      if(!result.configured)return {enabled:false,reason:result.message,reasonCode:result.code,collectionAllowed:false};
      const balance=result.balance;
      return {enabled:true,reason:'',balance:{...balance,availableCents:balance.withdrawableCents},entries:result.rewards,withdrawals:result.withdrawals,verifiedRecipients:result.verifiedRecipients,
        canWithdraw:balance.withdrawableCents>=10000&&!(balance.blockedReasons?.length),minWithdrawalCents:10000,collectionAllowed:collectionAllowed()};
    },
    withdrawalStatus:(user,key)=>run(async c=>{
      const config=await configuration(c),current=await actor(c,user,config,'member');if(config.closed)return {enabled:false,reason:config.closed.message,reasonCode:config.closed.code};
      need(string(key,128),'REWARD_IDEMPOTENCY_INVALID','请提供有效提交编号',400);
      const ledger=await state(c),saved=await one(c,'SELECT result_json FROM _club_reward_ledger_commands WHERE actor_id=$1 AND idempotency_key=$2',[current.id,key]);
      const result=saved?json(saved.result_json):null,withdrawal=result?ledger.withdrawals.find(row=>row.id===result.id&&row.beneficiaryId===current.id):null;
      return {enabled:true,found:!!withdrawal,...(withdrawal?{withdrawal:publicWithdrawal(withdrawal)}:{})};
    }),
    managed:(user,role='finance')=>run(async c=>{need(['finance','secretary_general'].includes(role),'REWARD_FORBIDDEN','资金查询岗位不正确',403);const config=await configuration(c);if(config.closed)return config.closed;await actor(c,user,config,role);const ledger=await state(c);return {configured:true,rewards:ledger.rewards,withdrawals:ledger.withdrawals};}),
    requestWithdrawal:(user,input,key)=>run(async c=>{
      const config=await configuration(c,true),currentActor=await actor(c,user,config,'member',true);if(config.closed)return config.closed;
      need(object(input),'REWARD_INPUT_INVALID','提现请求格式不正确',400);
      need(string(key,128),'REWARD_IDEMPOTENCY_INVALID','请提供有效提交编号',400);
      const fingerprint=hash(canonical({type:'request_withdrawal',input}));
      await state(c,true);
      const saved=await one(c,'SELECT request_hash,result_json FROM _club_reward_ledger_commands WHERE actor_id=$1 AND idempotency_key=$2',[currentActor.id,key]);
      if(saved){need(saved.request_hash===fingerprint,'IDEMPOTENCY_CONFLICT','提交编号已用于其他内容');return publicWithdrawal(json(saved.result_json));}
      let recipient;
      if(Object.hasOwn(input,'recipientRef')){
        need(Object.keys(input).every(k=>['amountCents','recipientRef'].includes(k)),'REWARD_INPUT_INVALID','提现请求只能包含金额和收款资料引用',400);
        need(string(input.recipientRef),'REWARD_RECIPIENT_INVALID','请选择已核验收款资料',400);
        recipient=await setting(c,'reward_recipient:'+input.recipientRef,true);
        need(recipient?.id===input.recipientRef,'REWARD_RECIPIENT_INVALID','收款资料引用不匹配',403);
      }else{
        need(collectionAllowed(),'REWARD_COLLECTION_UNCONFIGURED','收款资料收集及核验方式尚未批准配置',503);
        need(Object.keys(input).every(k=>['amountCents','method','recipientName','recipientAccount','consent'].includes(k))&&['bank','wechat','alipay'].includes(input.method)&&string(input.recipientName,80)&&string(input.recipientAccount,120)&&input.consent===true,'REWARD_INPUT_INVALID','请核对收款方式、姓名、账号及资料用途同意',400);
        // Explicit trusted DB-only callback must securely persist and independently
        // verify the account, returning a reference. No plaintext enters the ledger.
        recipient=await recipientCollection.collectAndVerify(c,currentActor,input,key);
      }
      need(string(recipient?.id)&&recipient.ownerId===currentActor.id&&recipient.verified===true&&['bank','wechat','alipay'].includes(recipient.method)&&string(recipient.evidenceRef),'REWARD_RECIPIENT_INVALID','收款资料未经核验或不属于本人',403);
      const safeRecipient={id:recipient.id,ownerId:recipient.ownerId,method:recipient.method,verified:true,evidenceRef:recipient.evidenceRef};
      return publicWithdrawal(await execute(c,currentActor.id,{type:'request_withdrawal',amountCents:input.amountCents,recipientRef:recipient.id,idempotencyKey:key},{actorId:currentActor.id,currentActor,recipient:safeRecipient},fingerprint));
    },true),
    financeReview:(user,id,key)=>staffCommand(user,'finance',{type:'finance_review',withdrawalId:id,idempotencyKey:key}),
    secretaryApprove:(user,id,key)=>staffCommand(user,'secretary_general',{type:'secretary_approve',withdrawalId:id,idempotencyKey:key}),
    rejectWithdrawal:(user,id,reason,key,{role='finance'}={})=>staffCommand(user,role,{type:'reject_withdrawal',withdrawalId:id,reason,idempotencyKey:key}),
    confirmMatured:()=>run(async c=>{
      const config=await configuration(c,true);if(config.closed)return config.closed;
      const ledger=await state(c,true),eligible=matureRewardIds(ledger,time());
      if(!eligible.length)return {confirmedRewardIds:[]};
      return execute(c,'service',{type:'confirm_matured',idempotencyKey:'mature:'+ledger.revision+':'+hash(eligible.sort())},{service:'reward_ledger',serviceVerified:true});
    },true),
    recordPayout:(user,id,input,key)=>run(async c=>{
      const config=await configuration(c,true),currentActor=await actor(c,user,config,'finance',true);
      need(!config.closed,'REWARD_RULES_UNCONFIGURED','奖励及提现尚未配置',503);
      need(object(input)&&Object.keys(input).every(k=>['confirmedPaid','reference','evidenceRef','paidAt','feeCents'].includes(k))&&input.confirmedPaid===true&&string(input.reference)&&string(input.evidenceRef)&&Number.isFinite(Date.parse(input.paidAt))&&Number.isSafeInteger(input.feeCents)&&input.feeCents>=0,'REWARD_PAYOUT_UNVERIFIED','请核对实际打款并登记流水、时间和凭据',400);
      const ledger=await state(c,true),withdrawal=ledger.withdrawals.find(row=>row.id===id);
      need(withdrawal,'REWARD_WITHDRAWAL_NOT_FOUND','提现申请不存在',404);
      const payout={id:input.reference,withdrawalId:id,amountCents:withdrawal.amountCents,recipientRef:withdrawal.recipientRef,paidAt:new Date(input.paidAt).toISOString(),feeCents:input.feeCents,evidenceRef:input.evidenceRef,verified:true};
      return execute(c,currentActor.id,{type:'record_payout',withdrawalId:id,idempotencyKey:key},{actorId:currentActor.id,currentActor,payout});
    },true),
    failPayout:async(user,id,input,key)=>{need(object(input)&&input.confirmedNoMoneyMoved===true&&string(input.evidenceRef),'REWARD_PAYOUT_UNVERIFIED','须核实打款失败且未实际出款',400);return staffCommand(user,'finance',{type:'fail_payout',withdrawalId:id,reason:input.reason,idempotencyKey:key},{payoutFailure:{withdrawalId:id,verified:true,noMoneyMoved:true,evidenceRef:input.evidenceRef}});},
    // Internal integration only: facts must already have been independently
    // verified and persisted by the payment/refund service, never a request body.
    recordVerifiedRefund:refundId=>run(async c=>{const config=await configuration(c,true);if(config.closed)return config.closed;const refund=await setting(c,'reward_verified_refund:'+refundId,true);need(refund?.id===refundId&&refund.verified===true&&string(refund.evidenceRef),'REWARD_REFUND_UNVERIFIED','退款结果尚未由服务端核实');return execute(c,'service',{type:'record_refund',idempotencyKey:'refund:'+refundId},{service:'reward_ledger',serviceVerified:true,refund});},true),
    freezeVerifiedRefundRequest:requestId=>run(async c=>{const config=await configuration(c,true);if(config.closed)return config.closed;const refundRequest=await setting(c,'reward_verified_refund_request:'+requestId,true);need(refundRequest?.id===requestId&&refundRequest.verified===true&&string(refundRequest.evidenceRef),'REWARD_REFUND_UNVERIFIED','退款申请尚未由服务端核实');return execute(c,'service',{type:'freeze_refund',idempotencyKey:'refund-request:'+requestId},{service:'reward_ledger',serviceVerified:true,refundRequest});},true),
    releaseVerifiedRefundHold:requestId=>run(async c=>{const config=await configuration(c,true);if(config.closed)return config.closed;const refundOutcome=await setting(c,'reward_verified_refund_outcome:'+requestId,true);need(refundOutcome?.requestId===requestId&&refundOutcome.verified===true&&refundOutcome.noMoneyMoved===true&&string(refundOutcome.evidenceRef),'REWARD_REFUND_UNVERIFIED','退款取消或未出款的失败尚未核实');return execute(c,'service',{type:'release_refund_hold',idempotencyKey:'refund-outcome:'+requestId},{service:'reward_ledger',serviceVerified:true,refundOutcome});},true)
  };
  return api;
}
