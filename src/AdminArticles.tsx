import { useEffect, useRef, useState } from 'react';
import type { FormEvent } from 'react';
import { api, errorText } from './api';
import { isWebTrial } from './web-env';
import type { Session } from './api';
import { plans } from './data';
import type { PlanId } from './types';
import './admin-articles.css';

type Access = { visibility: 'unconfigured' | 'public' | 'plans'; planIds: PlanId[]; previewPages?:number };
type Content = { title: string; summary: string; body: string; category: 'news' | 'knowledge'; access: Access };
interface Article extends Content { id: string; revision: number; status: 'draft' | 'published'; updatedAt: string; document?: {filename:string;bytes:number;pages:number;previewPages?:number}|null }
const blank = (): Content => ({ title: '', summary: '', body: '', category: 'news', access: { visibility: 'unconfigured', planIds: [] } });
const fields = (a: Content): Content => ({ title: a.title, summary: a.summary, body: a.body, category: a.category, access: a.access });
function audience(access: Access) {
  return access.visibility === 'public' ? '所有访客（公开）' : access.visibility === 'plans'
    ? plans.filter(p => access.planIds.includes(p.id)).map(p => p.name).join('、') + '的有效会员可读全文'+(access.previewPages?'；其他访客可试看前10页':'') : '未配置，不能发布';
}
class ChangedSession extends Error {}

