import { createHash } from 'node:crypto';

// This module accepts authority supplied by a trusted server adapter, never a request body.
// It has no IO: commit the returned state and business facts together in a DB transaction.
export const REWARD_COOLING_MS = 7 * 24 * 60 * 60 * 1000;
export const MIN_WITHDRAWAL_CENTS = 10_000;
const ACTIVE_WITHDRAWALS = new Set(['submitted', 'reviewing', 'awaiting_payment']);
const MEMBER_COMMANDS = new Set(['request_withdrawal']);
const SERVICE_COMMANDS = new Set(['record_payment', 'confirm_matured', 'freeze_refund', 'release_refund_hold', 'record_refund']);
const COMMAND_FIELDS = {
  register_rule: [], record_payment: [], confirm_matured: [], freeze_refund: [], release_refund_hold: [], record_refund: [],
  request_withdrawal: ['amountCents', 'recipientRef'], finance_review: ['withdrawalId'], secretary_approve: ['withdrawalId'],
  reject_withdrawal: ['withdrawalId', 'reason'], record_payout: ['withdrawalId'], fail_payout: ['withdrawalId', 'reason'],
};

export class RewardLedgerError extends Error {
  constructor(code, message, status = 409) { super(message); this.name = 'RewardLedgerError'; this.code = code; this.status = status; }
}
function requireValue(value, code, message, status) { if (!value) throw new RewardLedgerError(code, message, status); }
function identifier(value, name) {
  requireValue(typeof value === 'string' && value.length > 0 && value.length <= 240 && value === value.trim(), 'INVALID_INPUT', `${name}不正确`, 400);
  return value;
}
function money(value, name, minimum = 0) {
  requireValue(Number.isSafeInteger(value) && value >= minimum, 'INVALID_AMOUNT', `${name}必须为非负整数分`, 400); return value;
}
function instant(value, name) {
  requireValue(typeof value === 'string' && Number.isFinite(Date.parse(value)), 'INVALID_TIME', `${name}不正确`, 400);
  return Date.parse(value);
}
function add(values) {
  const total = values.reduce((sum, value) => sum + BigInt(value), 0n);
  requireValue(total <= BigInt(Number.MAX_SAFE_INTEGER) && total >= 0n, 'AMOUNT_OVERFLOW', '金额超出安全范围'); return Number(total);
}
function canonical(value) {
  if (Array.isArray(value)) return value.map(canonical);
  if (value && typeof value === 'object') return Object.fromEntries(Object.keys(value).sort().filter(key => value[key] !== undefined).map(key => [key, canonical(value[key])]));
  return value;
}
function hash(value) { return createHash('sha256').update(JSON.stringify(canonical(value))).digest('hex'); }
function copy(value) { return structuredClone(value); }
function currentActor(authority, roles) {
  const actor = authority.currentActor;
  requireValue(actor?.active === true && actor.id === authority.actorId && typeof actor.id === 'string' && actor.id.length > 0 && roles.includes(actor.role), 'FORBIDDEN', '当前身份没有此操作权限', 403);
  return actor;
}
function permission(type, authority) {
  // A transaction adapter may hydrate an approval already verified from server storage.
  // This imports its unchanged approval snapshot; it does not approve a new client rule.
  if (type === 'register_rule' && authority.service === 'reward_ledger' && authority.serviceVerified === true) return;
  if (SERVICE_COMMANDS.has(type)) {
    requireValue(authority.service === 'reward_ledger' && authority.serviceVerified === true, 'FORBIDDEN', '仅可信支付、退款和结算服务可记录资金事实', 403); return;
  }
  if (MEMBER_COMMANDS.has(type)) return currentActor(authority, ['member']);
  if (type === 'register_rule' || type === 'secretary_approve') return currentActor(authority, ['secretary_general']);
  if (type === 'reject_withdrawal') return currentActor(authority, ['finance', 'secretary_general']);
  return currentActor(authority, ['finance']);
}
function validateRule(rule) {
  requireValue(rule?.approved === true, 'RULE_NOT_APPROVED', '奖励规则尚未明确批准，禁止计奖');
  identifier(rule.version, '规则版本'); identifier(rule.approvedBy, '规则批准人'); identifier(rule.approvalRef, '规则批准依据'); instant(rule.approvedAt, '规则批准时间');
  requireValue(['floor', 'half_up'].includes(rule.rounding), 'RULE_NOT_APPROVED', '须明确批准金额舍入规则');
  requireValue(rule.coolingAnchor === 'verified_paid_at', 'RULE_NOT_APPROVED', '须明确批准从核实付款时刻计算七天冷静期');
  requireValue(['account', 'membership_cycle'].includes(rule.firstUpgradeScope), 'RULE_NOT_APPROVED', '须明确批准首次升级的计算范围');
  requireValue(rule.ratesBps && Object.keys(rule.ratesBps).length > 0, 'RULE_NOT_APPROVED', '缺少已批准计奖比例');
  for (const [planId, rates] of Object.entries(rule.ratesBps)) {
    identifier(planId, '会员档位'); requireValue(rates && Object.keys(rates).length > 0, 'RULE_NOT_APPROVED', '档位缺少计奖规则');
    for (const [kind, rate] of Object.entries(rates)) requireValue(['first_purchase', 'renewal', 'upgrade'].includes(kind) && Number.isSafeInteger(rate) && rate >= 0 && rate <= 10_000, 'RULE_NOT_APPROVED', '计奖比例必须是明确批准的整数基点');
  }
  const refund = rule.refundPolicy;
  requireValue(refund?.approved === true && refund.anchor === 'verified_paid_at' && Number.isSafeInteger(refund.windowMs) && refund.windowMs > 0, 'REFUND_POLICY_NOT_APPROVED', '须明确批准退款时限和起算规则');
  identifier(refund.version, '退款规则版本'); identifier(refund.approvalRef, '退款规则批准依据');
}
function calculateReward(paidCents, rateBps, rounding) {
  const product = BigInt(paidCents) * BigInt(rateBps);
  return Number((product + (rounding === 'half_up' ? 5_000n : 0n)) / 10_000n);
}
function validateState(state) {
  requireValue(state?.schemaVersion === 1 && Number.isSafeInteger(state.revision) && state.revision >= 0, 'INVALID_STATE', '奖励账本版本不正确');
  for (const name of ['rules', 'payments', 'rewards', 'refunds', 'refundHolds', 'withdrawals', 'events', 'commands']) requireValue(Array.isArray(state[name]), 'INVALID_STATE', `账本缺少${name}`);
  for (const [name, key] of [['rules', 'version'], ['payments', 'id'], ['rewards', 'id'], ['refunds', 'id'], ['refundHolds', 'id'], ['withdrawals', 'id'], ['commands', 'idempotencyKey']]) requireValue(new Set(state[name].map(row => row[key])).size === state[name].length, 'INVALID_STATE', `${name}存在重复记录`);
  requireValue(new Set(state.payments.map(row => row.orderId)).size === state.payments.length, 'INVALID_STATE', '同一订单不能重复计奖');
  for (const payment of state.payments) { money(payment.amountCents, '实付金额', 1); money(payment.refundedCents, '累计退款'); requireValue(payment.refundedCents <= payment.amountCents, 'INVALID_STATE', '退款不能超过实付'); }
  for (const reward of state.rewards) {
    money(reward.grossCents, '奖励'); money(reward.reversedCents, '奖励冲回'); requireValue(reward.reversedCents <= reward.grossCents, 'INVALID_STATE', '冲回超过奖励');
    // A refund during an approved manual payout requires reconciliation: preserve the
    // reservation until finance proves payment or proves that no money moved.
    const assigned = state.withdrawals.filter(row => ACTIVE_WITHDRAWALS.has(row.status) && !row.payoutReconciliationRequired).flatMap(row => row.allocations).filter(row => row.rewardId === reward.id);
    const paid = state.withdrawals.filter(row => row.status === 'paid').flatMap(row => row.allocations).filter(row => row.rewardId === reward.id);
    const reserved = add(assigned.map(row => row.amountCents)), spent = add(paid.map(row => row.amountCents));
    requireValue(reserved <= Math.max(0, reward.grossCents - reward.reversedCents - spent), 'INVALID_STATE', '同笔余额被重复占用');
  }
  const payoutIds = state.withdrawals.filter(row => row.payout).map(row => row.payout.id);
  requireValue(new Set(payoutIds).size === payoutIds.length, 'INVALID_STATE', '打款流水不能重复使用');
  for (const withdrawal of state.withdrawals) {
    money(withdrawal.amountCents, '提现金额', MIN_WITHDRAWAL_CENTS);
    requireValue(add(withdrawal.allocations.map(row => row.amountCents)) === withdrawal.amountCents, 'INVALID_STATE', '提现占用与申请金额不一致');
    for (const allocation of withdrawal.allocations) { money(allocation.amountCents, '占用金额', 1); requireValue(state.rewards.some(row => row.id === allocation.rewardId && row.beneficiaryId === withdrawal.beneficiaryId), 'INVALID_STATE', '提现来源不属于申请人'); }
    requireValue(withdrawal.status !== 'paid' || withdrawal.payout?.verified === true, 'INVALID_STATE', '已打款必须有核实的真实流水');
  }
}

