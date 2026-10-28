import {randomUUID,randomBytes,timingSafeEqual} from 'node:crypto';
import {requireRule} from './domain.mjs';
const chunkBytes=262144,maxBytes=15*1024*1024,ttl=10*60*1000;
export function createReportUpload({now=()=>Date.now()}={}){
 let active=null;
 const clear=()=>{if(active&&!active.processing&&active.expires<=now())active=null;};
 function authorized(actor,article,id,token){clear();requireRule(active&&active.id===id&&active.actor===actor.id&&active.article===article,'上传已失效，请重新选择文件上传',409);requireRule(typeof token==='string'&&/^[a-f0-9]{64}$/.test(token)&&timingSafeEqual(Buffer.from(token),Buffer.from(active.token)),'上传凭据无效',403);return active;}
 return {
 start(actor,article,input,key){clear();requireRule(actor?.role==='admin','需要管理员身份',403);requireRule(/^[a-f0-9-]{36}$/.test(key||''),'缺少上传请求编号');requireRule(Number.isSafeInteger(input.bytes)&&input.bytes>0&&input.bytes<=maxBytes,'单份PDF不能超过15MB');requireRule(Number.isSafeInteger(input.revision)&&input.revision>0,'资料版本无效');requireRule(typeof input.filename==='string'&&input.filename.length<=120&&/\.pdf$/i.test(input.filename),'请选择PDF文件');
 if(active){requireRule(!active.processing&&active.actor===actor.id&&active.article===article&&active.key===key&&active.bytes===input.bytes&&active.revision===input.revision&&active.filename===input.filename,'已有PDF正在上传或处理，请稍后重试',409);}
 else active={actor:actor.id,article,key,id:randomUUID(),token:randomBytes(32).toString('hex'),bytes:input.bytes,filename:input.filename,revision:input.revision,expires:now()+ttl,chunks:[],received:0,processing:false};
 return {id:active.id,token:active.token,chunkBytes};},
 part(actor,article,id,input){const a=authorized(actor,article,id,input.token);requireRule(!a.processing,'文件正在处理',409);requireRule(Number.isInteger(input.index)&&input.index>=0&&input.index<=Math.ceil(maxBytes/chunkBytes),'分块编号无效');requireRule(typeof input.base64==='string'&&input.base64.length<=Math.ceil(chunkBytes/3)*4&&/^[A-Za-z0-9+/]*={0,2}$/.test(input.base64),'分块内容无效');const b=Buffer.from(input.base64,'base64');requireRule(b.toString('base64')===input.base64&&b.length>0,'分块编码无效');if(input.index<a.chunks.length){requireRule(a.chunks[input.index].equals(b),'重复分块内容不一致',409);return {ok:true};}requireRule(input.index===a.chunks.length,'请按顺序上传',409);requireRule(b.length===Math.min(chunkBytes,a.bytes-a.received),'分块大小无效');a.chunks.push(b);a.received+=b.length;a.expires=now()+ttl;return {ok:true};},
 async complete(actor,article,id,input,key,save){const a=authorized(actor,article,id,input.token);requireRule(key===a.key,'上传请求编号不一致',409);requireRule(!a.processing&&a.received===a.bytes,'上传未完成或正在处理',409);a.processing=true;try{return await save({revision:a.revision,filename:a.filename,base64:Buffer.concat(a.chunks).toString('base64')},key);}finally{if(active===a)active=null;}},
 abort(actor,article,id,input){const a=authorized(actor,article,id,input.token);requireRule(!a.processing,'文件正在处理，请刷新内容核对结果',409);active=null;return {ok:true};},
 close(){active=null;}
 };
}