export function AdminArticles({ userId }: { userId: string }) {
  const [items, setItems] = useState<Article[]>([]), [selected, setSelected] = useState<Article | null>(null);
  const [search,setSearch] = useState('');
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
  function accept(item: Article) {
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
      const result = await api<{ articles: Article[] }>('/admin/articles');
      await checked(); if (version !== active.current) return;
      setItems(result.articles); setReady(true);
    });
  }
  useEffect(() => {
    void load();
    return () => { active.current++; lock.current = false; };
  }, [userId]);
  function choose(item: Article | null) {
    if (busy || uncertain || (dirty && !window.confirm('放弃当前未保存的修改？'))) return;
    setSelected(item); setForm(item ? fields(item) : blank()); setConfirm(null); setError(''); setMessage(''); key.current = crypto.randomUUID();
  }
  async function save(event: FormEvent) {
    event.preventDefault(); if (published) return;
    if (!form.title.trim()) { setError('请填写标题。'); return; }
    if (form.access.visibility === 'plans' && !form.access.planIds.length) { setError('请选择至少一个会员档位。'); return; }
    await run(async version => {
      let result: { article: Article };
      try {
        result = await api<{ article: Article }>(selected ? '/admin/articles/' + selected.id : '/admin/articles',
          { ...form, ...(selected ? { revision: selected.revision } : {}) }, selected ? undefined : key.current);
        await checked();
      } catch (err) {
        // Keep an unknown creation outcome tied to the exact original payload and key.
        if (!selected && version === active.current) setUncertain(true);
        throw err;
      }
      if (version !== active.current) return;
      accept(result.article); setMessage('草稿已保存，尚未发布。');
    });
  }
  async function transition() {
    if (!selected || !confirm || dirty) return;
    const action = confirm;
    await run(async version => {
      const result = await api<{ article: Article }>('/admin/articles/' + selected.id + '/' + action, { revision: selected.revision });
      await checked(); if (version !== active.current) return;
      accept(result.article); setMessage(action === 'publish' ? '已发布，符合阅读范围的用户刷新后可见。' : '已撤下，用户再次读取时将无法访问。');
    });
  }
  return <section className="article-management" aria-label="资讯与知识管理">
    <div className="business-row"><div><h2>资讯与知识</h2><p>先保存草稿，再核对阅读范围并发布。</p></div><div className="business-actions">
      <button className="button secondary" disabled={busy || uncertain} onClick={() => choose(null)}>新建内容</button>
      <button className="button secondary" disabled={busy} onClick={() => void load()}>刷新内容列表</button>
    </div></div>
    {error && <p className="field-error" role="alert">{error}</p>}{message && <p role="status">{message}</p>}
    {uncertain && <p role="alert">保存结果尚未确认。请保持原文并重试保存，系统会核对同一次提交，避免重复创建。</p>}
    <div className="article-workspace">
      <div className="article-catalog" aria-label="内容列表">
        <label className="field"><span>搜索标题或文件名</span><input type="search" value={search} onChange={e=>setSearch(e.target.value)}/></label>
        {ready && <p>共 {items.length} 条内容 · {items.filter(i=>i.document).length} 份 PDF</p>}
        {!ready && <p>正在读取内容；若读取失败，请刷新重试。</p>}
        {ready && !items.length && <p>暂无内容，从右侧新建草稿开始。</p>}
        {items.filter(item=>(item.title+' '+(item.document?.filename||'')).toLowerCase().includes(search.trim().toLowerCase())).map(item => <button key={item.id} className={'article-choice ' + (selected?.id === item.id ? 'active' : '')}
          disabled={busy || uncertain} onClick={() => choose(item)} aria-pressed={selected?.id === item.id}>
          <strong>{item.title}</strong><span>{item.category === 'news' ? '资讯' : '知识'} · {item.status === 'draft' ? '草稿' : '已发布'}</span><small>{audience(item.access)}</small>
        </button>)}
      </div>
      <div className="form-panel article-editor">
        {selected?.document && <section aria-label="报告原件"><h3>报告原件</h3><p>{selected.document.filename} · {selected.document.pages} 页 · {(selected.document.bytes/1048576).toFixed(1)} MB</p><div className="business-actions"><a className="button secondary" target="_blank" rel="noopener noreferrer" href={(isWebTrial?'/hejun-club/api':'/api')+'/admin/articles/'+selected.id+'/document'}>预览 PDF</a><a className="button secondary" href={(isWebTrial?'/hejun-club/api':'/api')+'/admin/articles/'+selected.id+'/document?download=1'}>下载原件</a></div></section>}
        <h3>{selected ? '编辑内容' : '新建草稿'}</h3>
        {selected && <p className="small">{selected.status === 'draft' ? '草稿' : '已发布'} · 版本 {selected.revision} · {audience(selected.access)}</p>}
        {published && <p>请先撤下内容，再修改并重新发布。</p>}
        <form onSubmit={save}>
          <fieldset disabled={busy || published || uncertain}>
            {selected?.document?.previewPages&&form.access.visibility==='plans'?<label><input type="checkbox" checked={form.access.previewPages===10} onChange={e=>setForm({...form,access:{...form.access,previewPages:e.target.checked?10:0}})}/>允许其他访客试看前10页（不足10页显示全部）</label>:null}
            <label className="field"><span id="article-title-label">内容标题</span><input aria-labelledby="article-title-label" required maxLength={80} value={form.title} onChange={e => setForm({ ...form, title: e.target.value })}/></label>
            <label className="field"><span id="article-category-label">内容分类</span><select aria-labelledby="article-category-label" value={form.category} onChange={e => setForm({ ...form, category: e.target.value as Content['category'] })}><option value="news">资讯</option><option value="knowledge">知识</option></select></label>
            <label className="field"><span id="article-summary-label">内容摘要</span><textarea aria-labelledby="article-summary-label" maxLength={180} rows={2} value={form.summary} onChange={e => setForm({ ...form, summary: e.target.value })}/></label>
            <label className="field"><span id="article-body-label">内容正文</span><textarea aria-labelledby="article-body-label" maxLength={4000} rows={10} value={form.body} onChange={e => setForm({ ...form, body: e.target.value })}/></label>
            <label className="field"><span id="article-access-label">阅读范围</span><select aria-labelledby="article-access-label" value={form.access.visibility} onChange={e => setForm({ ...form, access: { visibility: e.target.value as Access['visibility'], planIds: [] } })}>
              <option value="unconfigured">待配置（禁止发布）</option><option value="public">所有访客（公开）</option><option value="plans">指定会员档位</option>
            </select></label>
            {form.access.visibility === 'plans' && <div className="article-plans">{plans.map(plan => <label key={plan.id}><input type="checkbox" checked={form.access.planIds.includes(plan.id)} onChange={e => setForm({ ...form, access: { ...form.access, planIds: e.target.checked ? [...form.access.planIds, plan.id] : form.access.planIds.filter(id => id !== plan.id) } })}/>{plan.name}</label>)}<p className="small">仅所选档位的有效会员可读，各档位不自动互通。</p></div>}
          </fieldset>
          {!published && <button className="button primary" disabled={busy} type="submit">{uncertain ? '重试保存草稿' : '保存草稿'}</button>}
        </form>
        {selected && <div className="business-actions">
          <button className="button secondary" disabled={busy || dirty || uncertain || (!published && (selected.access.visibility === 'unconfigured' || !selected.body.trim()))}
            onClick={() => setConfirm(published ? 'unpublish' : 'publish')}>{published ? '撤下内容' : '发布内容'}</button>
          <button className="text-button" disabled={busy || uncertain} onClick={() => {
            const latest = items.find(a => a.id === selected.id); if (latest) choose(latest);
          }}>重新载入所选内容</button>
        </div>}
        {dirty && selected && <p className="small">有未保存的修改，保存后才能发布。</p>}
        {confirm && selected && <div className="article-confirm" role="group" aria-label="确认内容操作">
          <p>{confirm === 'publish' ? '确认发布' : '确认撤下'}：{selected.title}</p><p>阅读范围：{audience(selected.access)}</p>
          <button className="button primary" disabled={busy} onClick={() => void transition()}>{confirm === 'publish' ? '确认发布' : '确认撤下'}</button>
          <button className="button secondary" disabled={busy} onClick={() => setConfirm(null)}>暂不操作</button>
        </div>}
      </div>
    </div>
  </section>;
}