export function createRewardLedgerState() {
  return { schemaVersion: 1, revision: 0, rules: [], payments: [], rewards: [], refunds: [], refundHolds: [], withdrawals: [], events: [], commands: [] };
}
function statusAt(withdrawal, cutoff) { return withdrawal.history.filter(row => instant(row.at, '提现状态时间') <= cutoff).at(-1)?.status; }
function holdActiveAt(hold, cutoff) { return instant(hold.createdAt, '冻结时间') <= cutoff && (!hold.resolvedAt || instant(hold.resolvedAt, '解冻时间') > cutoff); }
function rewardAmounts(state, reward, cutoff) {
  const reversedCents = add(state.refunds.filter(row => row.rewardId === reward.id && instant(row.recordedAt, '退款记录时间') <= cutoff).map(row => row.reversalCents));
  const withdrawals = state.withdrawals.filter(row => instant(row.createdAt, '申请时间') <= cutoff);
  const allocated = status => add(withdrawals.filter(row => status(statusAt(row, cutoff))).flatMap(row => row.allocations).filter(row => row.rewardId === reward.id).map(row => row.amountCents));
  const paidCents = allocated(status => status === 'paid'), reservedCents = allocated(status => ACTIVE_WITHDRAWALS.has(status));
  const netCents = reward.grossCents - reversedCents;
  const confirmed = reward.confirmedAt !== null && instant(reward.confirmedAt, '确认时间') <= cutoff;
  const held = state.refundHolds.some(row => row.orderId === reward.orderId && holdActiveAt(row, cutoff));
  return { reversedCents, paidCents, reservedCents, netCents, confirmed, held, freeCents: Math.max(0, netCents - paidCents - reservedCents), debtCents: Math.max(0, paidCents - netCents) };
}

