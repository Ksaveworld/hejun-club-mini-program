import { isWebTrial } from './web-env';
import { useEffect, useRef, useState } from 'react';
import type { FormEvent } from 'react';
import { ArrowRight, ArrowLeft, ChevronRight, ShieldCheck, RefreshCw } from 'lucide-react';
import { plans } from './data';
import { money, dateLabel } from './store';
import type { JoinForm, Plan } from './types';
import { api, errorText, statusLabels, postLabels, referralHint, clearReferralHint } from './api';
import type { Order, Post, Session, User, Membership } from './api';
import './business.css';
import { AdminArticles } from './AdminArticles';
import {AdminActivities} from './Activities';
import { AdminServices } from './AdminServices';
import { AdminAudit } from './AdminAudit';
import { AdminFeedback } from './AdminFeedback';

export function Login({ refresh, admin = false }: { refresh: () => Promise<void>; admin?: boolean }) {
  const [register,setRegister] = useState(false);
  const [username,setUsername] = useState('');
  const [password,setPassword] = useState('');
  const [consent,setConsent] = useState(false);
  const [referral,setReferral] = useState(referralHint);
  const [busy,setBusy] = useState(false), [error,setError] = useState('');
  async function submit(event: FormEvent) {
    event.preventDefault(); if (busy) return;
    setBusy(true); setError('');
    try {
      await api(`/auth/${register ? 'register' : 'login'}`,{ username,password,consent,referral });
      clearReferralHint(); await refresh();
    } catch (err) { setError(errorText(err)); } finally { setBusy(false); }
  }
  return <section className="business-auth">
    <div className="page-heading"><span className="eyebrow">{admin ? '运营工作台' : '会员账号'}</span><h1 id="page-title" tabIndex={-1}>{register ? '创建内测账号' : admin ? '管理员登录' : '登录会员账号'}</h1><p>{isWebTrial?'资料和订单保存在服务器，重新登录后仍可查看。':'资料和订单保存在本机数据服务，重新登录后仍可查看。'}</p></div>
    <form className="form-panel" onSubmit={submit}>
      <label className="field"><span>账号</span><input name="username" autoComplete="username" pattern="[a-zA-Z0-9_]{4,32}" minLength={4} maxLength={32} required placeholder="4–32 位字母、数字或下划线" value={username} onChange={e=>setUsername(e.target.value)} /></label>
      <label className="field"><span>密码</span><input name="password" type="password" autoComplete={register ? 'new-password' : 'current-password'} minLength={10} maxLength={128} required placeholder="至少 10 位，请勿使用常用密码" value={password} onChange={e=>setPassword(e.target.value)} /></label>
      {register && <><label className="field"><span>推荐码（选填）</span><input maxLength={6} value={referral} onChange={e=>setReferral(e.target.value.toUpperCase())} placeholder="可留空，由后台按配置处理" /></label><label className="consent"><input type="checkbox" required checked={consent} onChange={e=>setConsent(e.target.checked)} /><span>我同意将体验账号、申请和订单保存在{isWebTrial?'当前服务器':'当前电脑'}，仅使用虚构联系资料。正式协议与隐私政策待提供，本说明不代表正式入会协议。</span></label></>}
      {error && <p className="field-error" role="alert">{error}</p>}
      <button className="button primary full" disabled={busy}>{busy ? '正在处理…' : register ? '注册并登录' : '登录'}<ArrowRight size={17}/></button>
      {!admin && <button className="text-button" type="button" onClick={()=>{setRegister(!register);setError('');}}>{register ? '已有账号，去登录' : '没有账号，创建内测账号'}</button>}
    </form>
    <p className="section-note">{admin ? (isWebTrial?'管理员由项目负责人单独分配；会员注册不会获得后台权限。':'管理员由本机单独创建，登录资料见项目 work/local-admin.txt。会员注册不会获得后台权限。') : '尚未连接微信或短信验证。这里的账号可用于内测，不代表已核验真实身份。'}</p>
    <a className="text-button" href={admin ? '#/account' : '#/admin'}>{admin ? '返回会员登录' : '运营人员登录'}</a>
  </section>;
}

