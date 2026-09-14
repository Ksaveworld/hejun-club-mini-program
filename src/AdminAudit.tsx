import { useEffect, useRef, useState } from 'react';
import { api, errorText } from './api';
import type { Session } from './api';

interface Record { id: number; label: string; action: string; targetId: string; createdAt: string; actor: string; note?: string; revision?: number }
interface Result { records: Record[]; nextCursor: string | null }
export function AdminAudit({ userId }: { userId: string }) {
  const [group, setGroup] = useState('all'), [target, setTarget] = useState('');
  const [records, setRecords] = useState<Record[]>([]), [cursor, setCursor] = useState<string | null>(null);
  const [busy, setBusy] = useState(false), [error, setError] = useState(''), [ready, setReady] = useState(false);
  const generation = useRef(0), lock = useRef(false), applied = useRef({ group:'all', target:'' });
  async function identity() {
    const result = await api<Session>('/me');
    if (result.user?.id !== userId || result.user.role !== 'admin') throw new Error('登录状态已变化，请重新登录管理后台。');
  }
  async function load(more = false) {
    if (lock.current) return;
    lock.current = true; const stamp = generation.current;
    const filters = more ? applied.current : { group, target:target.trim() };
    setBusy(true); setError('');
    if (!more) { setRecords([]); setCursor(null); setReady(false); }
    try {
      await identity(); if (stamp !== generation.current) return;
      const params = new URLSearchParams(filters); if (more && cursor) params.set('before', cursor);
      const result = await api<Result>('/admin/audit?' + params);
      await identity(); if (stamp !== generation.current) return;
      applied.current = filters; setRecords(old => more ? [...old, ...result.records] : result.records);
      setCursor(result.nextCursor); setReady(true);
    } catch (err) { if (stamp === generation.current) { setRecords([]); setCursor(null); setReady(false); setError(errorText(err)); } }
    finally { if (stamp === generation.current) { lock.current = false; setBusy(false); } }
  }
  useEffect(() => { void load(); return () => { generation.current++; lock.current = false; }; }, [userId]);
  return <section aria-label="操作记录查询">
    <h2>操作记录</h2><p className="muted">查询已记录的处理人、时间与结果。记录按发生顺序展示，只读保留。</p>
    <form className="business-filters" onSubmit={event => { event.preventDefault(); void load(); }}>
      <label className="field"><span>订单或内容编号</span><input value={target} maxLength={80} disabled={busy} onChange={e=>setTarget(e.target.value)} placeholder="完整编号，可留空"/></label>
      <label className="field"><span id="audit-group-label">操作分类</span><select aria-labelledby="audit-group-label" value={group} disabled={busy} onChange={e=>setGroup(e.target.value)}>
        {[['all','全部操作'],['account','账号'],['order','订单'],['application','资质审核'],['post','文字投稿'],['article','资讯与知识'],['resource','服务资源'],['referral','推荐来源'],['payment','支付结果'],['feedback','帮助反馈']].map(([value,label])=><option value={value} key={value}>{label}</option>)}
      </select></label><button className="button primary" disabled={busy}>查询记录</button>
    </form>
    {error&&<p role="alert">{error}</p>}{busy&&<p role="status">正在读取操作记录…</p>}
    {ready&&!records.length&&<p>没有符合条件的操作记录。</p>}
    <div className="business-admin-list">{records.map(record=><article className="form-panel" key={record.id}>
      <div className="business-row"><h3>{record.label}</h3><time dateTime={record.createdAt}>{new Date(record.createdAt).toLocaleString('zh-CN')}</time></div>
      <p>处理人：{record.actor}</p><p className="small mono">关联编号：{record.targetId}</p>
      {record.revision&&<p>内容版本：{record.revision}</p>}{record.note&&<p>处理说明：{record.note}</p>}
    </article>)}</div>
    {cursor&&<button className="button secondary" disabled={busy} onClick={()=>void load(true)}>加载更早记录</button>}
  </section>;
}
