import { useEffect, useRef, useState } from 'react';
import { api, errorText } from './api';

type Field = { enLabel?: string; enOptions?: string[]; id: string; number: number; label: string; required: boolean; type: string; options: string[]; section: number };
type Survey = { id: string; version: string; title: string; sections: string[]; fields: Field[] };
type Answers = Record<string, string | string[]>;

export function Surveys({ side }: { side?: string }) {
  const [survey, setSurvey] = useState<Survey | null>(null);
  const [answers, setAnswers] = useState<Answers>({});
  const [section, setSection] = useState(1), [consent, setConsent] = useState(false);
  const [busy, setBusy] = useState(false), [error, setError] = useState(''), [receipt, setReceipt] = useState('');
  const key = useRef(crypto.randomUUID()), attempted = useRef(false);
  useEffect(() => {
    if (!['supply', 'demand'].includes(side || '')) return;
    let active = true;
    void api<{ survey: Survey }>('/surveys/' + side).then(r => { if (active) setSurvey(r.survey); })
      .catch(e => { if (active) setError(errorText(e)); });
    return () => { active = false; };
  }, [side]);
  function change(id: string, value: string | string[]) {
    if (attempted.current) { key.current = crypto.randomUUID(); attempted.current = false; }
    setAnswers(old => ({ ...old, [id]: value })); setError('');
  }
  async function submit() {
    if (!survey || busy || receipt) return;
    const missing = survey.fields.find(f => f.required && !(answers[f.id] || []).length);
    if (missing) { setSection(missing.section); setError(`请填写第${missing.number}题：${missing.label}`); return; }
    if (!consent) { setError('请同意将信息用于对接撮合与活动安排'); return; }
    setBusy(true); setError(''); attempted.current = true;
    try {
      const result = await api<{ receipt: { id: string } }>('/surveys/' + side, { version: survey.version, answers, consent }, key.current);
      setReceipt(result.receipt.id); setAnswers({});
    } catch (e) { setError(errorText(e) + '；填写内容保留，可重试。'); }
    finally { setBusy(false); }
  }
  return <div className="narrow-page"><a href="#/">返回首页</a>
    <h1 id="page-title">中国—东盟人工智能供需对接会</h1>
    <p>9月17日 14:30—16:30 · 南宁国际会展中心 B103、B105</p>
    {!side && <div className="business-actions"><a className="button primary" href="#/surveys/supply">我提供AI产品或解决方案</a><a className="button secondary" href="#/surveys/demand">我有AI应用场景需求</a></div>}
    {error && <p role="alert" className="field-error">{error}</p>}
    {receipt ? <section className="form-panel"><h2>提交成功</h2><p>内容已保存，用于对接撮合与活动安排。</p><p>回执编号：{receipt}</p></section> : survey && <>
      <h2>{survey.title}</h2><p>第{section} / {survey.sections.length}部分 · {survey.sections[section - 1]}</p>
      {survey.fields.filter(f => f.section === section).map(f => <fieldset className="form-panel" key={f.id} disabled={busy}>
        <legend>{f.number}. {f.label}{f.enLabel && <div>{f.enLabel}</div>}</legend>
        {f.type === 'text' ? <textarea aria-label={f.label} rows={3} maxLength={3000} style={{ width: '100%' }} value={String(answers[f.id] || '')} onChange={e => change(f.id, e.target.value)} />
          : f.options.map((option, index) => <label key={option} style={{ display: 'block', margin: '12px 0' }}><input type={f.type === 'multi' ? 'checkbox' : 'radio'} name={f.id} checked={f.type === 'multi' ? (answers[f.id] || []).includes(option) : answers[f.id] === option}
            onChange={e => change(f.id, f.type === 'single' ? option : e.target.checked ? [...(answers[f.id] as string[] || []), option] : (answers[f.id] as string[] || []).filter(v => v !== option))} /> {option}{f.enOptions?.[index] && <div>{f.enOptions[index]}</div>}</label>)}
        {!!f.options.length && <label className="field"><span>国别、其他内容或补充说明（选填）</span><textarea maxLength={1000} rows={2} value={String(answers[f.id + 'Note'] || '')} onChange={e => change(f.id + 'Note', e.target.value)} /></label>}
      </fieldset>)}
      <div className="business-actions">{section > 1 && <button className="button secondary" disabled={busy} onClick={() => setSection(section - 1)}>上一部分</button>}
        {section < survey.sections.length ? <button className="button primary" onClick={() => setSection(section + 1)}>下一部分</button> : <><label><input type="checkbox" checked={consent} disabled={busy} onChange={e => setConsent(e.target.checked)} />我同意将所填信息用于本次对接撮合与活动安排。联系信息不公开展示。</label><button className="button primary" disabled={busy} onClick={() => void submit()}>{busy ? '正在提交…' : '提交问卷'}</button></>}
      </div>
    </>}
  </div>;
}

export function AdminSurveys() {
  const active = useRef(true);
  useEffect(() => { active.current = true; return () => { active.current = false; }; }, []);
  const [busy, setBusy] = useState(false), [message, setMessage] = useState('');
  async function download() {
    setBusy(true); setMessage('');
    try {
      const all: unknown[] = []; let cursor: number | null = null;
      do {
        const result: { submissions: unknown[]; next: number | null } = await api('/admin/surveys' + (cursor ? '?before=' + cursor : ''));
        if (!active.current) return;
        all.push(...result.submissions); cursor = result.next;
      } while (cursor);
      const blob = new Blob([JSON.stringify({ exportedAt: new Date().toISOString(), submissions: all }, null, 2)], { type: 'application/json' });
      const url = URL.createObjectURL(blob), link = document.createElement('a');
      link.href = url; link.download = 'ai-matchmaking-surveys.json'; link.click();
      setTimeout(() => URL.revokeObjectURL(url), 1000);
      setMessage(`已导出${all.length}份问卷。文件含联系信息，请仅交接给活动办理人员。`);
    } catch (e) { setMessage(errorText(e)); } finally { setBusy(false); }
  }
  return <section className="form-panel"><h2>AI供需对接问卷</h2><p>导出包含题号、问卷版本、提交时间与填写内容。</p><button className="button secondary" disabled={busy} onClick={() => void download()}>{busy ? '正在导出…' : '导出全部问卷（JSON）'}</button>{message && <p role="status">{message}</p>}</section>;
}