export function JoinMember({ plan, session, refresh }: { plan: Plan; session: Session; refresh: () => Promise<void> }) {
  const [form,setForm] = useState<JoinForm>({name:'',phone:'',city:'',company:'',industry:'',need:'',referral:session.user?.sourceCode || referralHint(),organizationType:'机构会员'});
  const [consent,setConsent] = useState(false), [error,setError] = useState(''), [busy,setBusy] = useState(false);
  const key = useRef(crypto.randomUUID());
  const fingerprint = useRef('');
  if (!session.user) return <Login refresh={refresh}/>;
  if (session.user.role === 'admin') return <div className="notice-card"><h1>请使用会员账号申请</h1><p>管理员账号用于审核。请先在“我的”退出，再注册会员账号。</p><a href="#/account">前往账号管理</a></div>;
  function field(name: keyof JoinForm, label: string, required = false, max = 60) {
    return <label className="field" key={name} htmlFor={name}><span>{label}<small>{required ? '必填' : '选填'}</small></span><input id={name} required={required} value={form[name]} maxLength={max} inputMode={name==='phone'?'tel':'text'} pattern={name==='phone'?'1[0-9]{10}':undefined} disabled={name==='referral' && !!session.user?.sourceCode && session.user.referralSource==='explicit'} onChange={e=>setForm({...form,[name]:name==='referral'?e.target.value.toUpperCase():e.target.value})}/></label>;
  }
  async function submit(event: FormEvent) {
    event.preventDefault(); if (busy) return;
    const body = {planId:plan.id,form,consent};
    const serialized = JSON.stringify(body);
    if (fingerprint.current && fingerprint.current !== serialized) key.current = crypto.randomUUID();
    fingerprint.current = serialized;
    setBusy(true); setError('');
    try {
      const {order} = await api<{order:Order}>('/orders',body,key.current);
      clearReferralHint(); await refresh(); window.location.hash=`/checkout/${order.id}`;
    } catch (err) { setError(errorText(err)); } finally { setBusy(false); }
  }
  return <><a className="back-link" href="#/members"><ArrowLeft size={17}/>返回会员权益</a>
    <div className="page-heading"><span className="eyebrow">加入俱乐部</span><h1 id="page-title" tabIndex={-1}>填写入会信息</h1><p>{plan.id==='organization'?'资质审核通过后再付款，付款成功后开通。':'基础与星级会员付款成功后开通，无需资质预审。'}</p></div>
    <aside className={`join-summary ${plan.id}`}><span className="eyebrow">已选方案</span><h2>{plan.name}</h2><div className="price"><small>¥</small>{money(plan.price)}<span>/ 年</span></div><p>有效期从核验付款成功时起算一年。</p></aside>
    <form className="form-panel business-join" onSubmit={submit}>
      <p className="muted">{isWebTrial?'当前为业务体验，请使用虚构联系资料。':'当前为本机内测，请使用虚构联系资料。'}订单会实际保存，支付尚未接通。</p>
      <div className="form-grid">{field('name','姓名 / 称呼',true)}{field('phone','手机号码',true,11)}{field('city','所在城市',true)}{field('company',plan.id==='organization'?'机构名称':'企业名称',plan.id==='organization',100)}
        {plan.id==='organization' && <label className="field"><span>申请类型</span><select value={form.organizationType} onChange={e=>setForm({...form,organizationType:e.target.value})}><option>机构会员</option><option>专业会员</option></select></label>}
        {field('industry','所在行业')}{field('referral','推荐码',false,6)}
      </div>
      <label className="field"><span>你希望获得什么支持？</span><textarea rows={3} maxLength={300} value={form.need} onChange={e=>setForm({...form,need:e.target.value})}/></label>
      <p className="small muted">{session.user.sourceCode ? `已保存推荐来源 ${session.user.sourceCode}，已有有效来源不会被覆盖。` : session.defaultReferralConfigured ? '不填写推荐码时使用后台默认来源。' : '推荐码可留空；后台默认值尚待提供，不会自动指定推荐人。'} 手机号码尚未验证。</p>
      <label className="consent"><input type="checkbox" required checked={consent} onChange={e=>setConsent(e.target.checked)}/><span>我同意将本次虚构联系资料及订单保存在{isWebTrial?'当前服务器':'当前电脑'}，用于体验。正式协议与权益资料待提供；本次提交不会收款。</span></label>
      {error && <p className="field-error" role="alert">{error} <a href="#/account?tab=orders">查看我的订单</a></p>}
      <div className="form-bottom"><span><strong>下一步</strong>{plan.id==='organization'?'等待资质审核':'查看待付款订单'}</span><button className="button primary" disabled={busy}>{busy?'保存中…':plan.id==='organization'?'提交资质申请':'保存订单'}<ArrowRight size={17}/></button></div>
    </form></>;
}

