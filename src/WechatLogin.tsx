import {useEffect,useState} from 'react';
import {api,errorText,referralHint} from './api';
import {useLegalRelease} from './Legal';
import {isWebTrial} from './web-env';

export function WechatLogin({binding=false}:{binding?:boolean}){
 const [status,setStatus]=useState<{enabled:boolean;linked:boolean}|null>(null),[accepted,setAccepted]=useState(false),[busy,setBusy]=useState(false),[error,setError]=useState('');
 const legal=useLegalRelease(),insideWechat=/MicroMessenger/i.test(navigator.userAgent);
 useEffect(()=>{if(!isWebTrial)return;let active=true;api<{enabled:boolean;linked:boolean}>('/auth/wechat/status').then(s=>{if(active)setStatus(s);}).catch(()=>{});return()=>{active=false;};},[]);
 if(!isWebTrial||!status?.enabled)return null;
 if(status.linked&&binding)return <div className="notice-card"><strong>微信已绑定</strong><p>下次可在微信内使用微信登录，继续查看本账号的订单和会籍。</p></div>;
 async function start(){
  if(busy||!accepted||!legal.release)return;setBusy(true);setError('');
  try{const result=await api<{url:string}>('/auth/wechat/start',{wechatConsent:accepted,legalConsent:{accepted,hongKongAccepted:true,releaseId:legal.release.id},referral:referralHint(),returnTo:window.location.hash.includes('wechat=failed')?'/account':window.location.hash.slice(1)||'/account'});window.location.assign(result.url);}catch(e){setError(errorText(e));setBusy(false);}
 }
 return <section className="form-panel" aria-label={binding?'绑定微信':'微信登录'} style={{marginBottom:20}}>
  <h2>{binding?'绑定当前微信':'微信快捷登录'}</h2>
  <p>{binding?'绑定后仍使用当前账号，已有订单和会员权益保持不变。':'首次登录将创建游客账号，付费会员由工作人员核对到账后开通。已有账号和订单？请先用原账号密码登录，再到个人设置绑定微信。'}</p>
  {!binding && <a className="text-button" href="#/account?tab=settings">已有账号？使用账号密码登录</a>}
  {!insideWechat?<p className="notice">请在手机微信内打开本网页使用微信登录；普通浏览器可继续使用账号密码。</p>:<>
   {legal.release&&<label className="consent"><input type="checkbox" checked={accepted} onChange={e=>setAccepted(e.target.checked)} /><span>我已阅读并同意{legal.release.documents.map((d,i)=><span key={d.id}>{i>0?'、':''}<a href={import.meta.env.BASE_URL+d.htmlUrl} target="_blank" rel="noopener noreferrer">《{d.title}》</a></span>)}及以下微信登录说明。</span></label>}
   <p style={{fontSize:14,lineHeight:1.7,margin:'12px 0'}}>微信登录仅使用本服务号下的账号标识（OpenID），用于识别账号、关联订单和会籍，不读取微信昵称、头像或手机号。</p>
   <div className="notice" style={{fontSize:14,lineHeight:1.7,margin:'12px 0'}}><strong>香港存储说明</strong><br/>上述微信标识与账号数据存储、处理于腾讯云香港服务器，用于办理你选择的网页服务。具体安排及联系方式见隐私政策。点击下方按钮，表示你单独同意此项安排并继续{binding?'绑定':'登录'}；不同意可返回继续游客浏览。</div>
   <button type="button" className="button primary full" disabled={busy||!accepted||!legal.ready||!legal.release} onClick={()=>void start()}>{busy?'正在前往微信…':binding?'单独同意香港存储并绑定微信':'单独同意香港存储并微信登录'}</button>
   <a className="text-button" href="#/">暂不登录，继续浏览</a>
  </>}
  {(error||legal.error)&&<p role="alert">{error||legal.error}</p>}
  {window.location.hash.includes('wechat=failed')&&<p role="alert">微信登录未完成或校验已过期，请重试。如仍失败，可先用账号密码登录；已有会员不要重复注册或付款。</p>}
 </section>;
}
