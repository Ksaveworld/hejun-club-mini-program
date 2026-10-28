import {useEffect,useRef,useState} from 'react';
import {api,errorText} from './api';

type Row={id:string;kind:string;company:string;contact:string;phone:string;filename:string;byte_size:number;submitted_at:string;note?:string};
export function AdminApplicationMaterials({userId}:{userId:string}){
 const [rows,setRows]=useState<Row[]>([]),[kind,setKind]=useState(''),[error,setError]=useState(''),[busy,setBusy]=useState(false),[next,setNext]=useState<number|null>(null);
 const revision=useRef(0);
 async function load(more=false){const version=++revision.current;setBusy(true);setError('');try{const query=new URLSearchParams();if(kind)query.set('kind',kind);if(more&&next)query.set('before',String(next));const value=await api<{submissions:Row[];next:number|null}>('/admin/application-materials'+(query.size?'?'+query:''));if(version===revision.current){setRows(old=>more?[...old,...value.submissions]:value.submissions);setNext(value.next);}}catch(e){if(version===revision.current)setError(errorText(e));}finally{if(version===revision.current)setBusy(false);}}
 useEffect(()=>{setRows([]);setNext(null);void load();return()=>{revision.current++;};},[userId,kind]);
 return <section><h2>申请材料</h2><p className="muted">查看合作伙伴及机构会员提交的文件。此处仅收集材料，不进行审核、收费或开通会籍。文件仅供授权管理员处理，请勿公开发布。</p>
 <label className="field"><span>申请类型</span><select value={kind} onChange={e=>setKind(e.target.value)}><option value="">全部</option><option value="partner">合作伙伴申请</option><option value="organization">机构会员预报名</option></select></label>
 <button className="button secondary" disabled={busy} onClick={()=>void load()}>刷新材料</button>
 {error&&<p className="field-error" role="alert">{error}</p>}{busy&&<p role="status">正在读取…</p>}
 {!busy&&!error&&!rows.length&&<p>暂无提交材料。</p>}
 {rows.map(row=><article className="form-panel" key={row.id}><h3>{row.company}</h3><p>{row.kind==='partner'?'合作伙伴申请':'机构会员预报名'} · 已提交</p><p>{row.contact} · {row.phone}</p><p>提交时间：{new Date(row.submitted_at).toLocaleString('zh-CN',{timeZone:'Asia/Shanghai'})}</p><p>回执：{row.id}</p><p>{row.filename} · {(row.byte_size/1024).toFixed(1)} KB</p>{row.note&&<p>{row.note}</p>}<a className="button secondary" href={'/api/admin/application-materials/'+encodeURIComponent(row.id)+'/file'}>下载填写材料</a></article>)}
 {next&&<button className="button secondary" disabled={busy} onClick={()=>void load(true)}>加载更多</button>}</section>;
}
