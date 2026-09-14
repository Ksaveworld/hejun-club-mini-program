import { useEffect, useRef, useState } from 'react';
import { api, errorText } from './api';
type Application = { id: string; contact: string; introduction: string; status: string; staffNote: string; revision: number; createdAt: string };
export function AmbassadorApplication() {
  const [application, setApplication] = useState<Application | null>(null), [canApply, setCanApply] = useState(false), [ready, setReady] = useState(false);
  const [contact, setContact] = useState(''), [introduction, setIntroduction] = useState(''), [consent, setConsent] = useState(false), [busy, setBusy] = useState(false), [error, setError] = useState('');
  const key = useRef(crypto.randomUUID());
  useEffect(() => { let alive = true; void api<{ application: Application | null; canApply: boolean }>('/ambassador').then(r => { if (alive) { setApplication(r.application); setCanApply(r.canApply); setReady(true); } }).catch(e => { if (alive) setError(errorText(e)); }); return () => { alive = false; }; }, []);
  async function apply() {
    if (busy) return; setBusy(true); setError('');
    try { setApplication((await api<{ application: Application }>('/ambassador', { contact, introduction, consent }, key.current)).application); }
    catch (e) { setError(errorText(e)); } finally { setBusy(false); }
  }
  return <section className="form-panel"><span className="eyebrow">连接更多跨境同行</span><h2>申请成为推荐大使</h2><p>留下联系信息和推荐意向，运营人员将跟进申请。</p>
    {error && <p className="field-error" role="alert">{error}</p>}
    {application ? <><strong>{application.status === 'pending' ? '申请已收到，待联系' : '已有跟进记录'}</strong><p>联系信息：{application.contact}</p>{application.staffNote && <p>跟进说明：{application.staffNote}</p>}<p className="small muted">申请编号：{application.id}</p></>
      : !ready ? <p>正在读取申请状态…</p> : !canApply ? <p>有效付费会员可以提交申请。<a href="#/members">查看会员权益</a></p>
      : <form onSubmit={e => { e.preventDefault(); void apply(); }}><fieldset disabled={busy} style={{ border: 0, padding: 0 }}><label className="field"><span>联系微信或电话</span><input required maxLength={100} value={contact} onChange={e => setContact(e.target.value)}/></label><label className="field"><span>推荐意向（选填）</span><textarea maxLength={500} rows={3} value={introduction} onChange={e => setIntroduction(e.target.value)}/></label><label className="consent"><input type="checkbox" required checked={consent} onChange={e => setConsent(e.target.checked)}/>同意保存申请信息，以便运营人员联系</label><button className="button primary">{busy ? '正在提交…' : '提交大使申请'}</button></fieldset></form>}
    <p className="small muted">本次为申请登记，尚未开始计奖。奖励与结算以正式开放时的规则为准。</p>
  </section>;
}
export function AdminAmbassadors() {
  const [items, setItems] = useState<Application[]>([]), [next, setNext] = useState<number | null>(null), [notes, setNotes] = useState<Record<string, string>>({}), [busy, setBusy] = useState(false), [error, setError] = useState('');
  const active = useRef(true);
  async function load(cursor?: number) {
    try { const r = await api<{ applications: Application[]; next: number | null }>('/admin/ambassadors' + (cursor ? '?before=' + cursor : '')); if (active.current) { setItems(r.applications); setNext(r.next); } }
    catch (e) { if (active.current) setError(errorText(e)); }
  }
  useEffect(() => { active.current = true; void load(); return () => { active.current = false; }; }, []);
  async function follow(item: Application) {
    if (busy) return; setBusy(true); setError('');
    try { const r = await api<{ application: Application }>('/admin/ambassadors/' + item.id, { note: notes[item.id] || '', revision: item.revision }); if (active.current) setItems(old => old.map(row => row.id === item.id ? r.application : row)); }
    catch (e) { if (active.current) setError(errorText(e)); } finally { if (active.current) setBusy(false); }
  }
  return <details className="form-panel"><summary>推荐大使申请与跟进</summary>{error && <p role="alert">{error}</p>}{!items.length && <p>暂无申请。</p>}{items.map(item => <article key={item.id}><h3>{item.contact}</h3><p>{item.introduction || '未填写推荐意向'}</p><p>{item.status === 'pending' ? '待联系' : '已跟进'} · {item.staffNote}</p><label className="field"><span>会员可见的跟进说明</span><textarea rows={2} maxLength={500} value={notes[item.id] || ''} onChange={e => setNotes({ ...notes, [item.id]: e.target.value })}/></label><button className="button secondary" disabled={busy} onClick={() => void follow(item)}>记录跟进</button></article>)}{next && <button disabled={busy} onClick={() => void load(next)}>下一页申请</button>}<button className="text-button" disabled={busy} onClick={() => void load()}>刷新最新申请</button></details>;
}
