import {useEffect,useRef,useState,type FormEvent} from 'react';
import {api,errorText,type Session} from './api';
import {prepareAdminExport} from './admin-export';
import {LegalFields,useLegalRelease} from './Legal';
import {isWebTrial} from './web-env';
import {enterpriseFields,enterpriseStatistics,answerText,beijingTime,type EnterpriseAnswers,type EnterpriseSubmission} from './enterprise-data';

type IntakeConfig={mode:'hybrid'|'closed';maxFileBytes:number;templateVersion:string;templates:{docx:string;pdf:string}};
function readFile(file:File):Promise<string>{return new Promise((resolve,reject)=>{const reader=new FileReader();reader.onload=()=>resolve(String(reader.result).split(',')[1]);reader.onerror=()=>reject(new Error('文件读取失败，请重新选择'));reader.readAsDataURL(file);});}
export function EnterpriseIntake(){
 const [config,setConfig]=useState<IntakeConfig|null>(null),[error,setError]=useState(''),[busy,setBusy]=useState(false),[receipt,setReceipt]=useState('');
 const [company,setCompany]=useState(''),[contact,setContact]=useState(''),[phone,setPhone]=useState(''),[note,setNote]=useState(''),[file,setFile]=useState<File|null>(null);
 const [answers,setAnswers]=useState<EnterpriseAnswers>(()=>Object.fromEntries(enterpriseFields.map(f=>[f.id,f.type==='multi'?[]:''])));
 const [consent,setConsent]=useState(false),[accepted,setAccepted]=useState(false),[hongKong,setHongKong]=useState(false);
 const legal=useLegalRelease(),key=useRef(crypto.randomUUID());
 useEffect(()=>{let active=true;api<IntakeConfig>('/enterprise-intake').then(r=>{if(active)setConfig(r);}).catch(e=>{if(active)setError(errorText(e));});return()=>{active=false;};},[]);
 function changed(){key.current=crypto.randomUUID();setError('');}
 function answer(id:string,value:string|string[]){setAnswers(old=>({...old,[id]:value}));changed();}
 async function submit(e:FormEvent){
  e.preventDefault();if(busy||receipt||!config)return;setError('');
  for(const f of enterpriseFields)if(f.required&&!answers[f.id]?.length){setError(`请填写${f.label}`);document.getElementById('enterprise-'+f.id)?.focus();return;}
  if(!file){setError('请选择填写完成的Word或PDF文件');return;}
  if(!/\.(docx|pdf)$/i.test(file.name)||file.size>config.maxFileBytes||file.size===0){setError('请选择5MB以内的.docx或.pdf文件');return;}
  if(!consent||legal.release&&(!accepted||!hongKong)){setError('请阅读并确认信息用途、协议和香港存储安排');return;}
  setBusy(true);
  try{
   const fileBase64=await readFile(file);
   const result=await api<{receipt:{id:string}}>('/enterprise-intake',{company,contact,phone,note,answers,filename:file.name,fileBase64,templateVersion:config.templateVersion,consent,legalConsent:legal.release?{accepted,hongKongAccepted:hongKong,releaseId:legal.release.id}:undefined},key.current);
   setReceipt(result.receipt.id);setFile(null);
  }catch(e){setError(errorText(e)+'；本页资料和所选文件保留，可重试。');}finally{setBusy(false);}
 }
 return <div className="narrow-page"><a href="#/">返回首页</a><h1 id="page-title">企业信息收集与出海需求汇总表</h1><p>中国—东盟经贸中心 &amp; 和君国际 · 跨境企业家俱乐部</p>
  <a href={import.meta.env.BASE_URL+'enterprise-intake-guide.html'} target="_blank" rel="noopener noreferrer">查看填写与后台统计说明</a>
  {(error||legal.error)&&<p role="alert" className="field-error">{error||legal.error}</p>}
  {!config&&!error&&<p role="status">正在加载资料提交页面…</p>}
  {config?.mode==='closed'&&<p>企业资料收集暂未开放，请稍后再试。此前已提交的资料仍保留。</p>}
  {config?.mode==='hybrid'&&(receipt?<section className="form-panel" role="status"><h2>资料提交成功</h2><p>关键统计信息与附件已一起保存，工作人员可在后台汇总和查看。请保存回执编号。</p><p style={{overflowWrap:'anywhere'}}>回执编号：{receipt}</p><p>如需修订，请重新打开本页提交，并注明原回执编号。原记录与文件会保留。</p><a href="#/">返回首页</a></section>:<>
   <section className="form-panel"><h2>准备完整材料</h2><p>请先下载完整表格，用Word或WPS填写并保存。再在下方填写用于统计的关键字段，上传填好的材料，一次提交。关键字段请与附件保持一致。</p><div className="business-actions"><a className="button primary" href={import.meta.env.BASE_URL+config.templates.docx} download>下载可编辑Word模板</a><a className="button secondary" href={import.meta.env.BASE_URL+config.templates.pdf} target="_blank" rel="noopener noreferrer">查看PDF样表</a></div><p className="small muted">建议在电脑填写完整材料。微信内如不能下载或选取文件，请在右上角选择“在浏览器打开”，或将本页链接发送到电脑。页面关闭后未提交内容不会保存。</p></section>
   <form className="form-panel" onSubmit={e=>void submit(e)}><fieldset disabled={busy} style={{border:0,padding:0,minWidth:0}}><legend><h2>1. 在线填写关键统计信息</h2></legend>
    <label className="field"><span>企业名称（必填）</span><input required maxLength={160} value={company} onChange={e=>{setCompany(e.target.value);changed();}}/></label>
    <label className="field"><span>联系人（必填）</span><input required maxLength={80} value={contact} onChange={e=>{setContact(e.target.value);changed();}}/></label>
    <label className="field"><span>联系电话（必填）</span><input type="tel" required maxLength={30} value={phone} onChange={e=>{setPhone(e.target.value);changed();}}/></label>
    {enterpriseFields.map(f=>{const label=f.label+(f.required?'（必填）':'（选填）'),id='enterprise-'+f.id;
     if(f.type==='multi'){const selected=answers[f.id] as string[];return <fieldset key={f.id} id={id} tabIndex={-1} style={{margin:'20px 0',padding:12,border:'1px solid #ddd',minWidth:0}}><legend>{label}（最多{f.maxChoices}项）</legend>{f.options?.map(option=><label key={option} style={{display:'flex',gap:8,alignItems:'start',margin:'10px 0'}}><input type="checkbox" checked={selected.includes(option)} disabled={!selected.includes(option)&&!selected.includes(f.exclusive??'')&&option!==f.exclusive&&selected.length===(f.maxChoices??0)} onChange={e=>answer(f.id,e.target.checked?(option===f.exclusive?[option]:[...selected.filter(x=>x!==f.exclusive),option]):selected.filter(x=>x!==option))}/><span>{option}</span></label>)}</fieldset>;}
     return <label className="field" key={f.id}><span>{label}</span>{f.type==='single'?<select id={id} required={f.required} value={answers[f.id] as string} onChange={e=>answer(f.id,e.target.value)}><option value="">请选择</option>{f.options?.map(o=><option key={o}>{o}</option>)}</select>:f.type==='text'?<textarea id={id} rows={3} required={f.required} maxLength={f.maxLength} value={answers[f.id] as string} onChange={e=>answer(f.id,e.target.value)}/>:<input id={id} required={f.required} maxLength={f.maxLength} value={answers[f.id] as string} onChange={e=>answer(f.id,e.target.value)}/>}</label>;
    })}
    <p className="small muted">选择“其他”时，可在问题说明或完整材料中补充具体情况。网页只统计以上字段；详细资质、24个服务模块评估等内容保留在附件中。</p>
    <h2>2. 上传完整材料</h2><label className="field"><span>填好的Word或PDF文件（必填，最大5MB）</span><input type="file" required accept=".docx,.pdf" style={{width:'100%',maxWidth:'100%'}} onChange={e=>{setFile(e.target.files?.[0]??null);changed();}}/></label>
    <label className="field"><span>补交或其他说明（选填）</span><textarea maxLength={1000} rows={3} placeholder="如为修订版，可填写原回执编号和修改内容。" value={note} onChange={e=>{setNote(e.target.value);changed();}}/></label>
    <p>提交资料用于企业需求内部评估与后续联系，不会公开展示。备案、对外匹配或名录展示等其他用途，以您在文件中的具体授权及后续确认办理；本次提交不会自动执行这些事项。</p>
    {legal.release&&<LegalFields release={legal.release} accepted={accepted} onAccepted={v=>{setAccepted(v);changed();}} hongKong={hongKong} onHongKong={v=>{setHongKong(v);changed();}}/>}
    <label><input type="checkbox" checked={consent} onChange={e=>{setConsent(e.target.checked);changed();}}/> 我确认有权提交本企业资料，并同意将资料用于本次需求内部评估与后续联系。</label>
    <p className="small muted">看到“资料提交成功”和回执编号才表示关键字段与附件均已保存。上传期间请保持页面打开。</p>
    <button className="button primary" disabled={busy||!legal.ready}>{busy?'正在提交，请稍候…':'提交企业资料'}</button>
   </fieldset></form>
  </>)}
 </div>;
}

