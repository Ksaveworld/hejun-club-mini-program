import { useRef, useState, type FormEvent } from 'react';
import { api, errorText, type Order } from './api';

type Aftercare = {
  status: 'completed'; refundAmountCents: number; refundCompletedAt: string;
  membershipDisposition: 'terminate' | 'retain'; recordedAt: string;
};
type Recording = {
  externalRefundId: string; refundAmountCents: number; refundCompletedAt: string;
  evidenceReference: string; decisionReference: string; reason: string;
  membershipDisposition: 'terminate' | 'retain';
  attestation: 'externally_verified_refund_completed';
};

function centsFromInput(value: string): number {
  if (!/^(0|[1-9]\d*)(\.\d{1,2})?$/.test(value)) throw new Error('退款金额请填写大于零的数字，最多两位小数。');
  const [whole, fraction = ''] = value.split('.');
  const cents = Number(whole) * 100 + Number(fraction.padEnd(2, '0'));
  if (!Number.isSafeInteger(cents) || cents <= 0) throw new Error('退款金额超出可登记范围。');
  return cents;
}

export function AdminManualAftercare(props: { order: Order; onChanged: () => Promise<void> }) {
  return <AftercareForm key={props.order.id} {...props}/>;
}

function AftercareForm({ order, onChanged }: { order: Order; onChanged: () => Promise<void> }) {
  const [externalRefundId, setExternalRefundId] = useState('');
  const [amount, setAmount] = useState('');
  const [completedAt, setCompletedAt] = useState('');
  const [evidenceReference, setEvidenceReference] = useState('');
  const [decisionReference, setDecisionReference] = useState('');
  const [reason, setReason] = useState('');
  const [disposition, setDisposition] = useState<'' | 'terminate' | 'retain'>('');
  const [attested, setAttested] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [saved, setSaved] = useState<Aftercare | null>(null);
  const [refreshError, setRefreshError] = useState('');
  const [retryPending, setRetryPending] = useState(false);
  const inFlight = useRef(false);
  const pendingBody = useRef<Recording | null>(null);
  const receipt = saved || order.aftercare;

  async function refresh() {
    setRefreshError('');
    try { await onChanged(); }
    catch { setRefreshError('售后处理已保存，但订单列表刷新失败。可再次刷新，无需重复登记。'); }
  }

  async function submit(event: FormEvent) {
    event.preventDefault();
    if (inFlight.current || receipt) return;
    inFlight.current = true; setBusy(true); setError('');
    try {
      if (!pendingBody.current) {
        if (!attested || !disposition) throw new Error('请核对退款凭据，明确选择会员资格处理方式并勾选确认。');
        const refundAmountCents = centsFromInput(amount);
        if (refundAmountCents > (order.actualPaidCents ?? 0)) throw new Error('登记的退款金额不能超过本订单实际付款金额。');
        const completed = new Date(completedAt);
        if (!completedAt || !Number.isFinite(completed.getTime()) || completed.getTime() > Date.now()) throw new Error('请填写已实际完成的退款时间。');
        if (![externalRefundId, evidenceReference, decisionReference, reason].every(value => value.trim())) throw new Error('请完整填写退款单号、凭据索引、处理依据和说明。');
        pendingBody.current = {
          externalRefundId: externalRefundId.trim(), refundAmountCents, refundCompletedAt: completed.toISOString(),
          evidenceReference: evidenceReference.trim(), decisionReference: decisionReference.trim(), reason: reason.trim(),
          membershipDisposition: disposition, attestation: 'externally_verified_refund_completed',
        };
      }
      const result = await api<{ aftercare: Aftercare }>(`/admin/orders/${encodeURIComponent(order.id)}/manual-aftercare`, pendingBody.current);
      if (!result.aftercare || result.aftercare.status !== 'completed') throw new Error('保存结果尚未确认，请用原信息重试核对。');
      setSaved(result.aftercare); setRetryPending(false); pendingBody.current = null;
      await refresh();
    } catch (err) {
      const status = (err as { status?: number } | null)?.status;
      if (status && status >= 400 && status < 500) pendingBody.current = null;
      setRetryPending(!!pendingBody.current);
      setError(errorText(err));
    } finally { inFlight.current = false; setBusy(false); }
  }

  if (receipt) return <section className="inline-note" aria-label="退款后会员处理结果">
    <h4>退款后会员处理已记录</h4>
    <p>退款金额：¥{(receipt.refundAmountCents / 100).toFixed(2)}；退款完成时间：{new Date(receipt.refundCompletedAt).toLocaleString('zh-CN')}</p>
    <p>{receipt.membershipDisposition === 'terminate' ? '该订单对应的会员资格已终止，报告全文按当前有效会员权限判断。' : '按核准的处理结果保留该订单对应的会员资格，原有效期不变。'}</p>
    {refreshError && <><p role="alert">{refreshError}</p><button type="button" className="text-button" disabled={busy} onClick={() => void refresh()}>刷新订单列表</button></>}
  </section>;
  if (!order.manualAftercareAvailable || order.status !== 'paid') return null;

  return <details className="form-panel"><summary>登记退款结果并处理会员资格</summary>
    <p>仅用于已在微信后台完成并核实买家到账的安卓退款。本操作记录售后结果、同步会员及报告权限，不发起退款、不划款。</p>
    <form onSubmit={submit}>
      <fieldset disabled={busy || retryPending}>
        <label className="field"><span>微信退款单号</span><input required maxLength={128} value={externalRefundId} onChange={e => setExternalRefundId(e.target.value)}/></label>
        <label className="field"><span>实际退款金额（元）</span><input required inputMode="decimal" maxLength={20} value={amount} onChange={e => setAmount(e.target.value)} placeholder="按已完成退款的实际金额填写"/></label>
        <label className="field"><span>退款完成时间（当前设备时区）</span><input required type="datetime-local" step="1" value={completedAt} onChange={e => setCompletedAt(e.target.value)}/></label>
        <label className="field"><span>已核实退款凭据的内部索引</span><input required maxLength={500} value={evidenceReference} onChange={e => setEvidenceReference(e.target.value)} placeholder="便于日后查回原订单与退款到账凭据"/></label>
        <label className="field"><span>已核准会员处理的依据</span><input required maxLength={500} value={decisionReference} onChange={e => setDecisionReference(e.target.value)} placeholder="填写适用协议或核准记录索引"/></label>
        <label className="field"><span>会员资格处理</span><select required value={disposition} onChange={e => setDisposition(e.target.value as typeof disposition)}><option value="">请选择已核准的处理结果</option><option value="terminate">终止该订单对应的会员资格</option><option value="retain">保留该订单对应的会员资格</option></select></label>
        <label className="field"><span>处理说明</span><input required maxLength={500} value={reason} onChange={e => setReason(e.target.value)}/></label>
        <label className="consent"><input required type="checkbox" checked={attested} onChange={e => setAttested(e.target.checked)}/><span>我已核实退款已完成并到账买家，原订单、退款金额及凭据一致，会员处理符合已核准的原有处理依据。</span></label>
      </fieldset>
      {error && <p className="field-error" role="alert">{error}</p>}
      {retryPending && <p role="status">保存结果尚未确认，已保留本次信息。请用原信息重试核对。</p>}
      <button className="button primary" disabled={busy}>{busy ? '正在保存…' : retryPending ? '用原信息重试核对' : '确认记录并同步会员权限'}</button>
    </form>
  </details>;
}
