import {LegalFields,useLegalRelease} from './Legal';
import { useEffect, useRef, useState } from 'react';
import { api, errorText, type Session } from './api';
import { prepareAdminExport } from './admin-export';
import type { SurveyRecord, SurveySchema } from './survey-export';

type Field = { noteLabel?: string; enLabel?: string; enOptions?: string[]; id: string; number: number; label: string; required: boolean; type: string; options: string[]; section: number };
type Survey = { id: string; version: string; title: string; requireAnswer?: boolean; description?:string; successMessage?:string; consentText?:string; sections: string[]; fields: Field[] };
type Answers = Record<string, string | string[]>;

export function Surveys({ side }: { side?: string }) {
  const legal=useLegalRelease();const [policy,setPolicy]=useState(false),[hongKong,setHongKong]=useState(false);
  const [survey, setSurvey] = useState<Survey | null>(null);
  const [answers, setAnswers] = useState<Answers>({});
  const [section, setSection] = useState(1), [consent, setConsent] = useState(false);
  const [busy, setBusy] = useState(false), [error, setError] = useState(''), [receipt, setReceipt] = useState('');
  const key = useRef(crypto.randomUUID()), attempted = useRef(false);
  useEffect(() => {
    if (!['supply', 'demand', 'singapore', 'salon'].includes(side || '')) return;
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
    if (survey.requireAnswer && !Object.values(answers).some(v => typeof v === 'string' ? v.trim().length : v.length)) { setError('请至少填写一项反馈后提交'); return; }
    if (!consent) { setError('请同意将信息用于对接撮合与活动安排'); return; }
    if(legal.release&&(!policy||!hongKong)){setError('请阅读协议并确认香港存储安排');return;}
    setBusy(true); setError(''); attempted.current = true;
    try {
      const result = await api<{ receipt: { id: string } }>('/surveys/' + side, { version: survey.version, answers, consent,legalConsent:legal.release?{accepted:policy,hongKongAccepted:hongKong,releaseId:legal.release.id}:undefined }, key.current);
      setReceipt(result.receipt.id); setAnswers({});
    } catch (e) { setError(errorText(e) + '；填写内容保留，可重试。'); }
    finally { setBusy(false); }
  }
  return <div className="narrow-page"><a href="#/">返回首页</a>
    <h1 id="page-title">{side==='salon'?'2026中国—东盟AI大咖沙龙 · 参会反馈与需求调研问卷':side==='singapore'?'11月新加坡AI分论坛·路演意向登记':'中国—东盟人工智能供需对接会'}</h1>
    {side!=='singapore'&&side!=='salon'&&<p>供需征集长期开放，可随时填写。现场活动：9月17日14:30—16:30，南宁国际会展中心B103、B105。</p>}{survey?.description&&<p>{survey.description}</p>}
    {!side && <div className="business-actions"><a className="button primary" href="#/surveys/supply">我提供AI产品或解决方案</a><a className="button secondary" href="#/surveys/demand">我有AI应用场景需求</a></div>}
    {(error || legal.error) && <p role="alert" className="field-error">{error || legal.error}</p>}
    {receipt ? <section className="form-panel"><h2>提交成功</h2><p>{survey?.successMessage||'内容已保存，用于对接撮合与活动安排。'}</p><p>回执编号：{receipt}</p></section> : survey && <>
      {side!=='singapore'&&side!=='salon'&&<h2>{survey.title}</h2>}{side==='salon'&&<p>各题均可选填，请至少填写一项反馈。看到“提交成功”和回执编号才表示已保存；提交前请勿刷新或关闭页面。</p>}<p>第{section} / {survey.sections.length}部分 · {survey.sections[section - 1]}</p>
      {survey.fields.filter(f => f.section === section).map(f => <fieldset className="form-panel" key={f.id} disabled={busy}>
        <legend>{f.number}. {f.label}{(side==='singapore'||side==='salon')&&(f.required?'（必填）':'（选填）')}{f.enLabel && <div>{f.enLabel}</div>}</legend>
        {['input','tel'].includes(f.type)?<input aria-label={f.label} type={f.type==='tel'?'tel':'text'} autoComplete="off" maxLength={200} style={{width:'100%',boxSizing:'border-box',padding:12}} value={String(answers[f.id]||'')} onChange={e=>change(f.id,e.target.value)}/>: f.type === 'text' ? <textarea aria-label={f.label} rows={3} maxLength={3000} style={{ width: '100%' }} value={String(answers[f.id] || '')} onChange={e => change(f.id, e.target.value)} />
          : f.options.map((option, index) => <label key={option} style={{ display: 'block', margin: '12px 0' }}><input type={f.type === 'multi' ? 'checkbox' : 'radio'} name={f.id} checked={f.type === 'multi' ? (answers[f.id] || []).includes(option) : answers[f.id] === option}
            onChange={e => change(f.id, f.type === 'single' ? option : e.target.checked ? [...(answers[f.id] as string[] || []), option] : (answers[f.id] as string[] || []).filter(v => v !== option))} /> {option}{f.enOptions?.[index] && <div>{f.enOptions[index]}</div>}</label>)}
        {!!f.options.length && (side!=='salon'||f.noteLabel) && <label className="field"><span>{f.noteLabel||'国别、其他内容或补充说明（选填）'}</span><textarea maxLength={1000} rows={2} value={String(answers[f.id + 'Note'] || '')} onChange={e => change(f.id + 'Note', e.target.value)} /></label>}
      </fieldset>)}
      <div className="business-actions">{section > 1 && <button className="button secondary" disabled={busy} onClick={() => setSection(section - 1)}>上一部分</button>}
        {section < survey.sections.length ? <button className="button primary" disabled={busy} onClick={() => setSection(section + 1)}>下一部分</button> : <>{legal.release&&<LegalFields release={legal.release} accepted={policy} onAccepted={setPolicy} hongKong={hongKong} onHongKong={setHongKong}/>}<label><input type="checkbox" checked={consent} disabled={busy} onChange={e => setConsent(e.target.checked)} />{survey.consentText||'我同意将所填信息用于本次对接撮合与活动安排。联系信息不公开展示。'}</label><button className="button primary" disabled={busy || !legal.ready} onClick={() => void submit()}>{busy ? '正在提交…' : '提交问卷'}</button></>}
      </div>
    </>}
  </div>;
}

export function AdminSurveys({userId}: {userId: string}) {
  const active = useRef(true), lock = useRef(false);
  useEffect(() => { active.current = true; return () => { active.current = false; }; }, []);
  const [busy, setBusy] = useState(false), [message, setMessage] = useState('');
  const [selected, setSelected] = useState('salon');
  const [materials,setMaterials]=useState<SurveyRecord[]>([]),[materialNext,setMaterialNext]=useState<number|null>(null);
  async function readMaterials(more=false){
    if(lock.current||!active.current)return;lock.current=true;setBusy(true);setMessage('');
    try{const output=await prepareAdminExport(userId,()=>active.current,()=>api<Session>('/me'),()=>api<{submissions:SurveyRecord[];next:number|null}>('/admin/surveys?survey=general-supply'+(more&&materialNext?'&before='+materialNext:'')));
      if(output&&active.current){setMaterials(old=>more?[...old,...output.submissions]:output.submissions);setMaterialNext(output.next);setMessage('已读取产品服务问卷；未附PDF的记录显示“未附材料”。');}
    }catch(e){if(active.current){setMaterials([]);setMaterialNext(null);setMessage(errorText(e));}}
    finally{lock.current=false;if(active.current)setBusy(false);}
  }

  async function download(side?:string, excel = false) {
    if (lock.current || !active.current) return;
    lock.current = true;
    setBusy(true); setMessage('');
    try {
      const output = await prepareAdminExport(userId, () => active.current, () => api<Session>('/me'), async () => {
      const all: SurveyRecord[] = []; let cursor: number | null = null;
      let schemas: Record<string, SurveySchema> = {};
      const seenCursors = new Set<number>();
      do {
        const result: { submissions: SurveyRecord[]; schemas: Record<string, SurveySchema>; next: number | null } = await api('/admin/surveys?' + new URLSearchParams({...cursor?{before:String(cursor)}:{},...side?{survey:side}:{}}).toString());
        if (!active.current) return undefined;
        all.push(...result.submissions); schemas = result.schemas || {}; cursor = result.next;
        if (cursor !== null) { if (seenCursors.has(cursor)) throw new Error('导出分页异常，请重试'); seenCursors.add(cursor); }
      } while (cursor);
      const buffer = excel ? await (await import('./survey-export')).buildSurveyWorkbook(all, schemas, side) : null;
      const blob = buffer ? new Blob([new Uint8Array(buffer)], { type: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet' }) : new Blob([JSON.stringify({ exportedAt: new Date().toISOString(), schemas, submissions: all }, null, 2)], { type: 'application/json' });
      return {blob, count: all.length};
      });
      if (!output || !active.current) return;
      const {blob, count} = output;
      const url = URL.createObjectURL(blob), link = document.createElement('a');
      link.href = url; link.download = excel ? `问卷-${side || '全部'}-${new Date().toISOString().slice(0,10)}.xlsx` : side==='singapore'?'singapore-roadshow-surveys.json':'ai-matchmaking-surveys.json'; link.click();
      setTimeout(() => URL.revokeObjectURL(url), 1000);
      setMessage(`已生成${count}份问卷${excel?'（Excel）':''}，请在浏览器下载记录中确认文件。${count===0?'当前范围暂无提交，文件中保留题目表头。':''}文件含联系信息，请仅交接给活动办理人员。`);
    } catch (e) { if (active.current) setMessage(errorText(e)); }
    finally { lock.current = false; if (active.current) setBusy(false); }
  }
  return <section className="form-panel"><h2>问卷数据导出</h2><p>Excel包含中文题目、全部答案和补充说明。可在“逐份阅读”中按回执编号筛选阅读；历史测试记录保留并标明。</p><label>问卷范围 <select aria-label="问卷范围" value={selected} disabled={busy} onChange={e=>setSelected(e.target.value)}><option value="salon">沙龙参会反馈与需求调研</option><option value="">全部问卷</option><option value="general-demand">通用采购需求</option><option value="general-supply">通用产品服务</option><option value="demand">AI需求端</option><option value="supply">AI供给端</option><option value="singapore">新加坡路演意向</option></select></label><button className="button primary" disabled={busy} onClick={()=>void download(selected, true)}>{busy?'正在导出…':'导出中文Excel'}</button><p>建议在电脑浏览器下载，用Excel或WPS打开。JSON供原始数据备份使用。</p><button className="button secondary" disabled={busy} onClick={() => void download()}>导出全部问卷（JSON）</button><button className="button secondary" disabled={busy} onClick={()=>void download('singapore')}>导出新加坡路演登记（JSON）</button><h3>产品服务问卷附加资料</h3><p>单份PDF与问卷使用同一回执，资料仅供后台工作人员查看。</p><button className="button secondary" disabled={busy} onClick={()=>void readMaterials()}>读取近期产品服务问卷</button>{materials.map(r=><article key={r.id} className="form-panel"><h4>{String(r.answers.company||'企业资料')}</h4><p>回执：{r.id}</p><p>{String(r.answers.contact||'')} · {String(r.answers.phone||'')}</p>{r.answers.attachmentReceipt===r.id?<a className="button secondary" href={'/api/admin/surveys/'+encodeURIComponent(r.id)+'/file'}>下载 {String(r.answers.attachmentFilename||'附加PDF')}</a>:<p>未附材料</p>}</article>)}{materialNext!==null&&<button className="button secondary" disabled={busy} onClick={()=>void readMaterials(true)}>读取更早记录</button>}{message && <p role="status">{message}</p>}</section>;
}
