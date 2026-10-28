const {api}=require('./api');
function fileError(file){
 if(!file||typeof file.name!=='string'||!file.path)return '请选择资料文件';
 if(!/\.pdf$/i.test(file.name))return '请把企业简介与产品资料合并为一份PDF';
 if(!Number.isSafeInteger(file.size)||file.size<=20||file.size>5*1024*1024)return 'PDF不能超过5MB';
 return '';
}
async function submitSurvey(side,body,file,key,progress,current){
 const check=()=>{if(!current())throw new Error('页面或登录状态已变化，请重新填写');};
 check();
 if(!file)return api('/surveys/'+side,body,key);
 if(side!=='general-supply')throw new Error('本问卷不接收附件');
 const error=fileError(file);if(error)throw new Error(error);
 const encoded=await new Promise((resolve,reject)=>wx.getFileSystemManager().readFile({filePath:file.path,encoding:'base64',success:r=>resolve(r.data),fail:()=>reject(new Error('文件读取失败，请重新选择PDF'))}));check();
 const size=encoded.length/4*3-(encoded.endsWith('==')?2:encoded.endsWith('=')?1:0);
 if(size!==file.size)throw new Error('文件发生变化，请重新选择');
 const root='/surveys/general-supply/upload',upload=await api(root,{filename:file.name,byteSize:size,consent:body.consent,legalConsent:body.legalConsent},key);check();
 const chunk=40960,total=Math.ceil(encoded.length/chunk);
 if(!/^[a-f0-9-]{36}$/.test(upload.id)||!/^[a-f0-9]{64}$/.test(upload.token)||upload.chunkBytes!==30720||!Number.isInteger(upload.nextIndex)||upload.nextIndex<0||upload.nextIndex>total)throw new Error('上传初始化异常，请重试');
 for(let i=upload.nextIndex;i<total;i++){
  const part=await api(root+'/'+upload.id+'/part/'+i,{token:upload.token,dataBase64:encoded.slice(i*chunk,(i+1)*chunk)});check();
  if(part.nextIndex!==i+1)throw new Error('上传进度异常，请重试');
  progress(Math.floor((i+1)/total*100));
 }
 return api('/surveys/'+side,{...body,filename:file.name,fileUploadId:upload.id,fileUploadToken:upload.token},key);
}
module.exports={fileError,submitSurvey};
