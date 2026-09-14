import { useEffect, useRef, useState } from 'react';
import { api, errorText } from './api';
import type { Session } from './api';

interface Ticket { id:string; title:string; category:string; status:'open'|'processing'|'resolved'; revision:number; createdAt:string; confirmedAt?:string|null; relatedOrderId?:string|null; body?:string;
  events?:{authorKind?:string;id:number; action:string; body:string; status:string; createdAt:string}[] }
const labels={open:'待受理',processing:'处理中',resolved:'已回复，待用户确认'};
export function AdminFeedback({userId}:{userId:string}) {
  const [tickets,setTickets]=useState<Ticket[]>([]),[selected,setSelected]=useState<Ticket|null>(null),[cursor,setCursor]=useState<string|null>(null);
  const [reply,setReply]=useState(''),[resolution,setResolution]=useState<'processing'|'resolved'>('processing');
  const [busy,setBusy]=useState(false),[ready,setReady]=useState(false),[error,setError]=useState(''),[message,setMessage]=useState('');
  const generation=useRef(0),lock=useRef(false),pending=useRef({payload:'',key:''});
  async function identity(){const session=await api<Session>('/me');if(session.user?.id!==userId||session.user.role!=='admin')throw new Error('登录状态已变化，请重新登录管理后台。');}
  async function run(work:(stamp:number)=>Promise<void>){
    if(lock.current)return;lock.current=true;const stamp=generation.current;setBusy(true);setError('');setMessage('');
    try{await identity();if(stamp===generation.current)await work(stamp);}
    catch(err){if(stamp===generation.current){const text=errorText(err);if(text.includes('登录')||text.includes('管理员')){setTickets([]);setSelected(null);setReply('');setReady(false);}setError(text);}}
    finally{if(stamp===generation.current){lock.current=false;setBusy(false);}}
  }
  function load(more=false){
    if(!more&&reply.trim()&&!window.confirm('放弃当前未发送的回复并刷新？'))return;
    return run(async stamp=>{
      const result=await api<{tickets:Ticket[];nextCursor:string|null}>('/admin/feedback'+(more&&cursor?'/before/'+cursor:''));
      await identity();if(stamp!==generation.current)return;
      setTickets(old=>more?[...old,...result.tickets]:result.tickets);setCursor(result.nextCursor);setReady(true);
      if(!more){setSelected(null);setReply('');}
    });
  }
  useEffect(()=>{void load();return()=>{generation.current++;lock.current=false;};},[userId]);
  function choose(id:string){
    if(reply.trim()&&!window.confirm('放弃当前未发送的回复？'))return;
    return run(async stamp=>{const result=await api<{ticket:Ticket}>('/admin/feedback/'+id);await identity();if(stamp!==generation.current)return;
      setSelected(result.ticket);setReply('');setResolution('processing');pending.current={payload:'',key:''};});
  }
  function handle(action:'accept'|'reply'){
    if(!selected||selected.status==='resolved')return;
    if(action==='reply'&&!reply.trim()){setError('请填写回复内容。');return;}
    return run(async stamp=>{
      const body={revision:selected.revision,...(action==='reply'?{body:reply.trim(),status:resolution}:{})};
      const payload=JSON.stringify({id:selected.id,action,body});
      if(pending.current.payload!==payload)pending.current={payload,key:crypto.randomUUID()};
      const result=await api<{ticket:Ticket}>('/admin/feedback/'+selected.id+'/'+action,body,pending.current.key);
      await identity();if(stamp!==generation.current)return;
      setSelected(result.ticket);setTickets(old=>old.map(t=>t.id===result.ticket.id?result.ticket:t));setReply('');pending.current={payload:'',key:''};
      setMessage(action==='accept'?'已受理，用户刷新即可查看。':'回复已保存，用户可在反馈详情查看。');
    });
  }
  return <section aria-label="帮助反馈管理"><div className="business-row"><div><h2>帮助反馈</h2><p>受理问题并回复，历史内容按顺序保留。</p></div><button className="button secondary" disabled={busy} onClick={()=>void load()}>刷新反馈列表</button></div>
    {error&&<p role="alert">{error}</p>}{message&&<p role="status">{message}</p>}{!ready&&<p>正在读取反馈；读取失败可刷新重试。</p>}
    {selected&&<section className="form-panel feedback-admin-detail" aria-label="反馈详情"><h3>{selected.title}</h3><p>{selected.confirmedAt?'用户已确认解决':labels[selected.status]} · 版本 {selected.revision}</p><p className="mono small">{selected.id}</p><p style={{whiteSpace:'pre-wrap',overflowWrap:'anywhere'}}>{selected.body}</p>{selected.relatedOrderId&&<p className="mono small">关联订单：{selected.relatedOrderId}</p>}
      {selected.events?.map(event=><article key={event.id}><p>{event.authorKind==='member_followup'?'用户补充':event.authorKind==='member_confirm'?'用户确认':event.action==='accept'?'已受理':'后台回复'} · {new Date(event.createdAt).toLocaleString('zh-CN')}</p><p style={{whiteSpace:'pre-wrap',overflowWrap:'anywhere'}}>{event.body}</p><p>{labels[event.status as keyof typeof labels]}</p></article>)}
      {selected.status==='open'&&<button className="button secondary" disabled={busy} onClick={()=>void handle('accept')}>受理此反馈</button>}
      {selected.status!=='resolved'&&<form onSubmit={event=>{event.preventDefault();void handle('reply');}}>
        <label className="field"><span id="feedback-reply-label">回复内容</span><textarea aria-labelledby="feedback-reply-label" required rows={5} maxLength={2000} disabled={busy} value={reply} onChange={event=>setReply(event.target.value)}/></label>
        <label className="field"><span id="feedback-resolution-label">回复后的状态</span><select aria-labelledby="feedback-resolution-label" disabled={busy} value={resolution} onChange={event=>setResolution(event.target.value as 'processing'|'resolved')}><option value="processing">继续处理中</option><option value="resolved">请用户确认是否解决</option></select></label>
        <button className="button primary" disabled={busy}>保存回复</button>
      </form>}
      <button className="text-button" disabled={busy} onClick={()=>void choose(selected.id)}>重新读取当前反馈</button>
    </section>}
    <div className="business-admin-list">{tickets.map(ticket=><article className="form-panel" key={ticket.id}><div className="business-row"><h3>{ticket.title}</h3><span>{ticket.confirmedAt?'用户已确认解决':labels[ticket.status]}</span></div><p className="mono small">{ticket.id}</p><button className="button secondary" disabled={busy} onClick={()=>void choose(ticket.id)}>查看并处理</button></article>)}</div>
    {ready&&!tickets.length&&<p>暂无反馈。</p>}{cursor&&<button className="button secondary" disabled={busy} onClick={()=>void load(true)}>加载更早反馈</button>}
  </section>;
}
