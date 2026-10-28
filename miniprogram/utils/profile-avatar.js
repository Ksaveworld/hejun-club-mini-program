// Private avatar bytes become a temporary local file, never a public URL.
const {newKey}=require('./api');
function clearProfileAvatar(path){
 if(typeof path==='string'&&path.indexOf(wx.env.USER_DATA_PATH+'/club-profile-')===0)wx.getFileSystemManager().unlink({filePath:path,fail(){}});
}
async function saveProfileAvatar(uri){
 if(!uri)return '';
 const match=/^data:image\/(png|jpeg);base64,([A-Za-z0-9+/=]+)$/.exec(uri);
 if(!match||uri.length>87420)throw Error('头像数据暂不可用，请重新选择。');
 const path=wx.env.USER_DATA_PATH+'/club-profile-'+newKey()+'.'+(match[1]==='jpeg'?'jpg':'png');
 await new Promise((resolve,reject)=>wx.getFileSystemManager().writeFile({filePath:path,data:match[2],encoding:'base64',success:resolve,fail:()=>{clearProfileAvatar(path);reject(Error('头像读取失败，请检查微信存储空间。'));}}));
 return path;
}
// Paths are passed only from chooseAvatar/compressImage callbacks, never text input.
function clearSelectedAvatar(path){
 if(typeof path==='string'&&(/^(wxfile:\/\/|https?:\/\/tmp\/)/.test(path)||path.indexOf(wx.env.USER_DATA_PATH+'/')===0))wx.getFileSystemManager().unlink({filePath:path,fail(){}});
}
async function prepareProfileAvatar(source,{track=()=>{},current=()=>true}={}){
 const ensure=()=>{if(!current())throw Error('账号或页面已变化，请重新选择头像。');};
 const info=path=>new Promise((resolve,reject)=>wx.getImageInfo({src:path,success:resolve,fail:()=>reject(Error('无法读取头像，请重新选择。'))}));
 const original=await info(source);ensure();
 if(!['png','jpeg','jpg'].includes(original.type)||!(original.width>0&&original.height>0))throw Error('请选择PNG或JPEG静态头像。');
 if(typeof wx.compressImage!=='function')throw Error('当前微信版本不能处理头像，请更新微信后重试。');
 // Official api-typings: compressedWidth/Height (base library 2.26.0), quality only affects JPEG.
 for(const [edge,quality] of [[512,80],[256,65],[128,50]]){
  ensure();const ratio=Math.min(1,edge/Math.max(original.width,original.height));
  const result=await new Promise((resolve,reject)=>wx.compressImage({src:source,compressedWidth:Math.max(1,Math.round(original.width*ratio)),compressedHeight:Math.max(1,Math.round(original.height*ratio)),quality,success:resolve,fail:()=>reject(Error('头像处理失败，请重新选择图片。'))}));
  const path=result.tempFilePath;track(path);ensure();
  const image=await info(path);ensure();
  const stat=await new Promise((resolve,reject)=>wx.getFileSystemManager().stat({path,success:resolve,fail:()=>reject(Error('头像读取失败，请重新选择。'))}));ensure();
  if(image.width>1024||image.height>1024||!['png','jpeg','jpg'].includes(image.type))continue;
  if(!(stat.stats.size>0&&stat.stats.size<=65536))continue;
  const content=await new Promise((resolve,reject)=>wx.getFileSystemManager().readFile({filePath:path,encoding:'base64',success:resolve,fail:()=>reject(Error('头像读取失败，请重试。'))}));ensure();
  if(typeof content.data!=='string'||content.data.length>87384)continue;
  return {path,base64:content.data};
 }
 throw Error('头像压缩后仍无法保存，请换一张图片。');
}
module.exports={saveProfileAvatar,clearProfileAvatar,clearSelectedAvatar,prepareProfileAvatar};