// Caller must scope beneficiaryId to the authenticated user or an authorized finance query.
export function rewardBalance(state, beneficiaryId, at) {
  validateState(state); identifier(beneficiaryId, '受益人'); const cutoff = instant(at, '查询时间');
  const rows = state.rewards.filter(row => row.beneficiaryId === beneficiaryId && instant(row.createdAt, '计奖时间') <= cutoff).map(row => rewardAmounts(state, row, cutoff));
  const sum = select => add(rows.map(select)), debtCents = sum(row => row.debtCents);
  const available = sum(row => row.confirmed && !row.held ? row.freeCents : 0);
  const reconciliationRequired = state.withdrawals.some(row => row.beneficiaryId === beneficiaryId && row.payoutReconciliationRequired && instant(row.refundConflict.at, '打款核对时间') <= cutoff && (!row.payoutReconciledAt || instant(row.payoutReconciledAt, '打款核对完成时间') > cutoff));
  return { beneficiaryId, asOf: new Date(cutoff).toISOString(), pendingCents: sum(row => !row.confirmed ? row.netCents : 0), confirmedCents: sum(row => row.confirmed ? row.netCents : 0),
    reservedCents: sum(row => row.reservedCents), paidCents: sum(row => row.paidCents), reversedCents: sum(row => row.reversedCents),
    frozenCents: sum(row => row.held && row.confirmed ? row.freeCents : 0), withdrawableCents: debtCents > 0 || reconciliationRequired ? 0 : available, debtCents,
    blockedReasons: [...(debtCents > 0 ? ['REFUNDED_AFTER_PAYOUT'] : []), ...(reconciliationRequired ? ['PAYOUT_RECONCILIATION_REQUIRED'] : [])] };
}

// Shared by the reducer and its persistent adapter. Checking the maintenance
// queue must use exactly the same maturity/refund conditions as confirmation.
export function matureRewardIds(state, at) {
  validateState(state); const nowMs = instant(at, '服务器时间');
  return state.rewards.filter(reward => reward.confirmedAt === null && reward.grossCents > reward.reversedCents
    && instant(reward.maturityAt, '成熟时间') <= nowMs
    && !state.refundHolds.some(row => row.orderId === reward.orderId && row.status === 'pending')).map(reward => reward.id);
}