export function OrderPage({ id, refresh }: { id: string; refresh: () => Promise<void> }) {
  const [order,setOrder] = useState<Order|null>(null), [error,setError] = useState(''), [busy,setBusy] = useState(false);
  const [confirmCancel,setConfirmCancel] = useState(false);
  async function load() { setError(''); try {setOrder((await api<{order:Order}>(`/orders/${id}`)).order);} catch(err){setError(errorText(err));} }
  useEffect(()=>{void load();},[id]);
  async function cancel() {setBusy(true);setError('');try {setOrder((await api<{order:Order}>(`/orders/${id}/cancel`,{})).order);setConfirmCancel(false);await refresh();} catch(err){setError(errorText(err));} finally{setBusy(false);} }
  return <div className="narrow-page"><a className="back-link" href="#/account?tab=orders"><ArrowLeft size={17}/>我的订单</a><div className="page-heading"><span className="eyebrow">会员订单</span><h1 id="page-title" tabIndex={-1}>{order?statusLabels[order.status]:'查看订单'}</h1></div>
    {error && <p className="field-error" role="alert">{error}</p>}
    {order && <section className="checkout-card"><div className="checkout-plan"><div><h2>{plans.find(p=>p.id===order.planId)?.name}</h2><p>{order.status==='review'?'请等待管理员核验资质。':'付款成功后开通并起算有效期。'}</p></div><div className="price"><small>¥</small>{money(order.amountCents/100)}</div></div>
      <dl className="order-details">{[['订单编号',order.id],['称呼',order.form.name],['联系手机',`${order.form.phone}（未验证）`],['申请类型',order.planId==='organization'?order.form.organizationType:'个人会员'],['推荐来源',order.sourceCode || '未指定 · 默认值待配置'],['保存时间',new Date(order.createdAt).toLocaleString('zh-CN')],...(order.reviewNote?[['审核说明',order.reviewNote]]:[]),...(order.paidAt?[['付款时间',new Date(order.paidAt).toLocaleString('zh-CN')],['有效期至',dateLabel(order.expiresAt ?? undefined)],['实际付款',`¥${money((order.actualPaidCents??0)/100)}`]]:[])].map(([label,value])=><div key={label}><dt>{label}</dt><dd>{value}</dd></div>)}</dl>
      {order.status==='pending' && <div className="payment-demo"><ShieldCheck size={22}/><div><strong>支付尚未开放</strong><p>微信支付账号尚未接通，订单已保存。当前不会收款或开通会员，接通并验收后才能付款。</p></div></div>}
      {isWebTrial&&order.status==='rejected'&&<a className="button primary" href={'#/join/'+order.planId+'?reapplyId='+order.id}>修改资料，重新申请</a>}
      {order.status==='review' && <p className="inline-note">先审核、后付款。审核通过不代表已开通会员。</p>}
      {['pending','review'].includes(order.status) && <div className="business-actions">{confirmCancel?<><p>取消后可重新选择方案，原订单记录仍会保留。</p><button className="button secondary" onClick={()=>setConfirmCancel(false)}>保留订单</button><button className="button primary" disabled={busy} onClick={()=>void cancel()}>确认取消订单</button></>:<button className="button secondary" onClick={()=>setConfirmCancel(true)}>取消订单</button>}</div>}
    </section>}
    <button className="text-button" onClick={()=>void load()}><RefreshCw size={16}/>刷新订单状态</button></div>;
}

