const { api, newKey, sessionStamp, isCurrentSession } = require('../../utils/api');
Page({
 data:{application:null,canApply:false,ready:false,contact:'',introduction:'',consent:false,busy:false,error:''},
 onLoad(){this._key=newKey();},
 onShow(){this._visible=true;return this.refresh();},
 onHide(){this._visible=false;this._stamp=null;this.setData({application:null,contact:'',introduction:'',consent:false,ready:false,busy:false,canApply:false,error:''});},
 onUnload(){this._visible=false;},
 async refresh(){const stamp=sessionStamp();this._stamp=stamp;try{const r=await api('/ambassador');if(this._visible&&isCurrentSession(stamp))this.setData({...r,ready:true,error:''});}catch(e){if(this._visible)this.setData({error:e.message});}},
 change(e){if(!this.data.busy)this.setData({[e.currentTarget.dataset.field]:e.detail.value});},
 consent(e){this.setData({consent:e.detail.value.length>0});},
 async submit(){if(this.data.busy||!this._stamp||!isCurrentSession(this._stamp))return;this.setData({busy:true,error:''});const stamp=this._stamp;
  try{const r=await api('/ambassador',{contact:this.data.contact,introduction:this.data.introduction,consent:this.data.consent},this._key);if(this._visible&&isCurrentSession(stamp))this.setData({application:r.application,contact:'',introduction:''});}
  catch(e){if(this._visible&&isCurrentSession(stamp))this.setData({error:e.message});}finally{if(this._visible)this.setData({busy:false});}
 },
 openMembers(){wx.navigateTo({url:'/pages/members/index'});},
 openLogin(){wx.navigateTo({url:'/pages/login/index'});}
});
