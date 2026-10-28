const guides=require('../../data/guides');
const {api}=require('../../utils/api');
const {pricedMembershipPlans}=require('../../utils/membership-display');
Page({
  data:{guides,selected:null,choiceGuide:false,plans:pricedMembershipPlans([]),plansError:''},
  onLoad(options={}){const selected=guides.find(item=>item.id===(options.id||'getting-started'))||null;
    const choiceGuide=selected?.id==='choose-membership';
    this.setData({choiceGuide,selected:choiceGuide?Object.assign({},selected,{summary:'按业务需求选择会籍，当前年费以会员方案为准。',paragraphs:[]}):selected});
    if(choiceGuide)return this.loadPlans();
  },
  onUnload(){this._unloaded=true;},
  async loadPlans(){try{const result=await api('/plans');if(!this._unloaded)this.setData({plans:pricedMembershipPlans(result.plans),plansError:''});}
    catch(error){if(!this._unloaded)this.setData({plansError:'当前年费暂未读取，请前往会员权益页重新核对。'});}},
  openGuide(e){const id=e.currentTarget.dataset.id;if(guides.some(item=>item.id===id))wx.navigateTo({url:'/pages/guide/index?id='+id});},
  openMembers(){wx.navigateTo({url:'/pages/members/index'});},
  openHelp(){wx.navigateTo({url:'/pages/help/index'});},
  onShareAppMessage(){const item=this.data.selected;return {title:item?.title||'俱乐部入会指南',path:'/pages/guide/index'+(item?'?id='+item.id:'')};}
});
