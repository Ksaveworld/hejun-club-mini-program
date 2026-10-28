import { useEffect, useRef, useState } from 'react';
import { api, errorText, type Session } from './api';
import { acknowledgedRewardAction, guardedRewardTask, rewardActionBody, rewardAuthorizationLost, rewardDefinitelyRejected, RewardAttemptStore, RewardViewGate,
  type RewardAttempt, type RewardStaffAction, type RewardStaffRole } from './reward-operations-state';

type WithdrawalStatus = 'submitted' | 'reviewing' | 'awaiting_payment' | 'paid' | 'rejected' | 'failed';
interface StaffWithdrawal { id: string; beneficiaryId: string; amountCents: number; status: WithdrawalStatus; createdAt?: string; updatedAt?: string;
  recipientMethod?: 'bank' | 'wechat' | 'alipay'; reason?: string; paidAt?: string | null; payoutReconciliationRequired?: boolean; payoutReconciledAt?: string | null }
interface StaffReward { id: string; orderId?: string; beneficiaryId: string; grossCents?: number; amountCents?: number; reversedCents?: number;
  confirmedAt?: string | null; maturityAt?: string; createdAt?: string; status?: string }
interface StaffPage { configured: boolean; message?: string; rewards: StaffReward[]; withdrawals: StaffWithdrawal[] }
const labels: Record<WithdrawalStatus, string> = { submitted: '已申请，待财务审核', reviewing: '财务已审核，待秘书长审批', awaiting_payment: '审批通过，待核实人工打款', paid: '已登记实际打款', rejected: '已驳回', failed: '失败或核实未出款' };
const roleLabels = { finance: '财务审核与打款登记', secretary_general: '秘书长审批' };
const actionLabels: Record<RewardStaffAction, string> = { 'finance-review': '财务审核', 'secretary-approve': '秘书长审批', reject: '驳回申请', payout: '登记实际打款', failure: '登记未出款或失败' };
const attempts = new RewardAttemptStore();
const money = (value?: number) => Number.isSafeInteger(value) && value! >= 0 ? `¥${(value! / 100).toFixed(2)}` : '金额待核对';
const time = (value?: string | null) => value && Number.isFinite(Date.parse(value)) ? new Date(value).toLocaleString('zh-CN', { timeZone: 'Asia/Shanghai', hour12: false }) : '未记录';

