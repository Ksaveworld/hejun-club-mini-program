const {sessionStamp, isCurrentSession, removeReportFile,downloadPublicDocument} = require('./api');
const documents=new WeakMap();
function state(page){let value=documents.get(page);if(!value){value={version:0,visible:true,pending:false,opening:false,path:null,disposed:false};documents.set(page,value);}return value;}
function release(value){removeReportFile(value.path);value.path=null;}
function showPublicDocuments(page){const value=state(page);value.visible=true;value.version++;value.pending=false;value.opening=false;release(value);}
function hidePublicDocuments(page){const value=state(page);value.visible=false;if(!value.opening){value.version++;value.pending=false;}}
function clearPublicDocuments(page){const value=state(page);value.disposed=true;value.version++;value.pending=false;value.opening=false;release(value);}
// A response may not nominate an external download URL.
function openPublicDocument(path, fileType,page) {
  if (!/^\/(legal\/(privacy|terms)\/document|enterprise-intake\/template\/(docx|pdf)|application-templates\/(partner|organization)\/docx)$/.test(path)
    || (path.startsWith('/application-templates/') && fileType !== 'docx'))
    return Promise.reject(new Error('文件地址不正确'));
  if(!page||page._unloaded||page._disposed)return Promise.reject(new Error('页面已关闭，请重新打开文件。'));
  const value=state(page);
  if(value.disposed||!value.visible)return Promise.reject(new Error('页面已离开，请重新打开文件。'));
  if(value.pending)return Promise.reject(new Error('文件正在打开，请稍候。'));
  release(value);value.opening=false;value.pending=true;
  const stamp = sessionStamp(),version=++value.version;
  const current=()=>!value.disposed&&value.visible&&value.version===version&&!page._unloaded&&!page._disposed&&isCurrentSession(stamp);
  return downloadPublicDocument(path,fileType).then(filePath=>{
    if(!current()){removeReportFile(filePath);throw new Error('页面或登录状态已变化，请重新打开文件。');}
    value.path=filePath;value.opening=true;
    return new Promise((resolve,reject)=>{
      const fail=()=>{if(value.path===filePath){release(value);value.opening=false;}else removeReportFile(filePath);reject(new Error('文件未能打开，请在手机微信中重试'));};
      try{wx.openDocument({filePath,fileType,showMenu:true,success:()=>resolve(filePath),fail});}catch(error){fail();}
    });
  }).finally(()=>{if(value.version===version)value.pending=false;});
}
module.exports = {openPublicDocument,showPublicDocuments,hidePublicDocuments,clearPublicDocuments};
