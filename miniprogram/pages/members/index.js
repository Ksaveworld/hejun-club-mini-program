const { pricedMembershipPlans } = require('../../utils/membership-display');
const { chineseDateTime } = require('../../utils/display-time');
const { api, captureReferral, hasSession, sessionStamp, isCurrentSession } = require('../../utils/api');

Page({
  onLoad(options) { captureReferral(options); },
  onShareAppMessage() { return {title:'跨境企业家俱乐部 · 会籍与权益',path:'/pages/members/index'}; },
  data: { plans:pricedMembershipPlans([]),plansLoading:false,plansError:'',renewals:null,membership:null,renewalError:'' },
  onShow(){this._visible=true;return Promise.all([this.loadPlans(),this.loadRenewal()]);},
  onHide(){this._visible=false;this._plansRequest=(this._plansRequest||0)+1;this._renewalRequest=(this._renewalRequest||0)+1;this.setData({renewals:null,membership:null,renewalError:''});},
  onUnload(){this._unloaded=true;this._plansRequest=(this._plansRequest||0)+1;this._renewalRequest=(this._renewalRequest||0)+1;},
  async loadPlans(){
    const request=this._plansRequest=(this._plansRequest||0)+1;
    this.setData({plans:pricedMembershipPlans([]),plansLoading:true,plansError:''});
    try{const result=await api('/plans');if(this._unloaded||request!==this._plansRequest)return;
      const plans=pricedMembershipPlans(result.plans);
      this.setData({plans,plansError:plans.every(plan=>plan.priceReady)?'':'部分方案价格暂未确认，请重新读取后选择。'});
    }catch(error){if(!this._unloaded&&request===this._plansRequest)this.setData({plansError:'暂时无法读取当前年费，请重试。'});}
    finally{if(!this._unloaded&&request===this._plansRequest)this.setData({plansLoading:false});}
  },
  async loadRenewal(){
    this.setData({renewals:null,membership:null,renewalError:''});if(!hasSession())return;
    const stamp=sessionStamp(),request=this._renewalRequest=(this._renewalRequest||0)+1;
    try{const session=await api('/me');if(this._unloaded||request!==this._renewalRequest||!isCurrentSession(stamp)||!hasSession())return;
      this._renewalStamp=stamp;this.setData({renewals:session.renewals||{enabled:false,reason:'同档续费暂未开放'},membership:session.membership?Object.assign({},session.membership,{expiryLabel:chineseDateTime(session.membership.expiresAt)}):null});
    }catch(error){if(!this._unloaded&&request===this._renewalRequest)this.setData({renewalError:error.message||'续费状态暂未读取'});}
  },
  openRenewal(){if(!this.data.renewals?.enabled||!this.data.renewals.canRenew||!this.data.membership||!hasSession()||!isCurrentSession(this._renewalStamp))return;
    wx.navigateTo({url:'/pages/join/index?planId='+this.data.membership.planId+'&transactionKind=renewal'});},
  openGuide(){wx.navigateTo({url:'/pages/guide/index?id=choose-membership'});},
  openHelp(){wx.navigateTo({url:'/pages/help/index'});},
  openPlan(event) {
    const plan = this.data.plans.find(item => item.id === event.currentTarget.dataset.planId);
    if (!plan || !plan.priceReady) return;
    wx.navigateTo({ url: (hasSession() ? '/pages/join/index?planId=' : '/pages/login/index?planId=') + plan.id });
  },
  openServices() {
    getApp().globalData.pendingServiceId = null;
    wx.switchTab({ url: '/pages/services/index' });
  }
});