export function AdminRewards({ userId }: { userId: string }) {
  const [role, setRole] = useState<RewardStaffRole>('finance'), [page, setPage] = useState<StaffPage | null>(null);
  const [loading, setLoading] = useState(false), [busy, setBusy] = useState(false), [error, setError] = useState(''), [message, setMessage] = useState('');
  const [selected, setSelected] = useState<string | null>(null), [reason, setReason] = useState(''), [reference, setReference] = useState(''), [evidence, setEvidence] = useState('');
  const [paidAt, setPaidAt] = useState(''), [fee, setFee] = useState(''), [confirmedPaid, setConfirmedPaid] = useState(false), [confirmedNoMoneyMoved, setConfirmedNoMoneyMoved] = useState(false);
  const [pending, setPending] = useState<RewardAttempt | undefined>();
  const gate = useRef(new RewardViewGate()), lock = useRef(false), current = useRef({ userId, role });
  const scope = useRef({ userId, role, revision: 0 }); current.current = { userId, role };
  const isActive = (stamp: typeof scope.current) => !document.hidden && gate.current.active(stamp) && current.current.userId === stamp.userId && current.current.role === stamp.role;
  function clearForms() { setSelected(null); setReason(''); setReference(''); setEvidence(''); setPaidAt(''); setFee(''); setConfirmedPaid(false); setConfirmedNoMoneyMoved(false); }
  function clearSensitive() { setPage(null); clearForms(); setPending(undefined); setMessage(''); }
  function handleError(err: unknown) {
    if (rewardAuthorizationLost(err)) {
      if ((err as { status?: number }).status === 401) attempts.clear(userId);
      clearSensitive();
    }
    setError(errorText(err));
  }
  async function load(stamp = scope.current) {
    if (!isActive(stamp)) return; setLoading(true); setPage(null); setError('');
    try {
      const result = await guardedRewardTask(userId, () => isActive(stamp), () => api<Session>('/me'), () => api<StaffPage>(`/admin/rewards?role=${stamp.role}`));
      if (!isActive(stamp) || result === undefined) return;
      if (typeof result.configured !== 'boolean' || (result.configured && (!Array.isArray(result.rewards) || !Array.isArray(result.withdrawals)))) throw new Error('奖励与提现列表暂时未能完整读取，请刷新重试。');
      setPage(result.configured ? result : { ...result, rewards: [], withdrawals: [] }); setPending(attempts.peek(userId));
    } catch (err) { if (isActive(stamp)) handleError(err); }
    finally { if (isActive(stamp)) setLoading(false); }
  }
  useEffect(() => {
    attempts.clearExcept(userId); gate.current.invalidate(); scope.current = gate.current.enter(userId, role); lock.current = false;
    clearSensitive(); setBusy(false); setLoading(false); setError(''); void load(scope.current);
    const visibility = () => {
      gate.current.invalidate(); lock.current = false; clearSensitive(); setBusy(false); setLoading(false); setError('');
      if (!document.hidden) { scope.current = gate.current.enter(userId, role); void load(scope.current); }
    };
    document.addEventListener('visibilitychange', visibility);
    return () => { document.removeEventListener('visibilitychange', visibility); gate.current.invalidate(); lock.current = false; };
  }, [userId, role]);

  async function send(attempt: RewardAttempt) {
    const stamp = scope.current;
    if (lock.current || !isActive(stamp) || attempt.userId !== userId || attempt.role !== role) return;
    lock.current = true; setBusy(true); setError(''); setMessage('');
    try {
      const result = await guardedRewardTask(userId, () => isActive(stamp), () => api<Session>('/me'),
        () => api<unknown>(`/admin/rewards/withdrawals/${encodeURIComponent(attempt.withdrawalId)}/${attempt.action}`, attempt.body, attempt.key));
      if (!isActive(stamp) || result === undefined) return;
      acknowledgedRewardAction(attempt, result); attempts.acknowledge(userId, attempt.key); setPending(undefined); clearForms();
      setMessage(attempt.action === 'payout' ? '实际打款记录已保存。此页只登记已发生的结果，不会再次转款。' : attempt.action === 'secretary-approve' ? '秘书长审批已保存，仍需财务核实人工打款结果。' : `${actionLabels[attempt.action]}已保存。`);
      await load(stamp);
    } catch (err) {
      if (isActive(stamp)) {
        if (rewardAuthorizationLost(err)) {
          if ((err as { status?: number }).status === 401) attempts.clear(userId);
          clearSensitive();
        }
        else if (rewardDefinitelyRejected(err)) { attempts.acknowledge(userId, attempt.key); setPending(undefined); }
        else { setPending(attempts.peek(userId)); setMessage('本次操作未取得成功回执。请重试确认原记录，不要另做一笔打款登记。'); }
        setError(errorText(err));
      }
    } finally { if (isActive(stamp)) { lock.current = false; setBusy(false); } }
  }
  function submit(withdrawal: StaffWithdrawal, action: RewardStaffAction) {
    if (busy || loading || pending || !page?.configured) return;
    try {
      const body = rewardActionBody(action, role, { reason, reference, evidenceRef: evidence, paidAt, fee, confirmedPaid, confirmedNoMoneyMoved });
      const attempt = attempts.begin({ userId, role, withdrawalId: withdrawal.id, action, body }, () => crypto.randomUUID()); setPending(attempt); void send(attempt);
    } catch (err) { setError(errorText(err)); }
  }
  function select(id: string) { clearForms(); setSelected(id); setError(''); setMessage(''); }
  const withdrawal = page?.withdrawals.find(row => row.id === selected), disabled = busy || loading || !!pending;
  const activeWithdrawal = withdrawal && ['submitted', 'reviewing', 'awaiting_payment'].includes(withdrawal.status);
  const self = withdrawal?.beneficiaryId === userId;
  const canReject = withdrawal && (role === 'finance' ? ['submitted', 'reviewing'].includes(withdrawal.status) : withdrawal.status === 'reviewing');
  return <section aria-label="奖励与提现管理">
    <div className="business-row"><div><h2>奖励与提现</h2><p>财务先核对、秘书长再审批，财务在实际人工打款后登记结果。审批通过不代表已打款。</p></div>
      <button className="button secondary" disabled={busy || loading} onClick={() => { clearForms(); void load(); }}>刷新当前岗位列表</button></div>
    <div role="tablist" aria-label="提现处理岗位" className="business-actions">{(['finance', 'secretary_general'] as const).map(value => <button key={value} type="button" role="tab" aria-selected={role === value} aria-controls="reward-staff-panel" className={`button ${role === value ? 'primary' : 'secondary'}`} disabled={busy} onClick={() => setRole(value)}>{roleLabels[value]}</button>)}</div>
    <p className="small">岗位选择只用于查看对应流程。每次读取和操作都会由服务器核对您的当前授权；不能审核自己的提现，财务和秘书长须为不同人员。</p>
    {error && <p role="alert">{error}</p>}{message && <p role="status">{message}</p>}
    {loading && <p role="status">正在核对身份并读取{roleLabels[role]}列表…</p>}
    {!loading && !page && <p>列表尚未读取成功，请刷新重试，或切换到已获授权的岗位。</p>}
    {page?.configured === false && <p role="status">{page.message || '奖励与提现规则或工作人员授权尚未配置，当前不能计奖或处理提现。请由业务负责人提供已批准配置。'}</p>}
    {page?.configured && <div role="tabpanel" id="reward-staff-panel">
      {pending && <section className="form-panel" aria-label="待确认操作"><h3>上一操作的回执待确认</h3><p>{actionLabels[pending.action]} · 申请编号：<span className="mono">{pending.withdrawalId}</span></p>
        <p>重试会使用原来的内容和同一个记录编号，不会重新造一笔登记。确认完成前，其他操作暂时锁定。</p>
        {pending.action === 'payout' && <p>原实际转账流水号：{String(pending.body.reference)} · 原打款时间：{time(String(pending.body.paidAt))}</p>}
        {pending.role === role ? <button className="button primary" disabled={busy || loading} onClick={() => void send(pending)}>重试确认这次登记</button> : <button className="button secondary" disabled={busy || loading} onClick={() => setRole(pending.role)}>切回{roleLabels[pending.role]}确认原记录</button>}
      </section>}
      <h3>提现申请</h3>
      {page.withdrawals.length === 0 && <p>当前暂无提现申请。</p>}
      <div className="business-admin-list">{page.withdrawals.map(row => <article className="form-panel" key={row.id}><div className="business-row"><h4>{money(row.amountCents)}</h4><span>{labels[row.status] || '状态待核对'}</span></div>
        <p className="mono small">申请编号：{row.id}</p><p>申请人编号：{row.beneficiaryId} · 收款方式：{row.recipientMethod === 'bank' ? '银行卡' : row.recipientMethod === 'wechat' ? '微信' : row.recipientMethod === 'alipay' ? '支付宝' : '待核对'}</p>
        <p>申请时间：{time(row.createdAt)}{row.status === 'paid' && ` · 实际打款时间：${time(row.paidAt)}`}</p>{row.reason && <p>处理说明：{row.reason}</p>}
        {row.payoutReconciliationRequired && !row.payoutReconciledAt && <p role="status">关联订单发生退款，人工打款结果仍需核实。占用将保留，不能按未打款直接释放。</p>}
        <button className="button secondary" disabled={disabled} onClick={() => select(row.id)}>查看并处理</button></article>)}</div>
      {withdrawal && <section className="form-panel" aria-label="提现处理"><h3>处理申请：{money(withdrawal.amountCents)}</h3><p className="mono small">{withdrawal.id}</p><p>{labels[withdrawal.status]}</p>
        {self && <p role="alert">这是您本人的提现，须交由其他已授权工作人员处理。</p>}
        {!self && activeWithdrawal && <fieldset disabled={disabled}>
          {role === 'finance' && withdrawal.status === 'submitted' && <button type="button" className="button primary" onClick={() => submit(withdrawal, 'finance-review')}>核对申请，提交财务审核结果</button>}
          {role === 'secretary_general' && withdrawal.status === 'reviewing' && <><p>请核对财务审核结果。系统会阻止同一人兼任两次审批。</p><button type="button" className="button primary" onClick={() => submit(withdrawal, 'secretary-approve')}>批准申请，交财务人工打款</button></>}
          {canReject && <div><label className="field"><span>驳回原因（申请人可见）</span><textarea rows={3} maxLength={240} value={reason} onChange={event => setReason(event.target.value)} /></label><button type="button" className="button secondary" onClick={() => submit(withdrawal, 'reject')}>说明原因并驳回申请</button></div>}
          {role === 'finance' && withdrawal.status === 'awaiting_payment' && <><p>先在已核验的收款资料中核对申请人，再通过财务日常渠道人工打款。这里保存实际结果，不会转账。实打金额为{money(withdrawal.amountCents)}，手续费由俱乐部另行承担。</p>
            <form onSubmit={event => { event.preventDefault(); submit(withdrawal, 'payout'); }}>
              <h4>登记已经完成的人工打款</h4>
              <label className="field"><span>实际转账流水号</span><input required maxLength={240} autoComplete="off" value={reference} onChange={event => setReference(event.target.value)} /></label>
              <label className="field"><span>实际打款凭证编号（用于核对财务记录）</span><input required maxLength={240} autoComplete="off" value={evidence} onChange={event => setEvidence(event.target.value)} /></label>
              <label className="field"><span>实际打款时间（按当前设备时区填写）</span><input required type="datetime-local" step="1" value={paidAt} onChange={event => setPaidAt(event.target.value)} /></label>
              <label className="field"><span>实际手续费（元；没有手续费填写0）</span><input required inputMode="decimal" value={fee} onChange={event => setFee(event.target.value)} /></label>
              <label className="consent"><input type="checkbox" checked={confirmedPaid} onChange={event => setConfirmedPaid(event.target.checked)} />我已核对真实出款记录、收款人及申请金额，确认已经实际打款</label>
              <button className="button primary" disabled={!confirmedPaid}>保存实际打款记录</button>
            </form>
            <form onSubmit={event => { event.preventDefault(); submit(withdrawal, 'failure'); }}>
              <h4>登记核实未出款或打款失败</h4><p>不确定是否已扣款时请先核对，不要释放余额，也不要再次转款。</p>
              <label className="field"><span>未打款或失败原因</span><textarea required rows={3} maxLength={240} value={reason} onChange={event => setReason(event.target.value)} /></label>
              <label className="field"><span>核实未出款的依据编号</span><input required maxLength={240} autoComplete="off" value={evidence} onChange={event => setEvidence(event.target.value)} /></label>
              <label className="consent"><input type="checkbox" checked={confirmedNoMoneyMoved} onChange={event => setConfirmedNoMoneyMoved(event.target.checked)} />我已查明确实没有资金转出，可释放本次占用</label>
              <button className="button secondary" disabled={!confirmedNoMoneyMoved}>保存失败原因并释放占用</button>
            </form></>}
          {role === 'secretary_general' && withdrawal.status !== 'reviewing' && <p>当前申请无需秘书长审批；只有财务审核完成后才能批准。</p>}
          {role === 'finance' && withdrawal.status === 'reviewing' && <p>财务审核已完成，等待另一位已授权秘书长审批。</p>}
        </fieldset>}
        {!activeWithdrawal && <p>本次申请已经结束，处理记录保留；驳回或核实未出款后，申请人可修改收款资料并重新申请。</p>}
      </section>}
      <details className="form-panel"><summary>查看奖励明细</summary><p>奖励来源于核实订单；七天确认前及退款冻结期间不能提现。</p>
        {page.rewards.length === 0 ? <p>当前没有已记录的奖励。</p> : page.rewards.map(row => <article key={row.id}><h4>{money(row.grossCents ?? row.amountCents)}</h4><p className="mono small">奖励编号：{row.id}{row.orderId && ` · 订单：${row.orderId}`}</p><p>受益人编号：{row.beneficiaryId} · 已冲回：{money(row.reversedCents)}</p>
          <p>{row.confirmedAt ? `已确认 · ${time(row.confirmedAt)}` : `待确认 · 预计七天期满 ${time(row.maturityAt)}`}</p></article>)}
      </details>
    </div>}
  </section>;
}
