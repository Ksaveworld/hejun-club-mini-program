import {useState,useRef,useEffect} from 'react';
import type {FormEvent} from 'react';
import {ArrowRight,ArrowLeft} from 'lucide-react';
import {api,errorText,referralHint,clearReferralHint} from './api';
import type {Session,Order} from './api';
import type {Plan,JoinForm} from './types';
import {money} from './store';
import {Login} from './MemberPages';
const isWebTrial=true;
function readDraft(key:string):{form:JoinForm;key:string;fingerprint:string}|null{try{const d=JSON.parse(sessionStorage.getItem(key)||'null');if(d&&d.at>Date.now()-86400000&&typeof d.key==='string'&&typeof d.fingerprint==='string'&&d.form&&['name','phone','city','company','industry','need','referral','organizationType'].every(k=>typeof d.form[k]==='string'))return d;}catch{}return null;}
export function WebJoin({ plan, session, refresh }: { plan: Plan; session: Session; refresh: () => Promise<void> }) {
  const reapplyId=new URLSearchParams(location.hash.split('?')[1]).get('reapplyId')||'';
  const storageKey='club-web-draft:'+location.pathname+':'+session.user?.id+':join:'+plan.id+':'+reapplyId;
  const restored=useRef(readDraft(storageKey));
  const [loading,setLoading]=useState(!!reapplyId&&!restored.current);
  const [draftNote,setDraftNote]=useState(restored.current?'已恢复未提交的申请。':'');
  const [form,setForm] = useState<JoinForm>(restored.current?.form || {name:'',phone:'',city:'',company:'',industry:'',need:'',referral:session.user?.sourceCode || referralHint(),organizationType:'机构会员'});
  const [consent,setConsent] = useState(false), [error,setError] = useState(''), [busy,setBusy] = useState(false);
  const key = useRef(restored.current?.key || crypto.randomUUID());
  const fingerprint = useRef(restored.current?.fingerprint || '');
  const submitted=useRef(false);
  useEffect(()=>{if(!reapplyId||restored.current){setLoading(false);return;}let live=true;void (async()=>{try{const {order}=await api<{order:Order}>('/orders/'+encodeURIComponent(reapplyId));if(order.status!=='rejected'||order.planId!==plan.id)throw new Error('该申请不能用于重新办理。');if(live){setForm({...order.form,referral:session.user?.sourceCode||''});setDraftNote('已带入上次资料，请根据审核说明修改。原申请记录保留。');}}catch(e){if(live)setError(errorText(e));}finally{if(live)setLoading(false);}})();return()=>{live=false;};},[]);
  function saveDraft(){if(!session.user||submitted.current||loading)return;try{sessionStorage.setItem(storageKey,JSON.stringify({at:Date.now(),form,key:key.current,fingerprint:fingerprint.current}));}catch{setDraftNote('本机草稿保存失败，请保持当前页面。');}}
  useEffect(()=>{saveDraft();},[form,loading]);
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
    saveDraft(); setBusy(true); setError('');
    try {
      const {order} = await api<{order:Order}>('/orders',body,key.current);
      submitted.current=true;sessionStorage.removeItem(storageKey);clearReferralHint(); await refresh(); window.location.hash=`/checkout/${order.id}`;
    } catch (err) { setError(errorText(err)); } finally { setBusy(false); }
  }
  return <><a className="back-link" href="#/members"><ArrowLeft size={17}/>返回会员权益</a>
    <div className="page-heading"><span className="eyebrow">加入俱乐部</span><h1 id="page-title" tabIndex={-1}>填写入会信息</h1><p>{plan.id==='organization'?'资质审核通过后再付款，付款成功后开通。':'基础与星级会员付款成功后开通，无需资质预审。'}</p></div>
    <aside className={`join-summary ${plan.id}`}><span className="eyebrow">已选方案</span><h2>{plan.name}</h2><div className="price"><small>¥</small>{money(plan.price)}<span>/ 年</span></div><p>有效期从核验付款成功时起算一年。</p></aside>
    {draftNote&&<p role="status">{draftNote}</p>}{loading&&<p>正在读取原申请…</p>}
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
      <div className="form-bottom"><span><strong>下一步</strong>{plan.id==='organization'?'等待资质审核':'查看待付款订单'}</span><button className="button primary" disabled={busy||loading}>{busy?'保存中…':plan.id==='organization'?'提交资质申请':'保存订单'}<ArrowRight size={17}/></button></div>
    </form></>;
}