export function applyRewardLedgerCommand(previous, command, authority) {
  validateState(previous); requireValue(command && Object.hasOwn(COMMAND_FIELDS, command.type), 'INVALID_COMMAND', '奖励操作不正确', 400);
  identifier(command.idempotencyKey, '幂等键'); const nowMs = instant(authority?.now, '服务器时间'), now = new Date(nowMs).toISOString();
  const allowed = new Set(['type', 'idempotencyKey', ...COMMAND_FIELDS[command.type]]);
  requireValue(Object.keys(command).every(key => allowed.has(key)), 'UNTRUSTED_INPUT', '请求不能指定奖励归属、比例或资金事实', 400);
  const actor = permission(command.type, authority);
  const trustedInput = { ...authority }; delete trustedInput.now; delete trustedInput.currentActor;
  const fingerprint = hash({ command, authority: trustedInput });
  const repeat = previous.commands.find(row => row.idempotencyKey === command.idempotencyKey);
  if (repeat) { requireValue(repeat.fingerprint === fingerprint, 'IDEMPOTENCY_CONFLICT', '同一幂等键不能用于不同操作'); return { state: copy(previous), result: copy(repeat.result) }; }
  const state = copy(previous); let result;
  const emit = (type, detail = {}) => state.events.push({ id: `event:${state.revision + 1}:${state.events.length + 1}`, type, at: now, actorId: actor?.id ?? authority.service, ...detail });
  const transition = (row, status, reason) => { row.status = status; row.updatedAt = now; row.history.push({ status, at: now, ...(reason ? { reason } : {}) }); };
  const paymentForOrder = orderId => { const row = state.payments.find(item => item.orderId === orderId); requireValue(row, 'PAYMENT_NOT_FOUND', '未找到核实付款', 404); return row; };
  const withdrawalForAction = roles => {
    currentActor(authority, roles); identifier(command.withdrawalId, '提现编号'); const row = state.withdrawals.find(item => item.id === command.withdrawalId);
    requireValue(row, 'WITHDRAWAL_NOT_FOUND', '提现申请不存在', 404); requireValue(row.beneficiaryId !== actor.id, 'SELF_REVIEW_FORBIDDEN', '不能审核或登记自己的提现', 403); return row;
  };
  const checkUnfrozen = row => {
    requireValue(!state.refundHolds.some(hold => row.allocations.some(a => state.rewards.find(r => r.id === a.rewardId)?.orderId === hold.orderId) && hold.status === 'pending'), 'REFUND_FROZEN', '关联订单退款处理中，提现已冻结');
    requireValue(rewardBalance(state, row.beneficiaryId, now).debtCents === 0, 'REFUND_DEBT', '已有提现后退款负债，须核对后处理');
  };

  switch (command.type) {
    case 'register_rule': {
      const rule = copy(authority.approvedRule); validateRule(rule);
      requireValue((!actor || rule.approvedBy === actor.id) && instant(rule.approvedAt, '规则批准时间') <= nowMs, 'RULE_NOT_APPROVED', '批准身份或时间不符');
      const existing = state.rules.find(row => row.version === rule.version);
      if (existing) requireValue(hash(existing) === hash(rule), 'RULE_VERSION_CONFLICT', '历史规则版本禁止修改或重算');
      else { state.rules.push(rule); emit('rule_registered', { ruleVersion: rule.version, evidenceRef: rule.approvalRef }); }
      result = existing ?? rule; break;
    }
    case 'record_payment': {
      const order = copy(authority.order), payment = copy(authority.payment);
      requireValue(payment?.verified === true && order, 'PAYMENT_NOT_VERIFIED', '未核实的付款不能计奖');
      identifier(order.id, '订单'); identifier(order.userId, '付款会员'); identifier(order.planId, '会员档位'); identifier(payment.id, '付款流水'); identifier(payment.evidenceRef, '付款核实依据');
      money(payment.amountCents, '实付金额', 1); const paidMs = instant(payment.paidAt, '实际付款时间');
      requireValue(payment.orderId === order.id && paidMs <= nowMs, 'PAYMENT_MISMATCH', '付款与订单或时间不符');
      requireValue(['first_purchase', 'renewal', 'upgrade'].includes(order.kind), 'INVALID_ORDER_KIND', '未批准的交易类型');
      const existing = state.payments.find(row => row.id === payment.id || row.orderId === order.id);
      if (existing) {
        requireValue(hash(existing.paymentSnapshot) === hash(payment) && hash(existing.orderSnapshot) === hash(order), 'PAYMENT_CONFLICT', '同一订单或流水的付款快照冲突'); result = existing; break;
      }
      const rule = state.rules.find(row => row.version === order.ruleVersion); validateRule(rule);
      requireValue(instant(rule.approvedAt, '规则批准时间') <= paidMs, 'RULE_NOT_APPROVED', '未批准规则不能追溯用于已付款订单');
      const rateBps = rule.ratesBps[order.planId]?.[order.kind];
      requireValue(Number.isSafeInteger(rateBps), 'RATE_NOT_APPROVED', '该档位与交易类型没有已批准比例');
      if (order.kind === 'upgrade' && rule.firstUpgradeScope === 'membership_cycle') identifier(order.membershipCycleId, '会籍周期');
      const record = { id: payment.id, orderId: order.id, userId: order.userId, kind: order.kind, amountCents: payment.amountCents, refundedCents: 0, paidAt: payment.paidAt, createdAt: now, ruleVersion: rule.version, ruleSnapshot: copy(rule), orderSnapshot: order, paymentSnapshot: payment, rewardId: null, rewardStatus: 'skipped_no_source' };
      const source = order.sourceSnapshot;
      if (source) {
        identifier(source.id, '来源'); identifier(source.version, '来源版本'); identifier(source.beneficiaryId, '推荐人');
        requireValue(source.depth === 1 && source.beneficiaryId !== order.userId && ['explicit', 'scan', 'share', 'configured_default'].includes(source.kind), 'INVALID_SOURCE', '仅允许非本人一级核实来源');
        requireValue(instant(source.capturedAt, '来源捕获时间') <= paidMs && instant(source.lockedAt, '来源锁定时间') >= paidMs && instant(source.lockedAt, '来源锁定时间') <= nowMs, 'INVALID_SOURCE', '来源尚未在付款时锁定');
        const eligibility = source.eligibility;
        requireValue(typeof eligibility?.eligible === 'boolean', 'ELIGIBILITY_NOT_VERIFIED', '来源不能替代获奖资格');
        if (eligibility.eligible) {
          requireValue(['paid_member', 'invited_channel'].includes(eligibility.kind), 'ELIGIBILITY_NOT_VERIFIED', '获奖资格类型未核实'); identifier(eligibility.evidenceRef, '获奖资格依据');
          const cycleScope = rule.firstUpgradeScope === 'membership_cycle';
          if (order.kind === 'upgrade' && cycleScope) identifier(order.membershipCycleId, '会籍周期');
          const priorUpgrade = order.kind === 'upgrade' && state.payments.some(row => row.userId === order.userId && row.kind === 'upgrade' && (!cycleScope || row.orderSnapshot.membershipCycleId === order.membershipCycleId));
          const grossCents = calculateReward(payment.amountCents, rateBps, rule.rounding);
          if (priorUpgrade) record.rewardStatus = 'skipped_not_first_upgrade';
          else if (grossCents === 0) record.rewardStatus = 'skipped_zero_reward';
          else {
            const reward = { id: `reward-${hash(order.id).slice(0, 24)}`, paymentId: payment.id, orderId: order.id, beneficiaryId: source.beneficiaryId, paidAmountCents: payment.amountCents,
              grossCents, reversedCents: 0, rateBps, ruleVersion: rule.version, ruleSnapshot: copy(rule), sourceSnapshot: copy(source), createdAt: now,
              maturityAt: new Date(paidMs + REWARD_COOLING_MS).toISOString(), confirmedAt: null };
            state.rewards.push(reward); record.rewardId = reward.id; record.rewardStatus = 'pending';
            emit('reward_accrued', { beneficiaryId: reward.beneficiaryId, rewardId: reward.id, orderId: order.id, amountCents: grossCents, ruleVersion: rule.version });
          }
        } else record.rewardStatus = 'skipped_ineligible';
      }
      state.payments.push(record); emit('payment_recorded', { orderId: order.id, paymentId: payment.id, amountCents: payment.amountCents }); result = record; break;
    }
    case 'confirm_matured': {
      const confirmedRewardIds = matureRewardIds(state, now);
      for (const id of confirmedRewardIds) {
        const reward = state.rewards.find(row => row.id === id);
        reward.confirmedAt = now; const payment = paymentForOrder(reward.orderId); payment.rewardStatus = 'confirmed';
        emit('reward_confirmed', { beneficiaryId: reward.beneficiaryId, rewardId: reward.id, orderId: reward.orderId, amountCents: reward.grossCents - reward.reversedCents });
      }
      result = { confirmedRewardIds }; break;
    }
    case 'freeze_refund': {
      const request = copy(authority.refundRequest);
      requireValue(request?.verified === true, 'REFUND_NOT_VERIFIED', '须核实退款申请'); identifier(request.id, '退款申请'); identifier(request.evidenceRef, '退款申请依据'); money(request.amountCents, '申请退款金额', 1);
      const payment = paymentForOrder(request.orderId), policy = payment.ruleSnapshot.refundPolicy; const requestedMs = instant(request.requestedAt, '退款申请时间');
      requireValue(requestedMs <= nowMs && requestedMs >= instant(payment.paidAt, '付款时间') && requestedMs <= instant(payment.paidAt, '付款时间') + policy.windowMs, 'REFUND_OUTSIDE_POLICY', '退款申请超出该订单明确批准的时限');
      const existing = state.refundHolds.find(row => row.id === request.id);
      if (existing) { requireValue(hash(existing.requestSnapshot) === hash(request), 'REFUND_CONFLICT', '退款申请快照冲突'); result = existing; break; }
      requireValue(!state.refundHolds.some(row => row.orderId === payment.orderId && row.status === 'pending'), 'REFUND_ALREADY_PENDING', '已有退款申请处理中');
      requireValue(request.amountCents <= payment.amountCents - payment.refundedCents, 'REFUND_EXCEEDS_PAYMENT', '退款超过剩余实付');
      const hold = { id: request.id, orderId: payment.orderId, amountCents: request.amountCents, refundedCents: 0, createdAt: now, status: 'pending', resolvedAt: null, policyVersion: policy.version, requestSnapshot: request };
      state.refundHolds.push(hold); emit('refund_frozen', { orderId: payment.orderId, refundRequestId: request.id, beneficiaryId: state.rewards.find(row => row.orderId === payment.orderId)?.beneficiaryId }); result = hold; break;
    }
    case 'release_refund_hold': {
      const outcome = authority.refundOutcome;
      requireValue(outcome?.verified === true && outcome.noMoneyMoved === true && ['cancelled', 'failed'].includes(outcome.status), 'REFUND_OUTCOME_NOT_VERIFIED', '仅核实取消或未发生退款的失败可解冻'); identifier(outcome.evidenceRef, '解冻依据');
      const hold = state.refundHolds.find(row => row.id === outcome.requestId); requireValue(hold, 'REFUND_NOT_FOUND', '退款申请不存在', 404);
      requireValue(hold.status === 'pending', 'REFUND_STATE_CONFLICT', '该退款申请已经处理'); hold.status = outcome.status; hold.resolvedAt = now; hold.outcomeSnapshot = copy(outcome);
      emit('refund_unfrozen', { orderId: hold.orderId, refundRequestId: hold.id, evidenceRef: outcome.evidenceRef }); result = hold; break;
    }
    case 'record_refund': {
      const refund = copy(authority.refund);
      requireValue(refund?.verified === true, 'REFUND_NOT_VERIFIED', '未核实的退款不能冲回'); identifier(refund.id, '退款流水'); identifier(refund.evidenceRef, '退款到账依据'); money(refund.amountCents, '实退金额', 1);
      const payment = paymentForOrder(refund.orderId), refundedMs = instant(refund.refundedAt, '实际退款时间');
      requireValue(refund.paymentId === payment.id && refundedMs >= instant(payment.paidAt, '付款时间') && refundedMs <= nowMs, 'REFUND_MISMATCH', '退款与原付款或时间不符');
      const existing = state.refunds.find(row => row.id === refund.id);
      if (existing) { requireValue(hash(existing.refundSnapshot) === hash(refund), 'REFUND_CONFLICT', '同一退款流水不能修改'); result = existing; break; }
      requireValue(payment.refundedCents + refund.amountCents <= payment.amountCents && Number.isSafeInteger(payment.refundedCents + refund.amountCents), 'REFUND_EXCEEDS_PAYMENT', '累计退款超过实付');
      const reward = state.rewards.find(row => row.paymentId === payment.id); let reversalCents = 0;
      if (reward) {
        // Recompute the remaining reward from remaining real payment. This makes partial refund
        // totals independent of refund splitting and reverses the final cent on a full refund.
        const remainingReward = calculateReward(payment.amountCents - payment.refundedCents - refund.amountCents, reward.rateBps, reward.ruleSnapshot.rounding);
        reversalCents = reward.grossCents - remainingReward - reward.reversedCents;
        for (const withdrawal of state.withdrawals) if (ACTIVE_WITHDRAWALS.has(withdrawal.status) && withdrawal.allocations.some(row => row.rewardId === reward.id)) {
          if (withdrawal.status === 'awaiting_payment') {
            withdrawal.payoutReconciliationRequired = true; withdrawal.refundConflict = { at: now, refundId: refund.id, refundedAt: refund.refundedAt }; withdrawal.payoutReconciledAt = null;
            emit('payout_reconciliation_required', { beneficiaryId: withdrawal.beneficiaryId, withdrawalId: withdrawal.id, refundId: refund.id });
          } else {
            transition(withdrawal, 'failed', '关联订单实际退款，释放占用后重新核对');
            emit('withdrawal_failed', { beneficiaryId: withdrawal.beneficiaryId, withdrawalId: withdrawal.id, amountCents: withdrawal.amountCents, reason: '关联订单实际退款', refundId: refund.id });
          }
        }
        reward.reversedCents += reversalCents;
        if (reward.reversedCents === reward.grossCents) payment.rewardStatus = 'reversed';
      }
      payment.refundedCents += refund.amountCents;
      const record = { id: refund.id, orderId: payment.orderId, paymentId: payment.id, rewardId: reward?.id ?? null, beneficiaryId: reward?.beneficiaryId ?? null, amountCents: refund.amountCents, reversalCents, refundedAt: refund.refundedAt, recordedAt: now, refundSnapshot: refund };
      state.refunds.push(record);
      if (refund.requestId) {
        const hold = state.refundHolds.find(row => row.id === refund.requestId); requireValue(hold?.orderId === payment.orderId && hold.status === 'pending', 'REFUND_MISMATCH', '退款申请与实际退款不符');
        hold.refundedCents += refund.amountCents; requireValue(hold.refundedCents <= hold.amountCents, 'REFUND_MISMATCH', '实际退款超过申请金额');
        if (hold.refundedCents === hold.amountCents) { hold.status = 'refunded'; hold.resolvedAt = now; }
      }
      emit('reward_reversed', { beneficiaryId: reward?.beneficiaryId ?? null, orderId: payment.orderId, rewardId: reward?.id ?? null, refundId: refund.id, amountCents: reversalCents, evidenceRef: refund.evidenceRef }); result = record; break;
    }
    case 'request_withdrawal': {
      money(command.amountCents, '提现金额', MIN_WITHDRAWAL_CENTS); identifier(command.recipientRef, '收款资料引用');
      const recipient = authority.recipient;
      requireValue(recipient?.verified === true && recipient.id === command.recipientRef && recipient.ownerId === actor.id && ['bank', 'wechat', 'alipay'].includes(recipient.method), 'RECIPIENT_NOT_VERIFIED', '收款资料必须由服务端核实归属和方式');
      const balance = rewardBalance(state, actor.id, now);
      requireValue(balance.debtCents === 0, 'REFUND_DEBT', '已有提现后退款负债，暂停新提现');
      requireValue(!balance.blockedReasons.includes('PAYOUT_RECONCILIATION_REQUIRED'), 'PAYOUT_RECONCILIATION_REQUIRED', '关联退款发生时人工打款结果未核实，暂停新提现');
      requireValue(balance.withdrawableCents >= command.amountCents, 'INSUFFICIENT_BALANCE', '可提现余额不足或尚在冷静期');
      let remaining = command.amountCents; const allocations = [];
      const rewards = state.rewards.filter(row => row.beneficiaryId === actor.id).sort((a, b) => a.createdAt.localeCompare(b.createdAt) || a.id.localeCompare(b.id));
      for (const reward of rewards) {
        const amounts = rewardAmounts(state, reward, nowMs);
        if (amounts.confirmed && !amounts.held && amounts.freeCents > 0 && remaining > 0) { const amountCents = Math.min(remaining, amounts.freeCents); allocations.push({ rewardId: reward.id, amountCents }); remaining -= amountCents; }
      }
      requireValue(remaining === 0, 'INSUFFICIENT_BALANCE', '可追溯余额不足');
      const withdrawal = { id: `wd-${hash(command.idempotencyKey).slice(0, 24)}`, beneficiaryId: actor.id, amountCents: command.amountCents, recipientRef: recipient.id, recipientMethod: recipient.method, recipientSnapshot: copy(recipient),
        status: 'submitted', allocations, createdAt: now, updatedAt: now, history: [{ status: 'submitted', at: now }], financeApproval: null, secretaryApproval: null, payout: null };
      state.withdrawals.push(withdrawal); emit('withdrawal_submitted', { beneficiaryId: actor.id, withdrawalId: withdrawal.id, amountCents: withdrawal.amountCents }); result = withdrawal; break;
    }
    case 'finance_review': {
      const row = withdrawalForAction(['finance']); requireValue(row.status === 'submitted', 'WITHDRAWAL_STATE_CONFLICT', '仅已申请提现可进入财务审核'); checkUnfrozen(row);
      row.financeApproval = { actorId: actor.id, at: now }; transition(row, 'reviewing'); emit('finance_reviewed', { beneficiaryId: row.beneficiaryId, withdrawalId: row.id }); result = row; break;
    }
    case 'secretary_approve': {
      const row = withdrawalForAction(['secretary_general']); requireValue(row.status === 'reviewing' && row.financeApproval, 'WITHDRAWAL_STATE_CONFLICT', '须先经过财务审核');
      requireValue(row.financeApproval.actorId !== actor.id, 'DISTINCT_APPROVERS_REQUIRED', '财务与秘书长必须由不同人员审批', 403); checkUnfrozen(row);
      row.secretaryApproval = { actorId: actor.id, at: now }; transition(row, 'awaiting_payment'); emit('secretary_approved', { beneficiaryId: row.beneficiaryId, withdrawalId: row.id }); result = row; break;
    }
    case 'reject_withdrawal': {
      const row = withdrawalForAction(['finance', 'secretary_general']); identifier(command.reason, '驳回原因');
      requireValue((actor.role === 'finance' && ['submitted', 'reviewing'].includes(row.status)) || (actor.role === 'secretary_general' && row.status === 'reviewing'), 'WITHDRAWAL_STATE_CONFLICT', '该状态不能审核驳回');
      transition(row, 'rejected', command.reason); row.rejection = { actorId: actor.id, reason: command.reason, at: now };
      emit('withdrawal_rejected', { beneficiaryId: row.beneficiaryId, withdrawalId: row.id, amountCents: row.amountCents, reason: command.reason }); result = row; break;
    }
    case 'record_payout': {
      const row = withdrawalForAction(['finance']), payout = copy(authority.payout);
      requireValue(payout?.verified === true, 'PAYOUT_NOT_VERIFIED', '只有已核实实际打款流水才能登记已打款'); identifier(payout.id, '实际打款流水'); identifier(payout.evidenceRef, '实际打款依据'); money(payout.amountCents, '实打金额', 1); money(payout.feeCents, '俱乐部承担手续费');
      requireValue(payout.withdrawalId === row.id && payout.recipientRef === row.recipientRef && payout.amountCents === row.amountCents, 'PAYOUT_MISMATCH', '打款金额、申请或收款资料不符');
      if (row.status === 'paid') { requireValue(hash(row.payout) === hash(payout), 'PAYOUT_CONFLICT', '已打款记录不能重复或修改'); result = row; break; }
      requireValue(row.status === 'awaiting_payment' && row.financeApproval && row.secretaryApproval, 'WITHDRAWAL_STATE_CONFLICT', '须完成双审批后登记打款');
      requireValue(row.secretaryApproval.actorId !== actor.id && row.financeApproval.actorId !== row.secretaryApproval.actorId, 'DISTINCT_APPROVERS_REQUIRED', '打款财务不能兼任秘书长审批人', 403);
      // A verified actual transfer must be accounted for even if its evidence arrives
      // after the refund. Never invent a failed transfer to free its reservation.
      if (!row.payoutReconciliationRequired) checkUnfrozen(row); const paidMs = instant(payout.paidAt, '实际打款时间');
      requireValue(paidMs >= instant(row.secretaryApproval.at, '秘书长审批时间') && paidMs <= nowMs, 'PAYOUT_MISMATCH', '实际打款时间不能早于批准或晚于当前时间');
      requireValue(!state.withdrawals.some(item => item.payout?.id === payout.id), 'PAYOUT_ALREADY_USED', '该打款流水已登记');
      row.payout = payout; row.payoutRegisteredAt = now;
      if (row.payoutReconciliationRequired) row.payoutReconciledAt = now;
      transition(row, 'paid'); emit('withdrawal_paid', { beneficiaryId: row.beneficiaryId, withdrawalId: row.id, amountCents: row.amountCents, feeCents: payout.feeCents, evidenceRef: payout.evidenceRef }); result = row; break;
    }
    case 'fail_payout': {
      const row = withdrawalForAction(['finance']); identifier(command.reason, '打款失败原因');
      requireValue(row.status === 'awaiting_payment', 'WITHDRAWAL_STATE_CONFLICT', '仅待打款提现可登记打款失败');
      const failure = authority.payoutFailure;
      requireValue(failure?.verified === true && failure.noMoneyMoved === true && failure.withdrawalId === row.id, 'PAYOUT_FAILURE_NOT_VERIFIED', '不确定是否已打款时须保留占用'); identifier(failure.evidenceRef, '失败核实依据');
      if (row.payoutReconciliationRequired) row.payoutReconciledAt = now;
      transition(row, 'failed', command.reason); row.failure = { actorId: actor.id, reason: command.reason, at: now, evidence: copy(failure) };
      emit('withdrawal_failed', { beneficiaryId: row.beneficiaryId, withdrawalId: row.id, amountCents: row.amountCents, reason: command.reason, evidenceRef: failure.evidenceRef }); result = row; break;
    }
  }
  state.revision += 1;
  state.commands.push({ idempotencyKey: command.idempotencyKey, fingerprint, type: command.type, at: now, actorId: actor?.id ?? authority.service, result: copy(result) });
  validateState(state); return { state, result: copy(result) };
}

