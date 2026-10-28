const {api,sessionStamp,isCurrentSession}=require('./api');
function fileError(file){if(!file||!file.path||!/^.+\.(docx|pdf)$/i.test(file.name||''))return '请选择填写好的 DOCX 或 PDF 文件';if(!Number.isSafeInteger(file.size)||file.size<1||file.size>5*1024*1024)return '文件须大于 0 且不超过 5MB';return '';}
async function submitMaterial(kind,body,key,onProgress,isActive){
 if(!['partner','organization'].includes(kind))throw new Error('申请类型不正确');
 const encoded=body.fileBase64;if(typeof encoded!=='string'||!encoded.length||encoded.length%4!==0)throw new Error('文件读取异常，请重新选择');
 const byteSize=encoded.length/4*3-(encoded.endsWith('==')?2:encoded.endsWith('=')?1:0);if(byteSize>5*1024*1024)throw new Error('文件不能超过5MB');
 const stamp=sessionStamp(),check=()=>{if(!isCurrentSession(stamp)||(isActive&& !isActive()))throw new Error('登录或页面已变化，请重新进入后提交');};
 const base='/application-materials/'+kind;check();
 const upload=await api(base+'/upload',{filename:body.filename,byteSize,consent:body.consent,legalConsent:body.legalConsent},key);check();
 const chunk=30*1024/3*4,total=Math.ceil(encoded.length/chunk);
 if(!/^[a-f0-9-]{36}$/.test(upload.id)||!/^[a-f0-9]{64}$/.test(upload.token)||upload.chunkBytes!==30*1024||!Number.isSafeInteger(upload.nextIndex)||upload.nextIndex<0||upload.nextIndex>total)throw new Error('上传初始化异常，请用原材料重试');
 for(let index=upload.nextIndex;index<total;index++){check();const part=await api(base+'/upload/'+upload.id+'/part/'+index,{token:upload.token,dataBase64:encoded.slice(index*chunk,(index+1)*chunk)});check();if(part.nextIndex!==index+1)throw new Error('上传进度异常，请重试');if(onProgress)onProgress(Math.floor((index+1)/total*100));}
 check();const input={...body,fileUploadId:upload.id,fileUploadToken:upload.token};delete input.fileBase64;return api(base,input,key);
}
module.exports={fileError,submitMaterial};
