export type RewardStaffRole = 'finance' | 'secretary_general';
export type RewardStaffAction = 'finance-review' | 'secretary-approve' | 'reject' | 'payout' | 'failure';
export type RewardActionBody = Record<string, string | number | boolean>;
export interface RewardAttempt { userId: string; role: RewardStaffRole; withdrawalId: string; action: RewardStaffAction; body: RewardActionBody; key: string }
type AdminSession = { user: { id: string; role: string } | null };

export class RewardIdentityError extends Error {
  readonly status = 401;
  constructor() { super('登录账号已变化，请重新打开奖励与提现管理。'); }
}

// Check the session on both sides of a read or mutation. Hidden/unmounted/changed
// views discard the response and do not perform a stale follow-up session request.
export async function guardedRewardTask<T>(userId: string, active: () => boolean,
  session: () => Promise<AdminSession>, work: () => Promise<T>): Promise<T | undefined> {
  async function current() {
    if (!active()) return false;
    const value = await session();
    if (!active()) return false;
    if (value.user?.id !== userId || value.user.role !== 'admin') throw new RewardIdentityError();
    return true;
  }
  if (!await current()) return;
  const output = await work();
  if (!await current()) return;
  return output;
}

export class RewardViewGate {
  private revision = 0;
  private userId = '';
  private role: RewardStaffRole = 'finance';
  enter(userId: string, role: RewardStaffRole) {
    this.userId = userId; this.role = role; return { userId, role, revision: ++this.revision };
  }
  invalidate() { this.revision++; }
  active(scope: { userId: string; role: RewardStaffRole; revision: number }) {
    return scope.revision === this.revision && scope.userId === this.userId && scope.role === this.role;
  }
}

// Only unresolved request metadata remains in memory across a same-user remount.
// No storage, account details, list rows or credentials are retained here.
export class RewardAttemptStore {
  private attempts = new Map<string, RewardAttempt>();
  peek(userId: string) { return this.attempts.get(userId); }
  clear(userId: string) { this.attempts.delete(userId); }
  clearExcept(userId: string) { for (const id of this.attempts.keys()) if (id !== userId) this.attempts.delete(id); }
  begin(input: Omit<RewardAttempt, 'key'>, createKey: () => string) {
    const old = this.attempts.get(input.userId);
    if (old) {
      const same = old.role === input.role && old.withdrawalId === input.withdrawalId && old.action === input.action && JSON.stringify(old.body) === JSON.stringify(input.body);
      if (!same) throw new Error('上一操作的结果尚未确认，请先重试确认原记录，再提交新操作。');
      return old;
    }
    const value = Object.freeze({ ...input, body: Object.freeze({ ...input.body }), key: createKey() });
    this.attempts.set(input.userId, value); return value;
  }
  acknowledge(userId: string, key: string) { if (this.attempts.get(userId)?.key === key) this.attempts.delete(userId); }
}

export function rewardFeeCents(input: string) {
  const value = input.trim();
  if (!/^(0|[1-9]\d*)(\.\d{1,2})?$/.test(value)) throw new Error('请填写实际手续费，最多两位小数；没有手续费填写0。');
  const [whole, fraction = ''] = value.split('.'), cents = BigInt(whole) * 100n + BigInt(fraction.padEnd(2, '0'));
  if (cents > BigInt(Number.MAX_SAFE_INTEGER)) throw new Error('手续费金额过大，请核对账单。');
  return Number(cents);
}
function required(value: string, label: string, max = 240) {
  const result = value.trim(); if (!result || result.length > max) throw new Error(`请填写${label}（不超过${max}字）。`); return result;
}
function actualTime(value: string, now: number) {
  const parts = /^(\d{4})-(0[1-9]|1[0-2])-(0[1-9]|[12]\d|3[01])T([01]\d|2[0-3]):([0-5]\d)(?::([0-5]\d)(?:\.\d{1,3})?)?(?:Z|[+-](?:[01]\d|2[0-3]):[0-5]\d)?$/.exec(value);
  if (!parts) return false;
  const year = Number(parts[1]), month = Number(parts[2]), day = Number(parts[3]);
  if (year < 1970 || day > new Date(Date.UTC(year, month, 0)).getUTCDate()) return false;
  return Number.isFinite(Date.parse(value)) && Date.parse(value) <= now;
}

export function rewardActionBody(action: RewardStaffAction, role: RewardStaffRole, fields: {
  reason?: string; reference?: string; evidenceRef?: string; paidAt?: string; fee?: string; confirmedPaid?: boolean; confirmedNoMoneyMoved?: boolean;
}, now = Date.now()): RewardActionBody {
  if (action === 'finance-review') {
    if (role !== 'finance') throw new Error('请切换到财务审核。'); return {};
  }
  if (action === 'secretary-approve') {
    if (role !== 'secretary_general') throw new Error('请切换到秘书长审批。'); return {};
  }
  if (action === 'reject') return { role, reason: required(fields.reason ?? '', '驳回原因') };
  if (role !== 'finance') throw new Error('实际打款结果由财务核实并登记。');
  if (action === 'failure') {
    if (fields.confirmedNoMoneyMoved !== true) throw new Error('请先核实确实没有转出款项，再勾选确认。结果不明确时保留原申请。');
    return { confirmedNoMoneyMoved: true, reason: required(fields.reason ?? '', '未打款或失败原因'), evidenceRef: required(fields.evidenceRef ?? '', '核实未出款的依据编号') };
  }
  if (fields.confirmedPaid !== true) throw new Error('请先查到真实出款记录并核对金额、收款人，再勾选确认。');
  const reference = required(fields.reference ?? '', '实际转账流水号'), evidenceRef = required(fields.evidenceRef ?? '', '实际打款凭证编号');
  const paidAt = fields.paidAt?.trim();
  if (!paidAt || !actualTime(paidAt, now)) throw new Error('请填写已发生的实际打款时间，不能填写不存在的日期或未来时间。');
  return { confirmedPaid: true, reference, evidenceRef, paidAt: new Date(paidAt).toISOString(), feeCents: rewardFeeCents(fields.fee ?? '') };
}

export function acknowledgedRewardAction(attempt: RewardAttempt, response: unknown) {
  const expected = { 'finance-review': 'reviewing', 'secretary-approve': 'awaiting_payment', reject: 'rejected', payout: 'paid', failure: 'failed' };
  const value = response as { withdrawal?: { id?: string; status?: string }; configured?: boolean; message?: string } | null;
  if (value?.configured === false) throw new Error(value.message || '奖励与提现规则尚未配置，这次操作没有取得成功回执。');
  if (value?.withdrawal?.id !== attempt.withdrawalId || value.withdrawal.status !== expected[attempt.action]) throw new Error('未取得对应操作的成功回执。请保留原记录并重试确认。');
  return value.withdrawal;
}

export function rewardAuthorizationLost(error: unknown) { return [401, 403].includes((error as { status?: number })?.status ?? 0); }
export function rewardDefinitelyRejected(error: unknown) {
  const status = (error as { status?: number })?.status;
  return typeof status === 'number' && status >= 400 && status < 500;
}
