import { useEffect, useRef, useState } from 'react';
import { api, errorText, type Session } from './api';
interface PostVersion { revision: number; title: string; body: string; status: 'pending' | 'published' | 'rejected'; reason?: string | null; createdAt?: string; reviewedAt?: string | null; current?: boolean }
interface ReviewPost extends Omit<PostVersion, 'revision'> { id: string; userId: string; revision?: number; versioning?: boolean; publishedRevision?: number | null;
  publishedVersion?: PostVersion | null; versions?: PostVersion[]; removalReason?: string | null; removedAt?: string | null }
interface ReviewAttempt { userId: string; id: string; body: { status?: string; action?: string; reason: string; revision?: number; publishedRevision?: number }; key: string }
const statusLabels = { pending: '待审核', published: '已审核通过', rejected: '已退回' };
const dateLabel = (value?: string | null) => value ? new Date(value).toLocaleString('zh-CN', { timeZone: 'Asia/Shanghai', hour12: false }) : '未审核';

export function AdminPostRevisions({ userId }: { userId: string }) {
  const [posts, setPosts] = useState<ReviewPost[]>([]), [selected, setSelected] = useState<ReviewPost | null>(null), [reason, setReason] = useState('');
  const [busy, setBusy] = useState(false), [loading, setLoading] = useState(false), [ready, setReady] = useState(false), [error, setError] = useState(''), [message, setMessage] = useState('');
  const [waiting, setWaiting] = useState(false), pending = useRef<ReviewAttempt | null>(null), generation = useRef(0), lock = useRef(false), owner = useRef(userId); owner.current = userId;
  const active = (stamp: number) => generation.current === stamp && owner.current === userId && !document.hidden;
  function clearView() { setPosts([]); setSelected(null); setReason(''); setReady(false); setMessage(''); }
  async function identity(stamp: number) {
    if (!active(stamp)) return false;
    const session = await api<Session>('/me');
    if (!active(stamp)) return false;
    if (session.user?.id !== userId || session.user.role !== 'admin') throw Object.assign(new Error('登录账号已变化，请重新打开投稿审核。'), { status: 401 });
    return true;
  }
  function fail(err: unknown) {
    const status = (err as { status?: number })?.status;
    if (status === 401 || status === 403) { clearView(); if (status === 401) { pending.current = null; setWaiting(false); } }
    setError(errorText(err));
  }
  async function load(stamp = generation.current) {
    if (!active(stamp)) return; setLoading(true); clearView(); setError('');
    try {
      if (!await identity(stamp)) return;
      const result = await api<{ posts: ReviewPost[] }>('/admin/posts');
      if (!await identity(stamp)) return;
      if (!Array.isArray(result.posts)) throw new Error('稿件列表未能完整读取，请刷新重试。');
      setPosts(result.posts); setReady(true); setWaiting(pending.current?.userId === userId);
    } catch (err) { if (active(stamp)) fail(err); }
    finally { if (active(stamp)) setLoading(false); }
  }
  useEffect(() => {
    generation.current++; lock.current = false;
    if (pending.current?.userId !== userId) pending.current = null;
    setWaiting(!!pending.current); setBusy(false); setLoading(false); clearView(); void load();
    const visible = () => { generation.current++; lock.current = false; clearView(); setBusy(false); setLoading(false); if (!document.hidden) void load(); };
    document.addEventListener('visibilitychange', visible);
    return () => { generation.current++; lock.current = false; document.removeEventListener('visibilitychange', visible); };
  }, [userId]);
  async function send(attempt: ReviewAttempt) {
    const stamp = generation.current;
    if (lock.current || !active(stamp) || attempt.userId !== userId) return;
    lock.current = true; setBusy(true); setError(''); setMessage('');
    try {
      if (!await identity(stamp)) return;
      const result = await api<{ ok?: boolean; post?: ReviewPost }>(`/admin/posts/${encodeURIComponent(attempt.id)}/review`, attempt.body, attempt.key);
      if (!await identity(stamp)) return;
      if (result.ok !== true || (result.post && result.post.id !== attempt.id)) throw new Error('审核回执未确认，请使用原记录重试。');
      pending.current = null; setWaiting(false); setReason('');
      await load(stamp);
      if (active(stamp)) setMessage(attempt.body.action === 'remove' ? '公开版本已下架，历史稿件与审核记录保留。' : attempt.body.status === 'published' ? '稿件审核通过，注册用户可读取该公开版本。' : '退回原因已保存。若有已公开旧版，旧版仍继续可读。');
    } catch (err) {
      if (active(stamp)) {
        const status = (err as { status?: number })?.status;
        if (status && status >= 400 && status < 500 && status !== 403) { pending.current = null; setWaiting(false); }
        else { setWaiting(!!pending.current); setMessage('本次审核未取得成功回执，请重试确认原记录，避免对其他版本重复操作。'); }
        fail(err);
      }
    } finally { if (active(stamp)) { lock.current = false; setBusy(false); } }
  }
  function review(action: 'approve' | 'reject' | 'remove') {
    if (!selected || waiting || busy || loading) return;
    if (action !== 'approve' && !reason.trim()) { setError('请填写具体退回或下架原因，便于作者处理。'); return; }
    const body = { ...(action === 'remove' && selected.versioning ? { action: 'remove', publishedRevision: selected.publishedRevision ?? undefined } : { status: action === 'approve' ? 'published' : 'rejected' }),
      reason: action === 'approve' ? '' : reason.trim(), ...(selected.versioning ? { revision: selected.revision } : {}) };
    const attempt = { userId, id: selected.id, body, key: crypto.randomUUID() }; pending.current = attempt; setWaiting(true); void send(attempt);
  }
  const publicVersion = selected?.publishedVersion ?? (selected?.status === 'published' && !selected.versioning ? selected : null);
  const disabled = busy || loading || waiting;
  return <section aria-label="投稿与修改复审"><div className="business-row"><div><h2>投稿与修改复审</h2><p>审核新稿时，原已通过并公开的版本继续可读。退回修改稿只影响新版本。</p></div><button className="button secondary" disabled={busy || loading} onClick={() => void load()}>刷新稿件</button></div>
    {error && <p role="alert">{error}</p>}{message && <p role="status">{message}</p>}{loading && <p role="status">正在核对身份并读取稿件…</p>}
    {!loading && !ready && <p>稿件尚未读取成功，请刷新重试。</p>}
    {ready && waiting && pending.current && <section className="form-panel"><h3>本次审核回执待确认</h3><p className="mono small">稿件编号：{pending.current.id} · 版本：{pending.current.body.revision ?? '现有单版'}</p><p>重试使用同一版本、原因和提交编号；确认前不能处理另一份稿件。</p><button className="button primary" disabled={busy || loading} onClick={() => { if (pending.current) void send(pending.current); }}>重试确认本次审核</button></section>}
    {ready && posts.length === 0 && <p>暂无投稿。</p>}
    <div className="business-admin-list">{posts.map(post => <article className="form-panel" key={post.id}><div className="business-row"><h3>{post.title}</h3><span>{statusLabels[post.status]}{post.revision ? ` · 版本 ${post.revision}` : ''}</span></div>
      <p className="mono small">{post.id}</p>{post.publishedVersion && post.publishedVersion.revision !== post.revision && <p>原公开版本{post.publishedVersion.revision}继续可读，等待当前修改稿审核。</p>}
      {post.reason && <p>最近审核说明：{post.reason}</p>}<button className="button secondary" disabled={disabled} onClick={() => { setSelected(post); setReason(''); setError(''); setMessage(''); }}>核对版本并处理</button></article>)}</div>
    {selected && <section className="form-panel"><h3>当前提交版本{selected.revision ? ` ${selected.revision}` : ''} · {statusLabels[selected.status]}</h3><p className="mono small">{selected.id}</p>
      {!selected.versioning && <p>当前为单版审核。修改复审尚未初始化，原有投稿与审核仍可处理。</p>}
      <h4>{selected.title}</h4><p style={{ whiteSpace: 'pre-wrap', overflowWrap: 'anywhere' }}>{selected.body}</p>
      <p>审核时间：{dateLabel(selected.reviewedAt)}</p>{selected.reason && <p>审核说明：{selected.reason}</p>}
      {publicVersion && <section className="form-panel"><h4>目前公开的{publicVersion.revision ? `版本 ${publicVersion.revision}` : '稿件'}</h4><p>{publicVersion.title}</p><p style={{ whiteSpace: 'pre-wrap', overflowWrap: 'anywhere' }}>{publicVersion.body}</p><p>该版本不会因退回修改稿而覆盖或下架。</p></section>}
      {selected.removalReason && <p>最近公开版本下架原因：{selected.removalReason}</p>}
      {(selected.status === 'pending' || publicVersion) && <fieldset disabled={disabled}><label className="field"><span>退回修改稿或下架公开版本的原因（作者可见）</span><textarea maxLength={500} rows={3} value={reason} onChange={event => setReason(event.target.value)} /></label><div className="business-actions">
        {selected.status === 'pending' && <><button className="button primary" onClick={() => review('approve')}>通过当前版本并公开</button><button className="button secondary" onClick={() => review('reject')}>{publicVersion ? '退回修改稿，保留旧公开版' : '退回当前稿并说明原因'}</button></>}
        {publicVersion && <button className="button secondary" onClick={() => review('remove')}>按所填原因下架公开版本</button>}
      </div></fieldset>}
      {selected.versions && <details><summary>查看版本与审核历史</summary>{selected.versions.map(version => <article className="form-panel" key={version.revision}><h4>版本 {version.revision} · {version.status === 'pending' && !version.current ? '历史待审稿，已被后续版本替代' : statusLabels[version.status]}</h4><p>{version.title}</p><p style={{ whiteSpace: 'pre-wrap', overflowWrap: 'anywhere' }}>{version.body}</p><p>审核时间：{dateLabel(version.reviewedAt)}</p>{version.reason && <p>审核说明：{version.reason}</p>}</article>)}</details>}
    </section>}
  </section>;
}
