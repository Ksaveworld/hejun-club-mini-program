import {useEffect,useState} from 'react';
import {api,errorText} from './api';
import {isWebTrial} from './web-env';
export type LegalRelease={id:string;documents:{id:string;title:string;htmlUrl:string;sha256:string;version:string}[]};
export function useLegalRelease(){
 const [release,setRelease]=useState<LegalRelease|null>(null),[ready,setReady]=useState(!isWebTrial),[error,setError]=useState('');
 useEffect(()=>{if(!isWebTrial)return;let active=true;api<{release:LegalRelease|null}>('/legal').then(r=>{if(active){setRelease(r.release);setReady(true);}}).catch(e=>{if(active)setError(errorText(e));});return()=>{active=false;};},[]);
 return {release,ready,error};
}
export function LegalFields({release,accepted,onAccepted,hongKong,onHongKong}:{release:LegalRelease;accepted:boolean;onAccepted:(v:boolean)=>void;hongKong:boolean;onHongKong:(v:boolean)=>void}){
 return <div className="legal-fields"><p>{release.documents.map((d,i)=><span key={d.id}>{i>0?' · ':''}<a href={import.meta.env.BASE_URL+d.htmlUrl} target="_blank" rel="noopener noreferrer">阅读《{d.title}》</a></span>)}</p><label className="consent"><input type="checkbox" required checked={accepted} onChange={e=>onAccepted(e.target.checked)}/><span>我已阅读并同意会员服务协议和隐私政策</span></label><label className="consent"><input type="checkbox" required checked={hongKong} onChange={e=>onHongKong(e.target.checked)}/><span>我单独同意上述隐私政策说明的香港服务器存储和处理安排，用于办理我选择的网页服务</span></label></div>;
}