export function AccountPage({session,refresh}:{session:Session;refresh:()=>Promise<void>}) {
  const [orders,setOrders] = useState<Order[]>([]), [posts,setPosts] = useState<Post[]>([]);
  const [error,setError] = useState(''), [message,setMessage] = useState('');
  const [title,setTitle] = useState(''), [body,setBody] = useState(''), [busy,setBusy] = useState(false);
  const requestedTab = new URLSearchParams(location.hash.split('?')[1]).get('tab') || 'orders';
  const tab = ['orders','referral','posts'].includes(requestedTab) ? requestedTab : 'orders';
  const tabTitle = tab === 'orders' ? '我的订单' : tab === 'referral' ? '推荐关系' : '我的投稿';
  const key = useRef(crypto.randomUUID()), postFingerprint = useRef('');
  async function load() { if(!session.user) return; setError(''); try{const [o,p]=await Promise.all([api<{orders:Order[]}>('/orders'),api<{posts:Post[]}>('/posts')]);setOrders(o.orders);setPosts(p.posts);}catch(err){setError(errorText(err));} }
  useEffect(()=>{void load();},[session.user?.id]);
  if (!session.user) return <Login refresh={refresh}/>;
  async function submit(event:FormEvent) {
    event.preventDefault(); if(busy) return;setBusy(true);setError('');setMessage('');
    const serialized = JSON.stringify({title,body});
    if(postFingerprint.current && postFingerprint.current!==serialized) key.current=crypto.randomUUID();
    postFingerprint.current=serialized;
    try{await api('/posts',{title,body},key.current);key.current=crypto.randomUUID();postFingerprint.current='';setTitle('');setBody('');setMessage('投稿已保存，等待审核。');await load();}catch(err){setError(errorText(err));}finally{setBusy(false);}
  }
  return <><div className="page-heading account-page-heading"><h1 id="page-title" tabIndex={-1}>{tabTitle}</h1><p>{session.user.username} · {session.user.role==='admin'?'本机管理员':'内测账号'}</p></div>
    {error && <p className="field-error" role="alert">{error}</p>}
    <div className="tab-row" role="tablist" aria-label="会员中心栏目">{[['orders','我的订单'],['referral','推荐关系'],['posts','我的投稿']].map(([value,label])=><button key={value} role="tab" aria-selected={tab===value} className={tab===value?'active':''} onClick={()=>{window.location.hash=`/account?tab=${value}`;}}>{label}</button>)}</div>
    <div role="tabpanel">{tab==='orders'?<div className="order-list">{orders.length?orders.map(o=><a className="account-order" href={`#/checkout/${o.id}`} key={o.id}><div><strong>{plans.find(p=>p.id===o.planId)?.name}</strong><span className="small muted">{dateLabel(o.createdAt)}</span><span className="small mono">{o.id}</span></div><div><strong>¥{money(o.amountCents/100)}</strong><span className={`status-pill ${o.status}`}>{statusLabels[o.status]}</span></div><ChevronRight size={17}/></a>):<div className="app-empty-inline">暂无订单。<a href="#/members">了解会员权益</a></div>}<button className="text-button" onClick={()=>void load()}><RefreshCw size={16}/>刷新我的记录</button></div>:tab==='referral'?<section className="form-panel"><h2>我的推荐信息</h2><dl className="order-details"><div><dt>我的推荐码</dt><dd className="mono">{session.user.referralCode}</dd></div><div><dt>入会推荐来源</dt><dd>{session.user.sourceCode || '未指定 · 默认值待配置'}</dd></div><div><dt>来源状态</dt><dd>{session.user.referralLockedAt?'已随付款锁定':session.user.referralSource==='explicit'?'已保留首次有效来源':'尚未付款锁定'}</dd></div></dl><p className="muted">推荐关系不代表已取得奖励资格。奖励按实际付款金额计算；真实计奖、余额及提现尚未开放。</p></section>:<section className="form-panel"><h2>文字投稿</h2>{session.membership?.active?<form onSubmit={submit}><label className="field"><span>标题</span><input required maxLength={60} value={title} onChange={e=>setTitle(e.target.value)}/></label><label className="field"><span>正文</span><textarea required rows={5} maxLength={2000} value={body} onChange={e=>setBody(e.target.value)}/></label><button className="button primary" disabled={busy}>提交投稿</button></form>:<p>开通且在有效期内的会员才能投稿。资讯和知识库内容需求继续保留，正式内容待提供。</p>}{message && <p role="status">{message}</p>}<div className="post-list">{posts.map(post=><article key={post.id}><span className={`status-pill ${post.status}`}>{postLabels[post.status]}</span><h3>{post.title}</h3><p>{post.body}</p>{post.reason&&<p>审核说明：{post.reason}</p>}</article>)}</div><p className="small muted">本轮保留文字提交与审核；内容等级权限、编辑及修改复审仍待后续开发。</p></section>}</div>
    <div className="club-menu"><a href="#/content">已审核交流内容<ChevronRight size={17}/></a>{isWebTrial?<a href="#/feedback">帮助与反馈<ChevronRight size={17}/></a>:<a href="#/account?tab=settings">个人资料与设置<ChevronRight size={17}/></a>}</div>
  </>;
}

