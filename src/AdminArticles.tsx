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
    ? plans.filter(p => access.planIds.includes(p.id)).map(p => p.name).join('、') + '的有效会员可读全文'+(access.previewPages?'；其他访客可试看前10页':'') : '阅读权限待配置；PDF 上传成功后自动设置';
}
type Metadata = {displayScope:'info'|'activity'|'both';revision:number;section:'launch'|'landing'|'professional';topic:'unclassified'|'policy'|'practice';activityGroup:''|'salon'|'expo'|'online';originalUrl:string;policyCategory:''|'investment'|'compliance'|'guides';practiceCategory:''|'cases'|'methods'|'library';supportCategory:''|'parks'|'associations'|'opportunities';isRecap:boolean};
const blankMeta = (): Metadata => ({displayScope:'info',revision:0,section:'launch',topic:'unclassified',activityGroup:'',originalUrl:'',policyCategory:'',practiceCategory:'',supportCategory:'',isRecap:false});
class ChangedSession extends Error {}
type DraftSave = {content:Content;meta:Metadata;original:Article|null;article?:Article;started?:boolean;conflict?:boolean;placement:boolean;placementDone:boolean;contentKey:string;metaKey:string};
type ContentTransition = {id:string;action:'publish'|'unpublish'|'delete';revision:number;started:boolean;rejected?:boolean};
type PdfReceipt={articleId:string;revision:number;document:NonNullable<Article['document']>};
type PdfUpload={articleId:string;revision:number;started:boolean;id?:string;token?:string;completeStarted:boolean;cancelled:boolean;stopped?:'aborted'|'rejected'|'invalid-pdf';receipt?:PdfReceipt};
const sameContent=(a:Content,b:Content)=>a.title.trim()===b.title.trim()&&a.summary.trim()===b.summary.trim()&&a.body.trim()===b.body.trim()&&a.category===b.category&&a.access.visibility===b.access.visibility&&[...a.access.planIds].sort().join() === [...b.access.planIds].sort().join()&&(a.access.previewPages||0)===(b.access.previewPages||0);

