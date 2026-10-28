import {useEffect,useRef,useState,type FormEvent} from 'react';
import {createRoot} from 'react-dom/client';
import {api,errorText,setWebActor,type Session} from './api';
import {AdminPage} from './MemberPages';
import './styles.css';
import './member-app.css';
import './admin.css';
import './business.css';
import './operations-workspace.css';

const empty:Session={user:null,membership:null,paymentReady:false,manualPaymentReady:false,defaultReferralConfigured:false};
function CloudOperations(){
  const [session,setSession]=useState(empty),[ready,setReady]=useState(false),[busy,setBusy]=useState(false);
  const [username,setUsername]=useState(''),[password,setPassword]=useState(''),[error,setError]=useState('');
  const request=useRef(0);
  async function refresh(){
    const current=++request.current;
    // Revalidating the same administrator must not unmount the editor on file-picker focus.
    // Identity changes still replace the keyed workspace; every write rechecks the session.
    try{
      const next=await api<Session>('/me');
      if(current!==request.current)return;
      if(next.user&&next.user.role!=='admin'){setWebActor(null);setSession(empty);throw new Error('此入口仅供运营管理员使用。');}
      setWebActor(next.user?.id??null);setSession(next);setError('');
    }catch(e){if(current===request.current)setError(errorText(e));}
    finally{if(current===request.current)setReady(true);}
  }
  useEffect(()=>{
    const visible=()=>{if(!document.hidden)void refresh();};
    void refresh();window.addEventListener('focus',visible);
    return()=>{window.removeEventListener('focus',visible);request.current++;setWebActor(null);};
  },[]);
  async function login(event:FormEvent){
    event.preventDefault();if(busy)return;setBusy(true);setError('');
    try{await api('/auth/login',{username,password});setPassword('');await refresh();}
    catch(e){setError(errorText(e));}finally{setBusy(false);}
  }
  async function logout(){
    if(busy)return;setBusy(true);setError('');
    try{await api('/auth/logout',{});await refresh();}
    catch(e){setError(errorText(e));}finally{setBusy(false);}
  }
  return <div className="admin-shell ops-shell"><a className="ops-skip-link" href="#ops-main">跳转到工作区</a><header className="site-header"><a className="brand brand-cabc" href="/ops/"><img src="/images/cabc-official-logo.png" alt="中国—东盟经贸中心" width="316" height="86"/><span>小程序运营工作台</span></a>{session.user&&<div className="ops-user"><span>运营管理员 · {session.user.username}</span><button className="button secondary" disabled={busy} onClick={()=>void logout()}>退出登录</button></div>}</header>
    <main className="main-content admin-main" id="ops-main">
      {error&&<p className="field-error" role="alert">{error}</p>}
      {!ready?<p role="status">正在读取登录状态…</p>:session.user?<AdminPage key={session.user.id} session={session} refresh={refresh} native/>:
        <section className="business-auth"><div className="page-heading"><h1 id="page-title">管理员登录</h1><p>管理小程序的会员申请、资料、内容及反馈。</p></div><form onSubmit={login}>
          <label className="field"><span>管理员账号</span><input autoComplete="username" required minLength={4} maxLength={32} value={username} onChange={e=>setUsername(e.target.value)}/></label>
          <label className="field"><span>密码</span><input type="password" autoComplete="current-password" required minLength={10} maxLength={128} value={password} onChange={e=>setPassword(e.target.value)}/></label>
          <button className="button primary" disabled={busy}>{busy?'正在登录…':'登录'}</button>
        </form></section>}
    </main></div>;
}
createRoot(document.getElementById('root')!).render(<CloudOperations/>);
