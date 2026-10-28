import {useEffect,useState} from 'react';
import {api,errorText} from './api';

export function NativeTransfer({userId}:{userId:string}){
  const [enabled,setEnabled]=useState(false),[confirmed,setConfirmed]=useState(false),[busy,setBusy]=useState(false),[error,setError]=useState('');
  const [proof,setProof]=useState<{transferCode:string;expiresAt:string}|null>(null);
  useEffect(()=>{let active=true;setProof(null);setConfirmed(false);
    api<{enabled:boolean}>('/auth/native-transfer/status').then(value=>{if(active)setEnabled(value.enabled);}).catch(()=>{});
    return()=>{active=false;};
  },[userId]);
  useEffect(()=>{if(!proof)return;const timer=setTimeout(()=>setProof(null),Math.max(0,Date.parse(proof.expiresAt)-Date.now()));return()=>clearTimeout(timer);},[proof]);
  async function issue(){if(busy||!confirmed)return;setBusy(true);setError('');setProof(null);
    try{setProof(await api('/auth/native-transfer',{confirm:true}));}catch(error){setError(errorText(error));}finally{setBusy(false);}
  }
  if(!enabled)return null;
  return <section className="form-panel" aria-label="小程序会员接续">
    <h2>在小程序继续使用原会籍</h2>
    <p>在小程序登录页选择“关联原会籍”，粘贴下方接续码。原订单和会员期限保留，不需要重新付款。</p>
    <label className="consent"><input type="checkbox" checked={confirmed} onChange={event=>setConfirmed(event.target.checked)} disabled={busy}/><span>我确认将当前账号关联到本人使用的小程序微信。</span></label>
    <button className="button secondary" disabled={busy||!confirmed} onClick={()=>void issue()}>{busy?'正在生成…':proof?'重新生成接续码':'获取接续码'}</button>
    {proof&&<><label className="field"><span>接续码（请完整复制）</span><textarea readOnly value={proof.transferCode}/></label><p>10分钟有效，仅能使用一次；重新生成后旧码失效。此码可关联你的账号，请勿转发给他人。</p></>}
    {error&&<p role="alert">{error}</p>}
  </section>;
}