type ListResult={submissions:EnterpriseSubmission[];next:number|null};
export function AdminEnterpriseIntake({userId}:{userId:string}){
 const [rows,setRows]=useState<EnterpriseSubmission[]>([]),[busy,setBusy]=useState(false),[error,setError]=useState(''),[loaded,setLoaded]=useState(false);
 const [query,setQuery]=useState(''),[filters,setFilters]=useState<Record<string,string>>({});
 const active=useRef(true),lock=useRef(false);
 useEffect(()=>{active.current=true;return()=>{active.current=false;};},[]);
 async function load(){
  if(lock.current||!active.current)return;lock.current=true;setBusy(true);setError('');
  try{
   let cursor:number|null=null;const all:EnterpriseSubmission[]=[],seen=new Set<number>();
   do{
    const r:ListResult=await api('/admin/enterprise-intake'+(cursor?'?before='+cursor:''));
    if(!active.current)return;
    all.push(...r.submissions);cursor=r.next;
    if(cursor!==null){if(seen.has(cursor))throw new Error('资料分页异常，请刷新重试');seen.add(cursor);}
   }while(cursor);
   setRows(all);setLoaded(true);
  }catch(e){if(active.current)setError(errorText(e));}
  finally{lock.current=false;if(active.current)setBusy(false);}
 }
 const filtered=rows.filter(r=>`${r.company} ${r.contact} ${r.phone} ${r.id} ${Object.values(r.answers).map(answerText).join(' ')}`.toLowerCase().includes(query.trim().toLowerCase())&&Object.entries(filters).every(([id,v])=>!v||(Array.isArray(r.answers[id])?(r.answers[id] as string[]).includes(v):r.answers[id]===v)));
 async function exportList(){
  if(lock.current||!loaded||!active.current)return;lock.current=true;setBusy(true);setError('');
  try{
   const buffer=await prepareAdminExport(userId,()=>active.current,()=>api<Session>('/me'),async()=>
    (await import('./enterprise-export')).buildEnterpriseList(filtered));
   if(!buffer||!active.current)return;
   const url=URL.createObjectURL(new Blob([new Uint8Array(buffer)],{type:'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet'}));
   const a=document.createElement('a');a.href=url;a.download='企业需求汇总-'+new Date().toISOString().slice(0,10)+'.xlsx';a.click();
   setTimeout(()=>URL.revokeObjectURL(url),1000);
  }catch(e){if(active.current)setError(errorText(e));}
  finally{lock.current=false;if(active.current)setBusy(false);}
 }
 const stats=enterpriseStatistics(filtered).filter(r=>r.count>0&&['希望获得的服务类别','最希望进入的东盟国家'].includes(r.field));
 return <details className="form-panel" onToggle={e=>{if(e.currentTarget.open&&!loaded)void load();}}><summary>企业出海需求（关键字段＋完整材料）</summary><p>在线字段用于统计，附件供详细审阅。按提交份数计数，修订另计，不是去重企业数；附件内部答案未自动识别。</p><div className="business-actions"><button className="button secondary" disabled={busy} onClick={()=>void load()}>刷新企业需求</button><button className="button secondary" disabled={busy||!loaded} onClick={()=>void exportList()}>导出当前筛选Excel</button></div>
  <label className="field"><span>搜索企业需求</span><input value={query} onChange={e=>setQuery(e.target.value)} placeholder="企业、联系人、地区、产品或回执编号"/></label>
  {enterpriseFields.filter(f=>['industry','countries','services','timeline','serviceBudget','response'].includes(f.id)).map(f=><label className="field" key={f.id}><span>筛选：{f.label}</span><select value={filters[f.id]??''} onChange={e=>setFilters(old=>({...old,[f.id]:e.target.value}))}><option value="">全部</option>{f.options?.map(o=><option key={o}>{o}</option>)}</select></label>)}
  {error&&<p role="alert">{error}</p>}{busy&&<p role="status">正在处理企业需求…</p>}
  {loaded&&<><p>已加载 {rows.length} 份，当前筛选 {filtered.length} 份（修订另计）。</p>{stats.length>0&&<details><summary>当前筛选分类统计</summary>{stats.map(r=><p key={r.field+r.option}>{r.field} · {r.option}：{r.count} 份</p>)}</details>}{!filtered.length&&<p>暂无符合条件的企业需求。</p>}</>}
  {filtered.map(r=><article key={r.id} style={{borderTop:'1px solid #ddd',padding:'16px 0',overflowWrap:'anywhere'}}><h3>{r.company}</h3><p>{r.contact} · {r.phone}</p><p>提交时间：{beijingTime(r.submitted_at)}（北京时间）</p><p>回执编号：{r.id}</p><p>{r.filename} · {(r.byte_size/1024).toFixed(1)}KB</p><details><summary>查看关键统计信息</summary>{r.fields.map(f=><p key={f.id}><strong>{f.label}：</strong>{answerText(r.answers[f.id])||'未填写'}</p>)}</details>{r.note&&<p>说明：{r.note}</p>}<a className="button secondary" href={`${isWebTrial?'/hejun-club/api':'/api'}/admin/enterprise-intake/${r.id}/file`}>下载提交文件</a></article>)}
 </details>;
}
