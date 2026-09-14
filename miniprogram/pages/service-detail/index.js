const { api, hasSession, sessionStamp, isCurrentSession } = require('../../utils/api');
const categories = { translation:'翻译服务', lectures:'课程学习', directory:'资源名录', visits:'参访交流' };
Page({
  data:{service:null,loading:false,opening:false,confirming:false,error:'',category:'',actionLabel:''},
  onLoad(options={}) { this._id=options.id || ''; this._request=0; },
  onShow() { return this.refresh(); },
  onHide() { this.invalidate(); },
  onUnload() { this._unloaded=true; this._request++; },
  invalidate() { this._request++; this._stamp=null; this._prepared=null; this.setData({service:null,loading:false,opening:false,confirming:false}); },
  current(stamp,request) { hasSession(); return !this._unloaded && this._request===request && isCurrentSession(stamp); },
  async onPullDownRefresh() { try { await this.refresh(); } finally { wx.stopPullDownRefresh(); } },
  async refresh() {
    if(this._unloaded) return;
    this.invalidate(); this.setData({loading:true,error:''});
    const stamp=sessionStamp(), request=this._request;
    try {
      if(!/^[a-f0-9-]+$/.test(this._id)) throw new Error('没有找到此服务，请返回服务列表。');
      const {resource}=await api('/resources/'+this._id);
      if(!this.current(stamp,request)) return;
      this._stamp=stamp;
      this.setData({service:resource,category:categories[resource.category] || '会员服务',
        actionLabel:resource.action.type==='phone'?'拨打服务电话':'打开服务小程序'});
    } catch(error) { if(!this._unloaded && request===this._request) this.failure(error); }
    finally { if(!this._unloaded && request===this._request) this.setData({loading:false}); }
  },
  failure(error) { this.setData({service:null,error:error.status===404?'服务已撤下或当前不可使用，请返回服务列表。':error.message || '暂时无法读取服务，请重试。'}); },
  async useService() {
    if(this.data.confirming || this.data.opening || this.data.loading || !this.data.service || !this._stamp) return;
    const stamp=this._stamp, request=this._request, revision=this.data.service.revision;
    if(!this.current(stamp,request)) { this.invalidate();this.setData({error:'登录状态已变化，请刷新服务。'});return; }
    this.setData({opening:true,error:''});
    try {
      const {resource}=await api('/resources/'+this._id);
      if(!this.current(stamp,request)) return;
      if(resource.revision!==revision) { await this.refresh();this.setData({error:'服务信息已更新，请核对后重新使用。'});return; }
      this._prepared={resource,stamp,request,expiresAt:Date.now()+15000};
      this.setData({confirming:true});
    } catch(error) { if(!this._unloaded && request===this._request) this.failure(error); }
    finally { if(!this._unloaded && request===this._request) this.setData({opening:false}); }
  },
  cancelUse(){this._prepared=null;this.setData({confirming:false});},
  confirmService(){
    const prepared=this._prepared;
    if(!prepared || this.data.opening) return;
    const {resource,stamp,request,expiresAt}=prepared;
    this.cancelUse();
    if(!this.current(stamp,request)){this.invalidate();this.setData({error:'登录状态已变化，请刷新服务。'});return;}
    if(Date.now()>expiresAt){this.setData({error:'请重新点击使用入口，更新服务状态。'});return;}
    this.setData({opening:true,error:''});
    const success=()=>{if(this.current(stamp,request))this.setData({opening:false});};
    const fail=()=>{if(this.current(stamp,request))this.setData({opening:false,error:'未能打开服务，可重试或通过帮助与反馈联系我们。'});};
    // Invoke synchronously in the button's tap handler to preserve WeChat's user gesture.
    try{
      if(resource.action.type==='miniProgram')wx.navigateToMiniProgram({appId:resource.action.appId,path:resource.action.path,envVersion:'release',success,fail});
      else if(resource.action.type==='phone')wx.makePhoneCall({phoneNumber:resource.action.phoneNumber,success,fail});
      else fail();
    }catch{fail();}
  },
  openHelp(){ wx.navigateTo({url:'/pages/feedback/index'}); },
  backToServices(){ wx.switchTab({url:'/pages/services/index'}); }
});