// Accounting month is Beijing time. This query preserves ledger entries; it does not transfer money.
export function buildRewardStatement(state, { beneficiaryId, month }) {
  validateState(state); identifier(beneficiaryId, '受益人'); requireValue(typeof month === 'string' && /^\d{4}-(0[1-9]|1[0-2])$/.test(month), 'INVALID_MONTH', '账单月份不正确', 400);
  const [year, monthNumber] = month.split('-').map(Number); requireValue(year >= 1970 && year <= 9998, 'INVALID_MONTH', '账单年份不正确', 400);
  const begin = Date.UTC(year, monthNumber - 1, 1) - 8 * 60 * 60 * 1000, end = Date.UTC(year, monthNumber, 1) - 8 * 60 * 60 * 1000;
  const entries = state.events.filter(row => row.beneficiaryId === beneficiaryId && instant(row.at, '流水时间') >= begin && instant(row.at, '流水时间') < end).map(copy);
  const sum = type => add(entries.filter(row => row.type === type).map(row => row.amountCents ?? 0));
  const nextMonth = new Date(Date.UTC(year, monthNumber, 1)).toISOString().slice(0, 7);
  return { beneficiaryId, month, timezone: 'Asia/Shanghai', startAt: new Date(begin).toISOString(), endAtExclusive: new Date(end).toISOString(),
    statementDueDate: `${nextMonth}-05`, payoutDueDate: `${nextMonth}-15`, earnedCents: sum('reward_accrued'), confirmedCents: sum('reward_confirmed'), reversedCents: sum('reward_reversed'), paidCents: sum('withdrawal_paid'),
    feesCoveredByClubCents: add(entries.filter(row => row.type === 'withdrawal_paid').map(row => row.feeCents ?? 0)), entries,
    openingBalance: rewardBalance(state, beneficiaryId, new Date(begin - 1).toISOString()), closingBalance: rewardBalance(state, beneficiaryId, new Date(end - 1).toISOString()) };
}
