import { useEffect, useRef, useState } from 'react';
import type { FormEvent } from 'react';
import { api, errorText } from './api';
import type { Session } from './api';
import { plans } from './data';
import type { PlanId } from './types';
import './admin-articles.css';

type Access = { visibility: 'unconfigured' | 'public' | 'plans'; planIds: PlanId[] };
type Content = { title: string; summary: string; body: string; category: 'translation' | 'lectures' | 'directory' | 'visits'; access: Access; action: { type: 'unconfigured' | 'miniProgram' | 'phone'; appId?: string; path?: string; phoneNumber?: string } };
interface Resource extends Content { id: string; revision: number; status: 'draft' | 'published'; updatedAt: string }
const blank = (): Content => ({ title: '', summary: '', body: '', category: 'translation', action: { type: 'unconfigured' }, access: { visibility: 'unconfigured', planIds: [] } });
const fields = (a: Content): Content => ({ title: a.title, summary: a.summary, body: a.body, category: a.category, access: a.access, action: a.action });
function audience(access: Access) {
  return access.visibility === 'public' ? '所有访客（公开）' : access.visibility === 'plans'
    ? plans.filter(p => access.planIds.includes(p.id)).map(p => p.name).join('、') + '的有效会员' : '未配置，不能发布';
}
class ChangedSession extends Error {}