export function AdminArticles({ userId }: { userId: string }) {
  const [items, setItems] = useState<Article[]>([]), [selected, setSelected] = useState<Article | null>(null);
  const [search,setSearch] = useState('');
  const [page,setPage]=useState(1),[size,setSize]=useState(10),[statusFilter,setStatusFilter]=useState('all'),[fileFilter,setFileFilter]=useState('all');
  const matching=items.filter(i=>(i.title+' '+(i.document?.filename||'')).toLowerCase().includes(search.trim().toLowerCase())&&(statusFilter==='all'||i.status===statusFilter)&&(fileFilter==='all'||(fileFilter==='pdf'?!!i.document:!i.document)));
  const pages=Math.max(1,Math.ceil(matching.length/size)),currentPage=Math.min(page,pages),visible=matching.slice((currentPage-1)*size,currentPage*size);
  useEffect(()=>setPage(1),[search,size,statusFilter,fileFilter]);

  const [form, setForm] = useState<Content>(blank), [busy, setBusy] = useState(false), [ready, setReady] = useState(false);
  const [error, setError] = useState(''), [message, setMessage] = useState(''), [confirm, setConfirm] = useState<'publish' | 'unpublish' | 'delete' | null>(null);
  const [uncertain, setUncertain] = useState(false);
  const pendingSave=useRef<DraftSave|null>(null);
  const pendingTransition=useRef<ContentTransition|null>(null);
  const [transitionRecovery,setTransitionRecovery]=useState<ContentTransition|null>(null);
  function trackTransition(value:ContentTransition|null){pendingTransition.current=value;setTransitionRecovery(value);}
  const [metadata,setMetadata]=useState<Metadata|null>(blankMeta),[metaForm,setMetaForm]=useState<Metadata|null>(blankMeta);
  const [pdf,setPdf]=useState<File|null>(null),[uploadProgress,setUploadProgress]=useState(''),[stale,setStale]=useState(false);
  const pdfInput=useRef<HTMLInputElement>(null);
  useEffect(()=>{if(!pdf&&pdfInput.current)pdfInput.current.value='';},[pdf,selected?.id,selected?.revision]);
  const [canCancelUpload,setCanCancelUpload]=useState(false);
  const uploadSession=useRef<PdfUpload|null>(null);
  const [uploadRecovery,setUploadRecovery]=useState(false);
  function clearUpload(){const pending=uploadSession.current;if(pending){pending.token=undefined;pending.id=undefined;}uploadSession.current=null;setUploadRecovery(false);setCanCancelUpload(false);setUploadProgress('');}
  function cancelUpload(){const pending=uploadSession.current;if(!pending||pending.completeStarted||pending.cancelled)return;pending.cancelled=true;setCanCancelUpload(false);setUploadProgress('正在停止本次传输，等待正在发送的分块结束后核对取消结果…');}
  const metaDirty=JSON.stringify(metadata)!==JSON.stringify(metaForm);
  async function readMeta(item:Article){const response=await api<{metadata:Metadata}>('/admin/content-meta/'+item.id);const meta=response.metadata;return {...meta,displayScope:meta.displayScope||(meta.activityGroup?'both':'info')};}
  async function reloadSelected(id:string,version:number){const response=await api<{articles:Article[]}>('/admin/articles');const item=response.articles.find(x=>x.id===id);if(!item)throw new Error('内容已不可用，请刷新列表。');const meta=await readMeta(item);await checked();if(version!==active.current)return;setItems(response.articles);accept(item);if(item.document)setPdf(null);setMetadata(meta);setMetaForm(meta);setStale(false);}
  async function readPdfState(version:number,completed=false){
    const pending=uploadSession.current;if(!pending)return;
    const result=await api<{articles:Article[]}>('/admin/articles');
    const item=result.articles.find(a=>a.id===pending.articleId),meta=item?await readMeta(item):null;
    await checked();if(version!==active.current)return;
    if(item&&meta?.revision!==item.revision)throw new Error('读取期间内容版本已变化，请再次核对当前 PDF。');
    setItems(result.articles);
    if(item&&meta){
      accept(item);setMetadata(meta);setMetaForm(meta);
      if(item.document){
        const receipt=pending.receipt,doc=item.document;
        const matches=completed&&receipt&&receipt.articleId===item.id&&receipt.revision===item.revision&&['filename','bytes','pages','previewPages'].every(k=>doc[k as keyof typeof doc]===receipt.document[k as keyof typeof doc]);
        clearUpload();setPdf(null);setStale(false);
        setMessage(matches?'PDF 已完整上传并生成试看；已套用默认权限：基础会员试看前10页，星级及机构专业会员全文。请预览原件后发布。':'当前记录已关联 PDF，仅确认当前读取状态，不代表一定由本次上传造成。请核对原件与试看后再发布；已有原件不会重传或覆盖。');return;
      }
      if(pending.stopped){
        clearUpload();setPdf(null);setStale(false);
        setMessage(pending.stopped==='invalid-pdf'?'服务端已拒绝本次 PDF 处理，当前未关联原件。请换用符合要求的 PDF 并重新选择。':pending.stopped==='rejected'?'上传准备已被拒绝，当前未关联 PDF。本次未发送文件或完成请求，请修正后重新选择文件。':pending.cancelled?'已确认取消本次上传，当前未关联 PDF。请重新选择文件。':'本次上传已中止，当前未关联 PDF。请重新选择文件。');return;
      }
      setMessage('当前记录为'+(item.status==='published'?'已发布':'草稿')+'，版本 '+item.revision+'，尚未读到 PDF；本次上传是否结束仍无法确认，不能据此认定上传失败。请稍后再次核对，不要重复上传。');
    }else{
      setSelected(null);setForm(blank());setMetadata(blankMeta());setMetaForm(blankMeta());setPdf(null);
      if(pending.stopped){clearUpload();setStale(false);setMessage('目标当前已不在可见列表中，本次未完成文件关联；没有重传或清理记录和文件。');return;}
      setMessage('目标当前已不在可见列表中，本次上传结果仍未确认；不会重新上传或清理记录和文件。请稍后再次核对。');
    }
    setUploadRecovery(true);setStale(true);
  }
  async function recoverPdf(){if(!uploadSession.current)return;await run(version=>readPdfState(version));}
  async function uploadPdf(){
    if(lock.current||uploadSession.current||pendingTransition.current||pendingSave.current||!selected||!pdf||dirty||metaDirty||published||stale||selected.document||metaForm?.originalUrl)return;
    const file=pdf;
    if(file.size<1||file.size>15*1024*1024||file.name.length>120||/[\\/\r\n]/.test(file.name)||!file.name.toLowerCase().endsWith('.pdf')){setError('请选择一份文件名不超过120字、不为空且不超过 15MB 的 PDF。');return;}
    const pending:PdfUpload={articleId:selected.id,revision:selected.revision,started:false,completeStarted:false,cancelled:false};uploadSession.current=pending;
    await run(async version=>{
      const uploadKey=crypto.randomUUID();setUploadProgress('正在准备上传…');
      const current=()=>{if(version!==active.current||uploadSession.current!==pending||pending.cancelled)throw new Error(pending.cancelled?'已请求停止本次上传':'本次上传已停止');};
      try{
        pending.started=true;
        let result:{upload:{id:string;token:string;chunkBytes:number}};
        try{result=await api('/admin/articles/'+pending.articleId+'/pdf/start',{revision:pending.revision,filename:file.name,bytes:file.size},uploadKey);}
        catch(err){if([400,401,403,404,409,410,413,422,429].includes((err as {status?:number}).status||0))pending.stopped='rejected';throw err;}
        const {id,token,chunkBytes}=result.upload;
        if(!/^[a-f0-9-]{36}$/.test(id)||!/^[a-f0-9]{64}$/.test(token))throw new Error('上传会话返回异常，请核对当前 PDF。');
        pending.id=id;pending.token=token;
        await checked();current();setCanCancelUpload(true);
        if(!Number.isInteger(chunkBytes)||chunkBytes<1||chunkBytes>262144)throw new Error('上传分块配置异常');
        for(let offset=0,index=0;offset<file.size;offset+=chunkBytes,index++){
          current();const bytes=new Uint8Array(await file.slice(offset,offset+chunkBytes).arrayBuffer());let binary='';for(let i=0;i<bytes.length;i++)binary+=String.fromCharCode(bytes[i]);
          await checked();current();const part=await api<{ok:boolean}>('/admin/articles/'+pending.articleId+'/pdf/'+id+'/part',{token,index,base64:btoa(binary)});if(part?.ok!==true)throw new Error('分块传输回执无法确认');
          if(!pending.cancelled)setUploadProgress('文件传输中 '+Math.min(100,Math.round((offset+bytes.length)/file.size*100))+'%（传输后还需校验并生成试看，尚未完成）');
        }
        await checked();current();pending.completeStarted=true;setCanCancelUpload(false);setUploadProgress('正在校验 PDF 并生成试看，请勿关闭页面…');
        let receipt:PdfReceipt;
        try{receipt=await api<PdfReceipt>('/admin/articles/'+pending.articleId+'/pdf/'+id+'/complete',{token},uploadKey);}
        catch(err){
          // These exact save-handler validation errors pass through complete's finally, which releases the session. Generic errors do not prove that.
          if((err as {status?:number}).status===400&&['PDF无法解析或已加密，请换用普通PDF','PDF须为1至300页','PDF包含活动内容或附件，请导出普通PDF','PDF格式不正确'].includes(errorText(err)))pending.stopped='invalid-pdf';
          throw err;
        }
        if(receipt.articleId!==pending.articleId||receipt.revision!==pending.revision+1||receipt.document?.filename!==file.name||receipt.document.bytes!==file.size||!(receipt.document.pages>0)||!(receipt.document.previewPages!>0))throw new Error('完成回执与本次上传不一致，请核对当前 PDF。');
        pending.receipt=receipt;await readPdfState(version,true);
      }catch(err){
        if(version!==active.current)return;
        if(err instanceof ChangedSession)throw err;
        if(pending.id&&pending.token&&!pending.completeStarted){
          try{await checked();if(version!==active.current)return;const aborted=await api<{ok:boolean}>('/admin/articles/'+pending.articleId+'/pdf/'+pending.id+'/abort',{token:pending.token});if(aborted?.ok!==true)throw new Error('中止回执无法确认');pending.stopped='aborted';await checked();}
          catch(abortError){if(abortError instanceof ChangedSession)throw abortError;}
        }
        throw new Error(errorText(err)+(pending.stopped==='aborted'?' 本次传输已收到中止确认，仍需核对当前记录。':' 本次上传或中止结果尚需核对。'));
      }finally{pending.token=undefined;pending.id=undefined;if(version===active.current){setCanCancelUpload(false);setUploadProgress('');}}
    });
  }
  const active = useRef(0), lock = useRef(false), key = useRef(crypto.randomUUID());
  const dirty = JSON.stringify(form) !== JSON.stringify(selected ? fields(selected) : blank());
  const published = selected?.status === 'published';
 useEffect(()=>{const guard=(e:BeforeUnloadEvent)=>{if(dirty||metaDirty||!!pdf||busy||uncertain||uploadSession.current||pendingTransition.current){e.preventDefault();e.returnValue='';}};const leave=(e:Event)=>{if(busy||uncertain||uploadSession.current||pendingTransition.current||((dirty||metaDirty||!!pdf)&&!window.confirm('当前有未保存内容或未上传文件，离开会丢弃。仍要切换栏目吗？')))e.preventDefault();};window.addEventListener('ops-before-section-change',leave);window.addEventListener('beforeunload',guard);return()=>{window.removeEventListener('ops-before-section-change',leave);window.removeEventListener('beforeunload',guard);};},[dirty,metaDirty,pdf,busy,uncertain]);
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
      if (err instanceof ChangedSession) { clearUpload();trackTransition(null);pendingSave.current=null;setItems([]); setSelected(null); setForm(blank());setMetadata(null);setMetaForm(null);setPdf(null); setReady(false); setUncertain(false); }
      else if(uploadSession.current){
        if(!uploadSession.current.started){clearUpload();err=Object.assign(new Error('上传前身份检查失败，尚未提交上传。文件选择已保留，可重新操作。'+errorText(err)),{draftEditable:true});}
        else{setUploadRecovery(true);err=new Error('PDF 上传结果需要核对。'+errorText(err)+' 请点击“核对当前PDF”，不会自动重传、覆盖或中止上传。');}
      }
      else if(pendingTransition.current){
        const pending=pendingTransition.current,label=pending.action==='delete'?'删除':pending.action==='publish'?'发布':'撤下',readLabel=pending.action==='delete'?'读取当前草稿状态':'读取当前发布状态';
        if(!pending.started){trackTransition(null);err=Object.assign(new Error(label+'前身份检查失败，尚未提交操作。请检查网络后重新确认。'+errorText(err)),{draftEditable:true});}
        else err=new Error((pending.rejected?'服务端已拒绝本次'+label+'，需要读取当前状态。':'本次'+label+'结果尚未确认，不能据此认定操作未执行。')+'请点击“'+readLabel+'”，不会自动重发操作。'+errorText(err));
      }
      else if(pendingSave.current){
        if(!pendingSave.current.started){pendingSave.current=null;setUncertain(false);err=Object.assign(new Error('保存前检查失败，尚未提交草稿。输入已保留，可修改后再次保存。'+errorText(err)),{draftEditable:true});}
        else setUncertain(true);
      }
      setConfirm(null); setError(errorText(err)); setStale(!(err as {draftEditable?:boolean}).draftEditable);
    } finally { if (version === active.current) { lock.current = false; setBusy(false); } }
  }
  function load() {
    if(lock.current)return;
    if(uploadSession.current)return recoverPdf();
    if(pendingTransition.current)return recoverTransition();
    if(pendingSave.current)return recoverSave();
    if((dirty||metaDirty||!!pdf)&&!window.confirm('重新读取会放弃未保存修改和已选但未上传的文件，继续吗？'))return;
    return run(async version => {
      const result = await api<{ articles: Article[] }>('/admin/articles');
      const item=selected?result.articles.find(x=>x.id===selected.id):null,meta=item?await readMeta(item):null;
      await checked(); if (version !== active.current) return;
      if(item&&meta?.revision!==item.revision)throw new Error('内容与栏目版本不一致，请刷新内容列表后重试。');
      // Commit the catalog and editor only after the entire read is authenticated and consistent.
      setItems(result.articles);setReady(true);setPdf(null);
      if(item&&meta){accept(item);setMetadata(meta);setMetaForm(meta);setMessage('内容列表与当前编辑记录已重新读取。');}
      else{setSelected(null);setForm(blank());setMetadata(blankMeta());setMetaForm(blankMeta());setConfirm(null);key.current=crypto.randomUUID();setMessage(selected?'当前编辑记录已不在完整内容列表中，已清除旧选择；未执行发布、删除或其他写入。':'内容列表已读取。');}
      setStale(false);
    });
  }
  useEffect(() => {
    void load();
    return () => { active.current++; lock.current = false; };
  }, [userId]);
  function choose(item: Article | null) {
    if (lock.current || busy || uncertain || uploadSession.current || pendingTransition.current || pendingSave.current?.started || ((dirty||metaDirty||!!pdf) && !window.confirm('放弃当前未保存的修改？'))) return;
    pendingSave.current=null;
    setPdf(null);setMetadata(item?null:blankMeta());setMetaForm(item?null:blankMeta());setSelected(item);setForm(item ? fields(item) : blank());setConfirm(null);setError('');setMessage('');key.current=crypto.randomUUID();
    if(item)void run(async version=>{const meta=await readMeta(item);await checked();if(version!==active.current)return;if(meta.revision!==item.revision)throw new Error('内容与栏目版本不一致，请刷新内容列表后重试。');setMetadata(meta);setMetaForm(meta);setStale(false);});else setStale(false);
  }
  async function save(event: FormEvent) {
    event.preventDefault(); if (uploadSession.current || pendingTransition.current || published || (stale && !uncertain)) return;
    if(pendingSave.current){await recoverSave();return;}
    if (!form.title.trim()) { setError('请填写标题。'); return; }
    if (form.access.visibility === 'plans' && !form.access.planIds.length) { setError('请选择至少一个会员档位。'); return; }
    if (!metaForm) { setError('栏目尚未读取完成，请稍后再保存。'); return; }
    if (metaForm.displayScope !== 'info' && !metaForm.activityGroup) { setError('请选择活动栏目，再保存内容。'); return; }
    const pendingMeta={...metaForm,activityGroup:metaForm.displayScope==='info'?'':metaForm.activityGroup};
    pendingSave.current={content:structuredClone(form),meta:pendingMeta,original:selected,placement:!selected||metaDirty,placementDone:false,contentKey:key.current,metaKey:crypto.randomUUID()};
    await recoverSave(false);
  }
  async function recoverSave(retry=true){
    const pending=pendingSave.current;if(!pending)return;
    await run(async version=>{
      try{
        if(pending.conflict)throw new Error('草稿已有其他修改，未覆盖最新版本。请复制保留当前输入后，放弃本次修改并读取最新记录。');
        if(!pending.article){
          // Existing updates have revision checks, not creation receipts. Read before retrying.
          if(retry&&pending.original){
            const {articles}=await api<{articles:Article[]}>('/admin/articles');
            const latest=articles.find(a=>a.id===pending.original!.id);
            if(!latest||latest.status!=='draft')throw new Error('草稿已撤除或发布，请核对最新记录；当前输入仍保留。');
            if(latest.revision!==pending.original.revision){
              if(latest.revision===pending.original.revision+1&&!sameContent(pending.original,pending.content)&&sameContent(latest,pending.content))pending.article=latest;
              else throw new Error('内容已被其他操作修改，未覆盖最新版本。请复制保留当前输入后，放弃本次修改并读取最新记录。');
            }
          }
          await checked();if(version!==active.current)return;
          if(!pending.article){pending.started=true;const result=await api<{article:Article}>(pending.original?'/admin/articles/'+pending.original.id:'/admin/articles',{...pending.content,...(pending.original?{revision:pending.original.revision}:{})},pending.original?undefined:pending.contentKey);pending.article=result.article;
            // Creation receipts return the current row. A replay must not adopt another editor's revision.
            if(!pending.original&&(result.article.revision!==1||result.article.status!=='draft'||!sameContent(result.article,pending.content))){pending.conflict=true;throw new Error('新建草稿已有其他修改，未覆盖最新版本。请复制保留当前输入后，放弃本次修改并读取最新记录。');}
          }
        }
        await checked();if(version!==active.current)return;
        setSelected(pending.article);setItems(list=>[pending.article!,...list.filter(a=>a.id!==pending.article!.id)]);
        if(pending.placement&&!pending.placementDone){
          await api('/admin/content-meta/'+pending.article.id,{...pending.meta,revision:pending.article.revision},pending.metaKey);
          pending.placementDone=true;
        }
        await reloadSelected(pending.article.id,version);if(version!==active.current)return;
        pendingSave.current=null;setUncertain(false);setMessage('内容与栏目已保存并重新核对，尚未发布。');
      }catch(err){
        if(version!==active.current||err instanceof ChangedSession)throw err;
        const status=(err as {status?:number}).status;
        // A definite validation rejection can be edited; an unknown outcome keeps its exact payload/key.
        const editable=!pending.started||status===400||status===422;
        if(editable){pendingSave.current=null;setUncertain(false);if(!pending.article)key.current=crypto.randomUUID();}
        else setUncertain(true);
        throw Object.assign(new Error((pending.article?'内容草稿已保存；栏目或最终读取尚未确认。':'保存未完成或结果尚未确认。')+errorText(err)+(editable?' 输入已保留，请修改后保存。':' 输入已保留，请重试保存或刷新列表恢复同一次提交，不要重复新建。')),{draftEditable:editable});
      }
    });
  }
  function discardPending(){
    const pending=pendingSave.current;
    if(!pending||busy||!window.confirm('将放弃本次未确认的输入并读取最新记录。请先复制需要保留的文字；已保存的草稿不会删除。继续吗？'))return;
    const id=pending.article?.id||pending.original?.id;if(!id)return;
    void run(async version=>{await reloadSelected(id,version);if(version!==active.current)return;pendingSave.current=null;setUncertain(false);setMessage('已读取最新记录，本次未确认输入已放弃。');});
  }
  async function transition() {
    if (lock.current || uploadSession.current || pendingTransition.current || !selected || !confirm || dirty || metaDirty || stale) return;
    const action = confirm;
    if(action==='delete'&&selected.status!=='draft')return;
    const pending:ContentTransition={id:selected.id,action,revision:selected.revision,started:false};trackTransition(pending);
    await run(async version => {
      pending.started=true;
      let result:{article?:Article};
      try{result=await api<{ article?: Article }>('/admin/articles/' + pending.id + '/' + action, { revision: pending.revision });}
      catch(err){pending.rejected=[400,401,403,404,409,410,422].includes((err as {status?:number}).status||0);throw err;}
      await checked(); if (version !== active.current) return;
      if(action==='delete'){
        setItems(list=>list.filter(i=>i.id!==pending.id));setSelected(null);setForm(blank());setMetadata(blankMeta());setMetaForm(blankMeta());setPdf(null);setConfirm(null);key.current=crypto.randomUUID();setMessage('草稿已删除，已从列表移除；原始记录及文件保留备查。');
      }else{accept(result.article!);setMessage(action === 'publish' ? '已发布，符合阅读范围的用户刷新后可见。' : '已撤下，用户再次读取时将无法访问。');}
      trackTransition(null);
    });
  }
  async function recoverTransition(){
    const pending=pendingTransition.current;if(!pending)return;
    await run(async version=>{
      const result=await api<{articles:Article[]}>('/admin/articles');
      const item=result.articles.find(a=>a.id===pending.id);
      const meta=item?await readMeta(item):null;
      await checked();if(version!==active.current)return;
      if(item&&meta?.revision!==item.revision)throw new Error('读取期间内容版本已变化，请再次读取当前状态。');
      setItems(result.articles);
      if(item&&meta){accept(item);setMetadata(meta);setMetaForm(meta);setMessage('已读取当前状态：'+(item.status==='published'?'已发布':'草稿（未发布）')+'，版本 '+item.revision+'。这不代表一定由上次操作造成；'+(pending.action==='delete'?'没有重发删除。如需删除，请重新确认。':'没有重发发布或撤下。如需操作，请重新确认。'));}
      else{setSelected(null);setForm(blank());setMetadata(blankMeta());setMetaForm(blankMeta());setPdf(null);setMessage(pending.action==='delete'?'当前记录已不在可见列表中，已清除旧删除操作；不能据此认定上次删除已完成。本次核对未删除或清理任何记录和文件，没有重发删除。':'当前记录已不可用，已清除旧操作；未重发发布或撤下。');}
      trackTransition(null);setConfirm(null);setStale(false);
    });
  }
  const publishSteps: string[] = [];
  if (busy) publishSteps.push('当前操作正在进行，请等待结果。');
  if (uncertain || stale) publishSteps.push('上次操作结果待确认，请刷新内容列表，核对原件后再操作，不要重复新建或上传。');
  if (dirty) publishSteps.push('内容或阅读范围有修改：请点击“保存内容与栏目”。');
  if (metaDirty) publishSteps.push('栏目或链接有修改：请点击“保存内容与栏目”。');
  if (selected && !selected.body.trim()) publishSteps.push('缺少正文 / 报告说明：填写简短说明并保存草稿。');
  if (selected?.access.visibility === 'unconfigured') publishSteps.push(selected.document
    ? '阅读权限尚未配置，请按已确认的会员规则设置并保存。'
    : '阅读权限尚未配置：PDF 完整上传后会自动设置；文字或公众号文章请按已确认的范围设置并保存。');
  if (metaForm && metaForm.displayScope !== 'info' && !metaForm.activityGroup) publishSteps.push('请选择活动栏目并保存。');
  if (pdf && !selected?.document && !uploadSession.current) publishSteps.push('已选择的 PDF 尚未确认上传成功：请点击“上传并生成试看”，完成后核对原件。');
  return <section className="article-management" aria-label="资讯报告管理">
    <div className="business-row"><div><h2>资讯报告与活动资料</h2><p>展会 PDF、活动报道和公众号原文均在这里维护。先搜索标题或文件名，已有草稿请继续编辑，避免重复新建。PDF 操作顺序：填写内容与栏目 → 保存内容与栏目 → 上传并生成试看 → 预览原件 → 发布。</p></div><div className="business-actions">
      <button className="button secondary" disabled={busy || uncertain || uploadRecovery || !!transitionRecovery} onClick={() => choose(null)}>新建内容</button>
      <button className="button secondary" disabled={busy} onClick={() => void load()}>刷新内容列表</button>
    </div></div>
    {error && <p className="field-error" role="alert">{error}</p>}{message && <p role="status">{message}</p>}
    {uploadRecovery&&<div role="status"><p>PDF 上传结果待核对，当前原件信息可能尚未更新。核对仅重新读取，不会自动上传或清理文件。暂未读到原件且上传结果仍未知时，暂不能再次上传或切换内容。</p><button type="button" disabled={busy} onClick={()=>void recoverPdf()}>核对当前PDF</button></div>}
    {transitionRecovery&&<div role="status"><p>{transitionRecovery.action==='delete'?'草稿删除操作待核对，当前显示可能是旧状态。请先读取当前草稿状态。':'发布／撤下操作待核对，当前显示可能是旧状态。请先读取当前发布状态。'}</p><button type="button" disabled={busy} onClick={()=>void recoverTransition()}>{transitionRecovery.action==='delete'?'读取当前草稿状态':'读取当前发布状态'}</button></div>}
    {uncertain && <p role="alert">保存结果尚未确认。请保持原文并重试保存，系统会核对同一次提交，避免重复创建。</p>}
    {uncertain&&(pendingSave.current?.article||pendingSave.current?.original)&&<button type="button" disabled={busy} onClick={discardPending}>放弃本次修改并读取最新记录</button>}
    <div className="article-workspace">
      <div className="article-catalog" aria-label="内容列表">
        <label className="field"><span>搜索标题或文件名</span><input type="search" value={search} onChange={e=>setSearch(e.target.value)}/></label>
        <div className="catalog-filters"><label>状态<select aria-label="筛选状态" value={statusFilter} onChange={e=>setStatusFilter(e.target.value)}><option value="all">全部状态</option><option value="draft">草稿</option><option value="published">已发布</option></select></label><label>文件<select aria-label="筛选文件" value={fileFilter} onChange={e=>setFileFilter(e.target.value)}><option value="all">全部内容</option><option value="pdf">已有 PDF</option><option value="none">无 PDF</option></select></label></div>
        {ready && <p>共 {items.length} 条内容 · {items.filter(i=>i.document).length} 份 PDF</p>}
        {!ready && <p>正在读取内容；若读取失败，请刷新重试。</p>}
        {ready && !items.length && <p>暂无内容，从右侧新建草稿开始。</p>}
        {visible.map(item => <button key={item.id} className={'article-choice ' + (selected?.id === item.id ? 'active' : '')}
          disabled={busy || uncertain || uploadRecovery || !!transitionRecovery} onClick={() => choose(item)} aria-pressed={selected?.id === item.id}>
          <strong>{item.title}</strong><span>{item.document ? '报告' : '资讯'} · {item.status === 'draft' ? '草稿' : '已发布'}</span><small>{item.document ? 'PDF 已上传 · '+item.document.pages+' 页' : '未关联 PDF（文字或公众号内容无需上传）'}</small><small>{audience(item.access)}</small>
        </button>)}
        {ready&&!matching.length&&<p>没有符合条件的内容，请更换关键词或筛选条件。</p>}
        <nav className="catalog-pagination" aria-label="内容分页"><label>每页<select aria-label="每页条数" value={size} onChange={e=>setSize(Number(e.target.value))}>{[10,20,50].map(n=><option key={n} value={n}>{n} 条</option>)}</select></label><span>共 {matching.length} 条 · 第 {currentPage} / {pages} 页</span><div><button type="button" disabled={currentPage===1} onClick={()=>setPage(currentPage-1)}>上一页</button><button type="button" disabled={currentPage===pages} onClick={()=>setPage(currentPage+1)}>下一页</button><label>跳至<select aria-label="跳至页码" value={currentPage} onChange={e=>setPage(Number(e.target.value))}>{Array.from({length:pages},(_,i)=><option key={i+1} value={i+1}>{i+1}</option>)}</select></label></div></nav>
      </div>
      <div className="form-panel article-editor">
        <nav className="editor-shortcuts" aria-label="编辑步骤">{[['article-content-form','1 内容'],['article-placement','2 栏目'],['article-file','3 PDF'],['article-publish','4 发布']].map(([id,label])=><button type="button" key={id} onClick={()=>document.getElementById(id)?.scrollIntoView({block:'start',behavior:'smooth'})}>{label}</button>)}</nav>
        {selected?.document && <section aria-label="报告原件"><h3>PDF 已上传成功 · 报告原件</h3><p>{selected.document.filename} · {selected.document.pages} 页 · {(selected.document.bytes/1048576).toFixed(1)} MB</p><div className="business-actions"><a className="button secondary" target="_blank" rel="noopener noreferrer" href={(isWebTrial?'/hejun-club/api':'/api')+'/admin/articles/'+selected.id+'/document'}>预览 PDF</a><a className="button secondary" href={(isWebTrial?'/hejun-club/api':'/api')+'/admin/articles/'+selected.id+'/document?download=1'}>下载原件</a></div></section>}
        <h3>{selected ? '编辑内容' : '新建草稿'}</h3>
        {selected&&<p role="status">当前编辑：{selected.title}。{!matching.some(item=>item.id===selected.id)?'该记录不在当前筛选结果中，筛选不会切换编辑对象。':!visible.some(item=>item.id===selected.id)?'该记录不在当前列表页，翻页不会切换编辑对象。':''}</p>}
        {selected && <p className="small">{selected.status === 'draft' ? '草稿' : '已发布'} · 版本 {selected.revision} · {audience(selected.access)}</p>}
        {published && <p>请先撤下内容，再修改并重新发布。</p>}
        {stale&&<p role="alert">操作结果需核对。请刷新内容列表读取最新版本后再操作。</p>}
        <form id="article-content-form" onSubmit={save}>
          <fieldset disabled={busy || published || uncertain || stale || uploadRecovery}>
            {selected?.document?.previewPages&&form.access.visibility==='plans'?<label><input type="checkbox" checked={form.access.previewPages===10} onChange={e=>setForm({...form,access:{...form.access,previewPages:e.target.checked?10:0}})}/>允许其他访客试看前10页（不足10页显示全部）</label>:null}
            <label className="field"><span id="article-title-label">内容标题</span><input aria-labelledby="article-title-label" required maxLength={80} value={form.title} onChange={e => setForm({ ...form, title: e.target.value })}/></label>
            <label className="field"><span id="article-category-label">原始内容类型</span><select aria-labelledby="article-category-label" value={form.category} onChange={e => setForm({ ...form, category: e.target.value as Content['category'] })}><option value="news">资讯</option><option value="knowledge">知识资料</option></select></label>
            <label className="field"><span id="article-summary-label">内容摘要</span><textarea aria-labelledby="article-summary-label" maxLength={180} rows={2} value={form.summary} onChange={e => setForm({ ...form, summary: e.target.value })}/></label>
            <label className="field"><span id="article-body-label">{metaForm?.originalUrl ? '公众号文章简介（发布前必填）' : '内容正文 / 报告说明（发布前必填）'}</span><textarea aria-labelledby="article-body-label" maxLength={4000} rows={10} value={form.body} onChange={e => setForm({ ...form, body: e.target.value })}/></label>
            <label className="field"><span id="article-access-label">阅读范围</span><select aria-labelledby="article-access-label" value={form.access.visibility} onChange={e => setForm({ ...form, access: { visibility: e.target.value as Access['visibility'], planIds: [] } })}>
              <option value="unconfigured">待配置（PDF 上传成功后自动设置）</option><option value="public">所有访客（公开）</option><option value="plans">指定会员档位</option>
            </select></label>
            {form.access.visibility === 'plans' && <div className="article-plans">{plans.map(plan => <label key={plan.id}><input type="checkbox" checked={form.access.planIds.includes(plan.id)} onChange={e => setForm({ ...form, access: { ...form.access, planIds: e.target.checked ? [...form.access.planIds, plan.id] : form.access.planIds.filter(id => id !== plan.id) } })}/>{plan.name}</label>)}<p className="small">仅所选档位的有效会员可读，各档位不自动互通。</p></div>}
          </fieldset>
        </form>
        {<section id="article-placement" aria-label="内容归属"><h3>内容归属</h3><p className="small">先选择展示位置，再选择对应栏目。两处展示使用同一篇内容，不会生成两份记录。PDF 保留原件图文，公众号全文通过原文入口打开。</p><fieldset disabled={busy||published||uncertain||stale||uploadRecovery||!metaForm}>
          <p className="field-error" role="note">此处可保存新的展示范围；小程序端配套更新尚未发布，旧版小程序可能仍按原栏目展示。公众号全文入口也需配套更新后生效。</p>
          <label className="field"><span>展示位置</span><select value={metaForm?.displayScope||'info'} onChange={e=>{if(!metaForm)return;const displayScope=e.target.value as Metadata['displayScope'];setMetaForm({...metaForm,displayScope,activityGroup:displayScope==='info'?'':metaForm.activityGroup});}}><option value="info">仅资讯</option><option value="activity">仅活动</option><option value="both">两处展示</option></select></label>
          <p className="small">“资讯”包含资讯报告、落地加速及专业服务资料等内容栏目；“活动”包含行业沙龙、热门展会及线上活动的资料入口。</p>
          {metaForm?.displayScope !== 'activity' && <>
          <label className="field"><span>资讯展示栏目（与小程序对应）</span><select value={!metaForm?'launch':metaForm.supportCategory?'support':metaForm.section==='landing'?metaForm.topic==='unclassified'?'landing-unclassified':metaForm.topic:metaForm.section} onChange={e=>{if(!metaForm)return;const v=e.target.value;setMetaForm({...metaForm,section:['policy','practice','support','landing-unclassified'].includes(v)?'landing':v as Metadata['section'],topic:v==='policy'?'policy':v==='practice'?'practice':'unclassified',policyCategory:'',practiceCategory:'',supportCategory:v==='support'?'parks':''});}}>
            <option value="launch">出海启航 → 资讯报告</option><option value="support">落地加速 → 落地配套</option><option value="policy">落地加速 → 政策法规</option><option value="practice">落地加速 → 经营实务</option><option value="professional">专业护航 → 专业服务资料</option>{metaForm?.section==='landing'&&metaForm.topic==='unclassified'&&!metaForm.supportCategory&&<option value="landing-unclassified">落地加速 → 尚未确定栏目（请选择）</option>}
          </select></label>
          {!!metaForm?.supportCategory&&<label className="field"><span>落地配套分类</span><select value={metaForm.supportCategory} onChange={e=>setMetaForm({...metaForm,supportCategory:e.target.value as Metadata['supportCategory']})}><option value="parks">产业园一览</option><option value="associations">商协会查询</option><option value="opportunities">找商机挖掘</option></select></label>}
          {metaForm?.section==='landing'&&metaForm.topic==='policy'&&<label className="field"><span>政策分类</span><select value={metaForm.policyCategory||''} onChange={e=>setMetaForm({...metaForm,policyCategory:e.target.value as Metadata['policyCategory']})}><option value="">待分类（仍在政策法规全部列表）</option><option value="investment">国别投资规则</option><option value="compliance">出海合规政策</option><option value="guides">合规指南文库</option></select></label>}
          {metaForm?.section==='landing'&&metaForm.topic==='practice'&&<label className="field"><span>实务分类</span><select value={metaForm.practiceCategory||''} onChange={e=>setMetaForm({...metaForm,practiceCategory:e.target.value as Metadata['practiceCategory']})}><option value="">待分类（仍在经营实务全部列表）</option><option value="cases">出海实战案例</option><option value="methods">跨境实操方法</option><option value="library">实务资料库</option></select></label>}
          </>}
          {metaForm?.displayScope !== 'info' && <label className="field"><span>活动展示栏目（必选）</span><select value={metaForm?.activityGroup||''} onChange={e=>metaForm&&setMetaForm({...metaForm,activityGroup:e.target.value as Metadata['activityGroup']})}><option value="">请选择活动栏目</option><option value="salon">行业沙龙</option><option value="expo">热门展会</option><option value="online">线上活动</option></select></label>}
          <label><input type="checkbox" checked={metaForm?.isRecap||false} onChange={e=>metaForm&&setMetaForm({...metaForm,isRecap:e.target.checked})}/>已举办的活动报道，标记“活动回顾”</label>
          <label className="field"><span>公众号原文链接（选填）</span><input type="url" maxLength={4096} value={metaForm?.originalUrl||''} disabled={!!selected?.document} placeholder="https://mp.weixin.qq.com/s/..." onChange={e=>metaForm&&setMetaForm({...metaForm,originalUrl:e.target.value})}/></label>
          <p className="small">公众号标题填写在“内容标题”，正文只需简短说明。原文须为公开文章；配套小程序更新后，可通过“阅读公众号原文”查看完整图文，不会自动把公众号全文复制到正文。PDF 与原文链接二选一，已有报道选择展示位置即可复用，不用重复上传。</p>
          <p className="small">栏目与内容填写完成后，统一点击下方“保存内容与栏目”。</p></fieldset></section>}
          {!published && <button className="button primary" disabled={busy || uploadRecovery || (stale && !uncertain)} type="submit" form="article-content-form">{uncertain ? '重试保存草稿' : '保存内容与栏目'}</button>}
        {selected&&<section id="article-file" aria-label="上传报告"><h3>上传 PDF 原件（保留图文）</h3>{!selected.document&&!pdf&&!uploadProgress&&<p>尚未确认有 PDF 原件。若本条是 PDF 资料，请选择文件并上传；纯文字或公众号文章可跳过。</p>}{(dirty||metaDirty)&&<p>上传前请先点击“保存内容与栏目”。</p>}{!!metaForm?.originalUrl&&<p>已填写公众号原文链接，本条不再上传 PDF。</p>}<p>上传会保留PDF原件、图片和排版，并自动设置：基础会员试看前10页，星级及机构专业会员全文。请先保存内容与栏目，再上传不超过15MB、300页的PDF。少于10页会全部显示在试看中。</p>{selected.document&&<p>此内容已有 PDF，不支持覆盖原文件。需要新文件时请新建草稿，保留原报告。</p>}<fieldset disabled={busy||uploadRecovery||published||dirty||metaDirty||stale||!!selected.document||!!metaForm?.originalUrl}><label className="field"><span>选择 PDF 文件</span><input ref={pdfInput} key={selected.id+':'+selected.revision} type="file" accept=".pdf,application/pdf" onChange={e=>{setPdf(e.target.files?.[0]||null);}}/></label>{pdf&&<p role="status">{uploadRecovery?'本次文件（结果待核对）':uploadSession.current?'本次上传文件':'已选择，尚未上传'}：{pdf.name} · {(pdf.size/1048576).toFixed(1)} MB{!uploadSession.current&&'。请点击“上传并生成试看”。'}</p>}<button type="button" className="button secondary" disabled={!pdf} onClick={()=>void uploadPdf()}>上传并生成试看</button></fieldset>{uploadProgress&&<p role="status">{uploadProgress}</p>}{canCancelUpload&&<button type="button" className="button secondary" onClick={()=>void cancelUpload()}>取消本次上传</button>}</section>}
        {selected&&!published&&<section id="article-publish" aria-label="发布检查" aria-live="polite"><h3>发布前还缺哪一步</h3>{publishSteps.length ? <ul>{publishSteps.map(step=><li key={step}>{step}</li>)}</ul> : <p>当前已保存的内容满足发布条件。{selected.document ? 'PDF 已上传，请先点击“预览 PDF”核对图文和页数，再发布。' : '本条没有 PDF 原件；若准备发布 PDF 资料，请先上传；文字或公众号文章可直接发布。'}</p>}<p>草稿不会在小程序展示；点击“发布内容”并确认后才会展示。</p></section>}
        {selected && <div className="business-actions">
          {!published&&<button type="button" className="text-button" disabled={busy||dirty||metaDirty||uncertain||stale||!!pdf} onClick={()=>setConfirm('delete')}>删除草稿</button>}
          <button className="button secondary" disabled={busy || dirty || metaDirty || uncertain || stale || (!published && (!!pdf || !metaForm || (metaForm.displayScope !== 'info' && !metaForm.activityGroup) || selected.access.visibility === 'unconfigured' || !selected.body.trim()))}
            onClick={() => setConfirm(published ? 'unpublish' : 'publish')}>{published ? '撤下内容' : '发布内容'}</button>
          <button className="text-button" disabled={busy || uncertain} onClick={() => {
            if(uploadSession.current){void recoverPdf();return;}
            if(pendingTransition.current){void recoverTransition();return;}
            const latest = items.find(a => a.id === selected.id); if (latest) choose(latest);
          }}>重新载入所选内容</button>
        </div>}
        {selected&&!published&&!selected.body.trim()&&<p className="small">发布前请填写内容正文；PDF 报告请填写简短的报告说明，保存后再发布。</p>}
        {dirty && selected && <p className="small">有未保存的修改，保存后才能发布。</p>}
        {confirm && selected && <div className="article-confirm" role="group" aria-label="确认内容操作">
          <p>{confirm === 'delete' ? '确认删除草稿' : confirm === 'publish' ? '确认发布' : '确认撤下'}：{selected.title}</p><p>阅读范围：{audience(selected.access)}</p>{confirm==='publish'&&metaForm&&<p>展示位置：{metaForm.displayScope==='info'?'仅资讯':metaForm.displayScope==='activity'?'仅活动':'资讯与活动两处展示'}{metaForm.originalUrl?'；配套小程序更新后可通过“阅读公众号原文”打开完整图文。':''}</p>}{confirm==='delete'&&<p>此草稿将从工作列表移除，不能继续编辑或发布。原始记录和文件保留备查。请确认标题，避免误删。</p>}
          <button className="button primary" disabled={busy} onClick={() => void transition()}>{confirm === 'delete' ? '确认删除草稿' : confirm === 'publish' ? '确认发布' : '确认撤下'}</button>
          <button className="button secondary" disabled={busy} onClick={() => setConfirm(null)}>暂不操作</button>
        </div>}
      </div>
    </div>
  </section>;
}

