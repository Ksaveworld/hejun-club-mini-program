import { Campaign } from './Campaign';
import { Surveys } from './Surveys';
import {useEffect,useRef,useState} from 'react';
import {api,errorText,setWebActor,rememberReferral} from './api';
import type {Session} from './api';
import {plans} from './data';
import {OrderPage,AccountPage,AdminPage,ContentPage} from './MemberPages';
import {WebJoin} from './WebJoin';
import {WebContent} from './WebContent';
import {WebActivities} from './Activities';
export function WebApp(){
 const [route,setRoute]=useState(location.hash.slice(1)||'/'),[session,setSession]=useState<Session|null>(null),[error,setError]=useState('');
 const generation=useRef(0);
 async function refresh(){const version=++generation.current;try{const result=await api<Session>('/me');if(version===generation.current){setWebActor(result.user?.id||null);setSession(result);setError('');}}catch(e){if(version===generation.current){setSession(null);setWebActor(null);setError(errorText(e));}}}
 useEffect(()=>{rememberReferral();void refresh();const change=()=>{setRoute(location.hash.slice(1)||'/');window.scrollTo(0,0);};window.addEventListener('hashchange',change);return()=>{generation.current++;window.removeEventListener('hashchange',change);};},[]);
 async function logout(){try{await api('/auth/logout',{});for(let i=sessionStorage.length-1;i>=0;i--){const key=sessionStorage.key(i);if(key?.startsWith('club-web-draft:'))sessionStorage.removeItem(key);}await refresh();location.hash='/account';}catch(e){setError(errorText(e));}}
 const path=route.split('?')[0], plan=plans.find(p=>p.id===path.split('/')[2]);
 let content;
 if(!session)content=<section><h1>会员服务</h1><p>{error||'正在连接服务器…'}</p><button onClick={()=>void refresh()}>重新连接</button></section>;
 else if(path==='/admin')content=<AdminPage key={session.user?.id||'guest'} session={session} refresh={refresh}/>;
 else if(path.startsWith('/join/')&&plan)content=<WebJoin key={route+(session.user?.id||'guest')} plan={plan} session={session} refresh={refresh}/>;
 else if(path.startsWith('/checkout/'))content=<OrderPage key={route+(session.user?.id||'guest')} id={path.split('/')[2]} refresh={refresh}/>;
 else if(path==='/account')content=<AccountPage key={route+(session.user?.id||'guest')} session={session} refresh={refresh}/>;
 else if(path.startsWith('/surveys'))content=<Surveys key={path} side={path.split('/')[2]}/>;
 else if(path==='/content')content=<ContentPage key={session.user?.id||'guest'} refresh={refresh}/>;
 else if(path==='/activities'||path.startsWith('/activities/'))content=<WebActivities id={path.split('/')[2]||''}/>;
 else if(['/articles','/resources','/feedback'].some(p=>path===p||path.startsWith(p+'/')))content=<WebContent key={route+(session.user?.id||'guest')} kind={path.split('/')[1] as 'articles'|'resources'|'feedback'} id={path.split('/')[2]||''} session={session} refreshSession={refresh}/>;
 else if(path==='/members')content=<><h1>选择会员方案</h1><p>了解权益后填写申请；应付金额由服务器核验，支付尚未接通。</p><div className="web-grid">{plans.map(p=><section key={p.id}><h2>{p.name}</h2><p className="web-price">¥{p.price.toLocaleString()} / 年</p><ul>{p.benefits.map(b=><li key={b}>{b}</li>)}</ul><a className="button primary" href={'#/join/'+p.id}>选择{p.name}</a></section>)}</div></>;
 else content=<><Campaign auto/><div className="web-intro"><p>中国—东盟经贸中心</p><h1>跨境企业家俱乐部</h1><p>办理入会，查询进度，获取内容与服务。</p><a className="button primary" href="#/members">了解会员并申请</a></div><div className="web-grid">{[['/account','我的申请与订单','查看办理状态和审核说明'],['/articles','知识与资讯','阅读已发布的内容'],['/activities','俱乐部活动','查看活动安排与参与说明'],['/resources','会员服务','查看当前可用的服务资源'],['/feedback','帮助与反馈','提交问题并查看回复'],['/account?tab=posts','我的投稿','文字投稿及审核记录'],['/account?tab=referral','推荐信息','查看本人推荐码与来源']].map(([url,title,description])=><a className="web-card" key={url} href={'#'+url}><h2>{title}</h2><p>{description}</p><span>进入 →</span></a>)}</div></>;
 return <div className="web-app"><header><a href="#/" className="web-brand">跨境企业家俱乐部</a><div>{session?.user?<><span>{session.user.username}</span><button className="text-button" onClick={()=>void logout()}>退出登录</button></>:<a href="#/account">登录 / 注册</a>}<a href="#/admin">运营后台</a></div></header><nav aria-label="主导航"><a href="#/">首页</a><a href="#/members">会员申请</a><a href="#/articles">知识资讯</a><a href="#/activities">活动</a><a href="#/resources">服务</a><a href="#/feedback">帮助反馈</a><a href="#/account">我的</a></nav>{error&&session&&<p role="alert">{error}<button onClick={()=>void refresh()}>刷新登录状态</button></p>}<main>{content}</main><footer>当前为业务体验，资料保存于服务器；请使用虚构联系资料。微信身份与支付尚未接通，不收款或自动开通会籍。</footer></div>;
}