export function AdminServices({ userId }: { userId: string }) {
  const [items, setItems] = useState<Resource[]>([]), [selected, setSelected] = useState<Resource | null>(null);
  const [form, setForm] = useState<Content>(blank), [busy, setBusy] = useState(false), [ready, setReady] = useState(false);
  const [error, setError] = useState(''), [message, setMessage] = useState(''), [confirm, setConfirm] = useState<'publish' | 'unpublish' | null>(null);
  const [uncertain, setUncertain] = useState(false);
  const active = useRef(0), lock = useRef(false), key = useRef(crypto.randomUUID());
  const dirty = JSON.stringify(form) !== JSON.stringify(selected ? fields(selected) : blank());
  const published = selected?.status === 'published';
  async function checked() {
    const session = await api<Session>('/me');
    if (session.user?.id !== userId || session.user.role !== 'admin') throw new ChangedSession('登录状态已变化，请重新登录管理后台。');
  }
  function accept(item: Resource) {
    setSelected(item); setForm(fields(item)); setConfirm(null); setUncertain(false);
    setItems(list => [item, ...list.filter(a => a.id !== item.id)]); key.current = crypto.randomUUID();
  }
  async function run(work: (version: number) => Promise<void>) {
    if (lock.current) return;
    lock.current = true; const version = active.current; setBusy(true); setError(''); setMessage('');
    try { await checked(); if (version !== active.current) return; await work(version); }
    catch (err) {
      if (version !== active.current) return;
      if (err instanceof ChangedSession) { setItems([]); setSelected(null); setForm(blank()); setReady(false); setUncertain(false); }
      setConfirm(null); setError(errorText(err));
    } finally { if (version === active.current) { lock.current = false; setBusy(false); } }
  }
  function load() {
    return run(async version => {
      const result = await api<{ resources: Resource[] }>('/admin/resources');
      await checked(); if (version !== active.current) return;
      setItems(result.resources); setReady(true);
    });
  }
  useEffect(() => {
    void load();
    return () => { active.current++; lock.current = false; };
  }, [userId]);
  function choose(item: Resource | null) {
    if (busy || uncertain || (dirty && !window.confirm('放弃当前未保存的修改？'))) return;
    setSelected(item); setForm(item ? fields(item) : blank()); setConfirm(null); setError(''); setMessage(''); key.current = crypto.randomUUID();
  }
  async function save(event: FormEvent) {
    event.preventDefault(); if (published) return;
    if (!form.title.trim()) { setError('请填写标题。'); return; }
    if (form.access.visibility === 'plans' && !form.access.planIds.length) { setError('请选择至少一个会员档位。'); return; }
    await run(async version => {
      let result: { resource: Resource };
      try {
        result = await api<{ resource: Resource }>(selected ? '/admin/resources/' + selected.id : '/admin/resources',
          { ...form, ...(selected ? { revision: selected.revision } : {}) }, selected ? undefined : key.current);
        await checked();
      } catch (err) {
        // Keep an unknown creation outcome tied to the exact original payload and key.
        if (!selected && version === active.current && !(err instanceof Error && 'status' in err && Number(err.status) >= 400 && Number(err.status) < 500)) setUncertain(true);
        throw err;
      }
      if (version !== active.current) return;
      accept(result.resource); setMessage('草稿已保存，尚未发布。');
    });
  }
  async function transition() {
    if (!selected || !confirm || dirty) return;
    const action = confirm;
    await run(async version => {
      const result = await api<{ resource: Resource }>('/admin/resources/' + selected.id + '/' + action, { revision: selected.revision });
      await checked(); if (version !== active.current) return;
      accept(result.resource); setMessage(action === 'publish' ? '已发布，符合使用范围的用户刷新后可见。' : '已撤下，用户再次读取时将无法访问。');
    });
  }
  return <section className="article-management" aria-label="服务资源管理">
    <div className="business-row"><div><h2>服务资源</h2><p>先保存草稿，再核对使用范围并发布。</p></div><div className="business-actions">
      <button className="button secondary" disabled={busy || uncertain} onClick={() => choose(null)}>新建服务</button>
      <button className="button secondary" disabled={busy} onClick={() => void load()}>刷新服务列表</button>
    </div></div>
    {error && <p className="field-error" role="alert">{error}</p>}{message && <p role="status">{message}</p>}
    {uncertain && <p role="alert">保存结果尚未确认。请保持原文并重试保存，系统会核对同一次提交，避免重复创建。</p>}
    <div className="article-workspace">
      <div className="article-catalog" aria-label="服务列表">
        {!ready && <p>正在读取服务；若读取失败，请刷新重试。</p>}
        {ready && !items.length && <p>暂无服务，从右侧新建草稿开始。</p>}
        {items.map(item => <button key={item.id} className={'article-choice ' + (selected?.id === item.id ? 'active' : '')}
          disabled={busy || uncertain} onClick={() => choose(item)} aria-pressed={selected?.id === item.id}>
          <strong>{item.title}</strong><span>{{translation:'翻译',lectures:'课程',directory:'名录',visits:'参访'}[item.category]} · {item.status === 'draft' ? '草稿' : '已发布'}</span><small>{audience(item.access)}</small>
        </button>)}
      </div>
      <div className="form-panel article-editor">
        <h3>{selected ? '编辑服务' : '新建草稿'}</h3>
        {selected && <p className="small">{selected.status === 'draft' ? '草稿' : '已发布'} · 版本 {selected.revision} · {audience(selected.access)}</p>}
        {published && <p>请先撤下服务，再修改并重新发布。</p>}
        <form onSubmit={save}>
          <fieldset disabled={busy || published || uncertain}>
            <label className="field"><span id="article-title-label">服务标题</span><input aria-labelledby="article-title-label" required maxLength={80} value={form.title} onChange={e => setForm({ ...form, title: e.target.value })}/></label>
            <label className="field"><span id="article-category-label">服务分类</span><select aria-labelledby="article-category-label" value={form.category} onChange={e => setForm({ ...form, category: e.target.value as Content['category'] })}><option value="translation">翻译</option><option value="lectures">课程</option><option value="directory">名录</option><option value="visits">参访</option></select></label>
            <label className="field"><span id="article-summary-label">服务摘要</span><textarea aria-labelledby="article-summary-label" maxLength={180} rows={2} value={form.summary} onChange={e => setForm({ ...form, summary: e.target.value })}/></label>
            <label className="field"><span id="article-body-label">服务说明</span><textarea aria-labelledby="article-body-label" maxLength={4000} rows={10} value={form.body} onChange={e => setForm({ ...form, body: e.target.value })}/></label>
            <label className="field"><span>使用入口</span><select aria-label="使用入口" value={form.action.type} onChange={e => setForm({...form, action: {type:e.target.value as Content['action']['type']}})}>
              <option value="unconfigured">待配置（禁止发布）</option><option value="miniProgram">打开服务小程序</option><option value="phone">拨打服务电话</option>
            </select></label>
            {form.action.type === 'miniProgram' && <>
              <label className="field"><span>目标小程序 AppID</span><input aria-label="目标小程序 AppID" required maxLength={18} pattern="wx[a-f0-9]{16}" value={form.action.appId || ''} onChange={e => setForm({...form,action:{...form.action,appId:e.target.value}})}/></label>
              <label className="field"><span>小程序页面路径</span><input aria-label="小程序页面路径" maxLength={1024} value={form.action.path || ''} onChange={e => setForm({...form,action:{...form.action,path:e.target.value}})}/></label>
              <p className="small">留空打开对方首页。请先确认对方服务已发布、所选会员能实际使用，并在服务说明中写明提供方、使用方式及费用。</p>
            </>}
            {form.action.type === 'phone' && <label className="field"><span>服务电话</span><input aria-label="服务电话" required maxLength={24} type="tel" value={form.action.phoneNumber || ''} onChange={e => setForm({...form,action:{...form.action,phoneNumber:e.target.value}})}/></label>}
            <label className="field"><span id="article-access-label">使用范围</span><select aria-labelledby="article-access-label" value={form.access.visibility} onChange={e => setForm({ ...form, access: { visibility: e.target.value as Access['visibility'], planIds: [] } })}>
              <option value="unconfigured">待配置（禁止发布）</option><option value="public">所有访客（公开）</option><option value="plans">指定会员档位</option>
            </select></label>
            {form.access.visibility === 'plans' && <div className="article-plans">{plans.map(plan => <label key={plan.id}><input type="checkbox" checked={form.access.planIds.includes(plan.id)} onChange={e => setForm({ ...form, access: { ...form.access, planIds: e.target.checked ? [...form.access.planIds, plan.id] : form.access.planIds.filter(id => id !== plan.id) } })}/>{plan.name}</label>)}<p className="small">仅所选档位的有效会员可用，各档位不自动互通。</p></div>}
          </fieldset>
          {!published && <button className="button primary" disabled={busy} type="submit">{uncertain ? '重试保存草稿' : '保存草稿'}</button>}
        </form>
        {selected && <div className="business-actions">
          <button className="button secondary" disabled={busy || dirty || uncertain || (!published && (selected.access.visibility === 'unconfigured' || !selected.body.trim() || selected.action.type === 'unconfigured'))}
            onClick={() => setConfirm(published ? 'unpublish' : 'publish')}>{published ? '撤下服务' : '发布服务'}</button>
          <button className="text-button" disabled={busy || uncertain} onClick={() => {
            const latest = items.find(a => a.id === selected.id); if (latest) choose(latest);
          }}>重新载入所选服务</button>
        </div>}
        {dirty && selected && <p className="small">有未保存的修改，保存后才能发布。</p>}
        {confirm && selected && <div className="article-confirm" role="group" aria-label="确认服务操作">
          <p>{confirm === 'publish' ? '确认发布' : '确认撤下'}：{selected.title}</p><p>使用范围：{audience(selected.access)}</p><p>使用入口：{selected.action.type === 'miniProgram' ? selected.action.appId + (selected.action.path ? ' / ' + selected.action.path : '（首页）') : selected.action.phoneNumber}</p>
          <button className="button primary" disabled={busy} onClick={() => void transition()}>{confirm === 'publish' ? '确认发布' : '确认撤下'}</button>
          <button className="button secondary" disabled={busy} onClick={() => setConfirm(null)}>暂不操作</button>
        </div>}
      </div>
    </div>
  </section>;
}
