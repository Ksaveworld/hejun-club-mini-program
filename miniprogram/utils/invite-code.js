const {api,hasSession,isCurrentSession,removeReportFile}=require('./api');
let sequence=0;
async function downloadInviteCode(code,stamp,isActive) {
  const current=()=>hasSession()&&isCurrentSession(stamp)&&(!isActive||isActive());
  const check=()=>{if(!current())throw new Error('登录状态已变化，请重新生成邀请图片。');};
  if(!/^[A-Z0-9]{6}$/.test(code||''))throw new Error('推荐信息不正确，请刷新。');
  check();const result=await api('/invite-code');check();
  const encoded=result.imageBase64,type=result.contentType;
  if(result.code!==code||!['image/png','image/jpeg'].includes(type)||typeof encoded!=='string'||!encoded.length
    ||encoded.length>699052||encoded.length%4||!/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/.test(encoded)
    ||!(type==='image/png'?encoded.startsWith('iVBORw0KGgo'):encoded.startsWith('/9j/')))
    throw new Error('邀请扫码图片未核实，请重新生成。');
  if(!wx.getFileSystemManager||!wx.env?.USER_DATA_PATH)throw new Error('当前微信版本不能生成扫码图片，请更新后重试。');
  const path=wx.env.USER_DATA_PATH+'/club-invite-code-'+Date.now()+'-'+(++sequence)+(type==='image/png'?'.png':'.jpg');
  try {
    await new Promise((resolve,reject)=>wx.getFileSystemManager().writeFile({filePath:path,data:encoded,encoding:'base64',success:resolve,
      fail:()=>reject(new Error('扫码图片保存失败，请稍后重试。'))}));
    check();return path;
  }catch(error){removeReportFile(path);throw error;}
}
module.exports={downloadInviteCode};