export function AdminPage({session,refresh}:{session:Session;refresh:()=>Promise<void>}) {
  const [orders,setOrders] = useState<Order[]>([]), [posts,setPosts] = useState<Post[]>([]);
  const [members,setMembers] = useState<(User & {membership:Membership|null})[]>([]);
  const [tab,setTab] = useState('orders'), [query,setQuery] = useState(''), [status,setStatus] = useState('all');
  const [notes,setNotes] = useState<Record<string,string>>({}), [busy,setBusy] = useState(false), [error,setError] = useState(''), [message,setMessage] = useState('');
  async function load() {if(session.user?.role!=='admin')return;setError('');try{const [o,p,m]=await Promise.all([api<{orders:Order[]}>('/admin/orders'),api<{posts:Post[]}>('/admin/posts'),api<{members:(User & {membership:Membership|null})[]}>('/admin/members')]);setOrders(o.orders);setPosts(p.posts);setMembers(m.members);}catch(err){setError(errorText(err));}}
  useEffect(()=>{void load();},[session.user?.id]);
  if(!session.user) return <Login refresh={refresh} admin/>;
  if(session.user.role!=='admin')return <div className="empty-state"><ShieldCheck size={40}/><h1 id="page-title">需要管理员权限</h1><p>普通会员不能查看其他人的申请和订单。</p><a className="button secondary" href="#/account">返回我的账号</a></div>;
  async function review(id:string,decision:string,isPost=false) {if(busy)return;setBusy(true);setError('');setMessage('');try{await api(`/admin/${isPost?'posts':'orders'}/${id}/review`,isPost?{status:decision,reason:notes[id]||''}:{decision,note:notes[id]||''});setMessage('审核已保存，会员刷新即可查看。');await load();}catch(err){setError(errorText(err));}finally{setBusy(false);}}
  const filtered=orders.filter(o=>(tab!=='applications'||o.planId==='organization')&&(status==='all'||o.status===status)&&`${o.id} ${o.form.name} ${o.form.phone} ${o.form.company}`.toLowerCase().includes(query.trim().toLowerCase()));
  return <div className="admin-page"><a className="text-button" href="#/account"><ArrowLeft size={17}/>返回会员端</a><header className="admin-header"><div><p className="eyebrow">CLUB OPERATIONS</p><h1 id="page-title" tabIndex={-1}>运营工作台</h1><p className="admin-description">{isWebTrial?'服务器业务数据 · 微信支付尚未接通':'本机内测数据 · 微信支付尚未接通'}</p></div><button className="button secondary" onClick={()=>void load()}><RefreshCw size={16}/>刷新数据</button></header>
    <div className="business-stats">{[['注册账号',members.length],['待资质审核',orders.filter(o=>o.status==='review').length],['待付款',orders.filter(o=>o.status==='pending').length],['已付款订单',orders.filter(o=>o.status==='paid').length]].map(([label,value])=><section key={label}><span>{label}</span><strong>{value}</strong></section>)}</div>
    <div className="tab-row" role="tablist" aria-label="后台栏目">{[['orders','会员订单'],['applications','机构及专业申请'],['members','账号与会员'],['posts','内容审核'],['articles','资讯与知识'],['activities','活动发布'],['resources','服务资源'],['audit','操作记录'],['feedback','帮助反馈']].map(([value,label])=><button key={value} role="tab" aria-selected={tab===value} onClick={()=>{setTab(value);setStatus('all');setQuery('');setMessage('');setError('');}}>{label}</button>)}</div>
    {error&&<p className="field-error" role="alert">{error}</p>}{message&&<p role="status">{message}</p>}
    <div role="tabpanel">{tab==='activities'?<AdminActivities key={session.user.id} userId={session.user.id}/>:tab==='feedback'?<AdminFeedback key={session.user.id} userId={session.user.id}/>:tab==='audit'?<AdminAudit key={session.user.id} userId={session.user.id}/>:tab==='resources'?<AdminServices key={session.user.id} userId={session.user.id}/>:tab==='articles'?<AdminArticles key={session.user.id} userId={session.user.id}/>: ['orders','applications'].includes(tab)?<><div className="business-filters"><label className="field"><span>搜索订单、姓名、手机号或机构</span><input type="search" value={query} onChange={e=>setQuery(e.target.value)}/></label><label className="field"><span>订单状态</span><select value={status} onChange={e=>setStatus(e.target.value)}><option value="all">全部状态</option>{Object.entries(statusLabels).map(([key,label])=><option key={key} value={key}>{label}</option>)}</select></label></div><div className="business-admin-list">{filtered.length?filtered.map(order=><article className="form-panel" key={order.id}><div className="business-row"><h2>{order.form.name} · {plans.find(p=>p.id===order.planId)?.name}</h2><span className={`status-pill ${order.status}`}>{statusLabels[order.status]}</span></div><p className="mono small">{order.id}</p><p>应付 ¥{money(order.amountCents/100)} · {order.form.phone}（未验证） · {order.form.company || order.form.city}</p><p>推荐来源：{order.sourceCode || '未指定 · 默认值待配置'}</p><details><summary>查看申请资料</summary><dl className="order-details">{[['类型',order.form.organizationType],['城市',order.form.city],['行业',order.form.industry],['需求',order.form.need],['提交时间',new Date(order.createdAt).toLocaleString('zh-CN')],['审核记录',order.reviewNote || '暂无']].map(([label,value])=><div key={label}><dt>{label}</dt><dd>{value||'未填写'}</dd></div>)}</dl></details>{order.status==='review'&&<div className="business-review"><label className="field"><span>资质核验 / 驳回说明</span><textarea rows={2} maxLength={500} value={notes[order.id]||''} onChange={e=>setNotes({...notes,[order.id]:e.target.value})}/></label><div className="business-actions"><button className="button primary" disabled={busy} onClick={()=>void review(order.id,'approve')}>资质通过，允许付款</button><button className="button secondary" disabled={busy} onClick={()=>void review(order.id,'reject')}>驳回申请</button></div></div>}</article>):<p className="muted">暂无符合条件的订单。</p>}</div></>:tab==='members'?<div className="business-admin-list">{members.map(member=><article className="form-panel" key={member.id}><h2>{member.username}</h2><p>{member.membership?.active?'会员有效':member.membership?'会员已到期':'已注册，未开通会员'}</p><p>推荐码：{member.referralCode} · 入会来源：{member.sourceCode||'待配置'}</p>{member.membership&&<p>有效期至 {dateLabel(member.membership.expiresAt)}</p>}</article>)}</div>:<div className="business-admin-list">{posts.length?posts.map(post=><article className="form-panel" key={post.id}><span className="status-pill">{postLabels[post.status]}</span><h2>{post.title}</h2><p>{post.body}</p>{post.status==='pending'&&<><label className="field"><span>驳回理由</span><textarea maxLength={500} value={notes[post.id]||''} onChange={e=>setNotes({...notes,[post.id]:e.target.value})}/></label><div className="business-actions"><button className="button primary" disabled={busy} onClick={()=>void review(post.id,'published',true)}>通过审核</button><button className="button secondary" disabled={busy} onClick={()=>void review(post.id,'rejected',true)}>驳回投稿</button></div></>}{post.reason&&<p>{post.reason}</p>}</article>):<p>暂无投稿。审核通过的内测文字会出现在“已审核交流内容”。</p>}</div>}</div>
    <p className="section-note">审核操作记录了管理员、时间和说明。此处不提供手动标记会员费到账；提现后续仍按财务人工打款、系统记录状态开发。</p>
  </div>;
}

export function ContentPage() {
  const [posts,setPosts] = useState<Post[]>([]),[error,setError] = useState('');
  useEffect(()=>{api<{posts:Post[]}>('/content').then(data=>setPosts(data.posts)).catch(err=>setError(errorText(err)));},[]);
  return <><div className="page-heading"><span className="eyebrow">内测交流</span><h1 id="page-title">已审核交流内容</h1><p>当前仅展示通过审核的内测文字，请勿提交真实敏感资料。</p></div>{error&&<p role="alert">{error}</p>}{!error&&!posts.length&&<p>暂无已审核内容。</p>}<div className="post-list">{posts.map(post=><article key={post.id}><h2>{post.title}</h2><p>{post.body}</p></article>)}</div></>;
}
