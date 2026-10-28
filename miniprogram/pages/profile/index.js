const {api,hasSession,sessionStamp,isCurrentSession,subscribeSession}=require('../../utils/api');
const {saveProfileAvatar,clearProfileAvatar,clearSelectedAvatar,prepareProfileAvatar}=require('../../utils/profile-avatar');
Page({
 data:{nickname:'',avatarPath:'',loading:true,busy:false,ready:false,error:''},
 async onLoad(){
  this._stamp=sessionStamp();this._generation=0;this._selectedFiles=new Set();
  this._unsubscribe=subscribeSession(()=>{if(!hasSession()||!isCurrentSession(this._stamp))this.clearPrivate('账号已变化，请返回后重新打开。');});
  this.armExpiry();
  return this.loadProfile();
 },
 async loadProfile(){
  const generation=this._generation;
  if(!hasSession()){this.setData({loading:false,error:'请先登录后再完善资料。'});return;}
  this.setData({loading:true,ready:false,error:''});
  try{
   const result=await api('/profile');if(!this.current(generation))return;
   this.setData({nickname:result.profile.nickname||''});
   const uri=result.profile.avatarDataUrl;
   if(uri){
    const path=await saveProfileAvatar(uri);
    if(!this.current(generation)){this.unlink(path);return;}this._ownedFile=path;this.setData({avatarPath:path});
   }
   if(this.current(generation))this.setData({ready:true});
  }catch(error){if(this.current(generation))this.setData({error:error.message||'资料读取失败，请返回重试。'});}
  finally{if(this.current(generation))this.setData({loading:false});}
 },
 current(generation=this._generation){return !this._unloaded&&!this._hidden&&generation===this._generation&&hasSession()&&isCurrentSession(this._stamp);},
 armExpiry(){const delay=Date.parse(this._stamp.expiresAt)-Date.now();if(Number.isFinite(delay)&&delay>0)this._expiryTimer=setTimeout(()=>{if(Date.parse(this._stamp.expiresAt)>Date.now())this.armExpiry();else this.clearPrivate('登录已过期，请重新登录。');},Math.min(delay,2147483647));},
 unlink:clearProfileAvatar,
 clearPrivate(error=''){
  this._generation=(this._generation||0)+1;this.unlink(this._ownedFile);this._ownedFile=null;
  for(const path of this._selectedFiles||[])clearSelectedAvatar(path);this._selectedFiles?.clear();
  this._avatarBase64=null;this._removeAvatar=false;
  this.setData({nickname:'',avatarPath:'',ready:false,busy:false,loading:false,error});
 },
 onHide(){this._hidden=true;this.clearPrivate();},
 onUnload(){this._unloaded=true;this._unsubscribe?.();clearTimeout(this._expiryTimer);this.clearPrivate();},
 onShow(){const hidden=this._hidden;this._hidden=false;if(this._stamp&&!this.current())this.clearPrivate('账号已变化，请返回后重新打开。');else if(hidden)return this.loadProfile();},
 nicknameInput(event){if(!this.current()||this.data.busy||this.data.loading||!this.data.ready)return;this.setData({nickname:event.detail.value});},
 async chooseAvatar(event){
  if(this.data.busy||this.data.loading||!this.data.ready||!this.current())return;
  const path=event.detail.avatarUrl;if(!path)return;
  const generation=this._generation;
  this._selectedFiles.add(path);
  this.setData({busy:true,error:''});
  try{
   const result=await prepareProfileAvatar(path,{current:()=>this.current(generation),track:value=>{if(this.current(generation))this._selectedFiles.add(value);else clearSelectedAvatar(value);}});
   if(!this.current(generation))return;
   for(const selected of this._selectedFiles)if(selected!==result.path){clearSelectedAvatar(selected);this._selectedFiles.delete(selected);}
   this.unlink(this._ownedFile);this._ownedFile=null;
   this._avatarBase64=result.base64;this._removeAvatar=false;this.setData({avatarPath:result.path});
  }catch(error){if(this.current(generation)){for(const selected of this._selectedFiles)if(selected!==this.data.avatarPath){clearSelectedAvatar(selected);this._selectedFiles.delete(selected);}this.setData({error:error.message});}}
  finally{if(this.current(generation))this.setData({busy:false});}
 },
 removeAvatar(){if(this.data.busy||this.data.loading||!this.data.ready||!this.current())return;this.unlink(this._ownedFile);this._ownedFile=null;for(const path of this._selectedFiles)clearSelectedAvatar(path);this._selectedFiles.clear();this._avatarBase64=null;this._removeAvatar=true;this.setData({avatarPath:''});},
 async save(event){
  if(this.data.busy||this.data.loading||!this.data.ready||!this.current())return;
  const nickname=(event.detail?.value?.nickname??this.data.nickname).trim();
  if(!nickname){this.setData({error:'请填写昵称。'});return;}
  this.setData({busy:true,error:''});
  const generation=this._generation;
  try{
   await api('/profile',{nickname,...(this._avatarBase64?{avatarBase64:this._avatarBase64}:{}),...(this._removeAvatar?{removeAvatar:true}:{})});
   if(!this.current(generation))return;
   wx.showToast({title:'资料已保存',icon:'success'});wx.navigateBack({fail:()=>{if(this.current(generation))wx.switchTab({url:'/pages/account/index'});}});
  }catch(error){if(this.current(generation))this.setData({error:error.message||'保存失败，请重试。'});}
  finally{if(this.current(generation))this.setData({busy:false});}
 },
 back(){wx.navigateBack({fail:()=>wx.switchTab({url:'/pages/account/index'})});}
});
