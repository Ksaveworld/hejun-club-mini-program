import {randomUUID,randomBytes,createHash,timingSafeEqual} from 'node:crypto';
import {requireRule,textField,validateKey} from './domain.mjs';
import {intakeVersion,maxFileBytes} from './enterprise-intake.mjs';

// Short-lived private staging for the current single-instance service. A restart
// loses unfinished uploads, never an already committed enterprise record.
export function createEnterpriseUpload({clock=Date.now,ttl=10*60*1000,capacity=20*1024*1024}={}){
 const sessions=new Map(),chunkBytes=30*1024;
 const sweep=()=>{for(const [id,s] of sessions)if(s.expires<=clock())sessions.delete(id);};
 const cleanup=setInterval(sweep,60000);cleanup.unref();
 const hash=value=>createHash('sha256').update(value).digest('hex');
 function descriptor(body,legal){
  requireRule(body.consent===true,'请确认信息用途与上传授权');
  requireRule(body.templateVersion===intakeVersion,'模板版本已变化，请刷新页面',409);
  if(legal)requireRule(body.legalConsent?.accepted===true&&body.legalConsent.releaseId===legal.id&&(!legal.requireHongKongConsent||body.legalConsent.hongKongAccepted===true),'请阅读当前协议并确认适用的存储安排',409);
  const filename=textField(body.filename,'文件名',160,true);
  requireRule(!/[\\/\x00-\x1f\x7f]/.test(filename)&&/\.(docx|pdf)$/i.test(filename),'仅支持.docx或.pdf文件');
  requireRule(Number.isSafeInteger(body.byteSize)&&body.byteSize>20&&body.byteSize<=maxFileBytes,'文件不能超过5MB',413);
  return {filename,byteSize:body.byteSize,templateVersion:body.templateVersion,releaseId:legal?.id??null,hongKongAccepted:body.legalConsent?.hongKongAccepted===true};
 }
 function lookup(id,token){
  sweep();const s=sessions.get(id);
  requireRule(s&&typeof token==='string'&&/^[a-f0-9]{64}$/.test(token)&&timingSafeEqual(Buffer.from(token),Buffer.from(s.token)),'材料上传已过期或凭证不正确，请重新提交；填写资料仍保留',409);
  return s;
 }
 return {
  start(body,key,legal){
   sweep();validateKey(key);const meta=descriptor(body,legal),digest=hash(JSON.stringify(meta));
   const previous=[...sessions.values()].find(s=>s.key===key);
   if(previous){requireRule(previous.digest===digest,'本次文件已变化，请重新选择材料',409);return {id:previous.id,token:previous.token,chunkBytes,nextIndex:previous.parts.length};}
   requireRule(sessions.size<16&&[...sessions.values()].reduce((sum,s)=>sum+s.meta.byteSize,0)+meta.byteSize<=capacity,'正在上传的材料较多，请稍后重试',429);
   const s={id:randomUUID(),token:randomBytes(32).toString('hex'),key,meta,digest,expires:clock()+ttl,parts:[],bytes:0};
   sessions.set(s.id,s);return {id:s.id,token:s.token,chunkBytes,nextIndex:0};
  },
  append(id,index,body){
   const s=lookup(id,body.token),encoded=body.dataBase64;
   requireRule(Number.isSafeInteger(index)&&index>=0&&index<=Math.ceil(maxFileBytes/chunkBytes),'材料分块编号不正确');
   requireRule(typeof encoded==='string'&&encoded.length>0&&encoded.length<=chunkBytes/3*4&&encoded.length%4===0&&/^[A-Za-z0-9+/]+={0,2}$/.test(encoded),'材料分块内容不正确');
   const bytes=Buffer.from(encoded,'base64');requireRule(bytes.length&&bytes.toString('base64')===encoded,'材料分块内容不正确');
   if(index<s.parts.length){requireRule(s.parts[index].equals(bytes),'材料分块已变化，请重新选择文件',409);return {nextIndex:s.parts.length};}
   requireRule(index===s.parts.length,'材料分块顺序不正确，请重试',409);
   const expected=Math.min(chunkBytes,s.meta.byteSize-s.bytes);
   requireRule(expected>0&&bytes.length===expected,'材料分块大小不正确',409);
   s.parts.push(bytes);s.bytes+=bytes.length;return {nextIndex:s.parts.length};
  },
  resolve(body){
   requireRule(body.fileBase64===undefined,'不能混用两种材料上传方式');
   const s=lookup(body.fileUploadId,body.fileUploadToken);
   requireRule(textField(body.filename,'文件名',160,true)===s.meta.filename&&body.templateVersion===s.meta.templateVersion&&body.legalConsent?.releaseId===s.meta.releaseId,'材料或协议已变化，请重新选择文件',409);
   requireRule(s.bytes===s.meta.byteSize,'材料尚未完整上传，请重试',409);
   const result={...body,filename:s.meta.filename,fileBase64:Buffer.concat(s.parts,s.bytes).toString('base64')};
   delete result.fileUploadId;delete result.fileUploadToken;return result;
  },
  release(id,token){const s=sessions.get(id);if(s&&s.token===token)sessions.delete(id);},
  close(){clearInterval(cleanup);sessions.clear();}
 };
}
