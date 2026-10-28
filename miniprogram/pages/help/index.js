const {openPublicDocument,showPublicDocuments,hidePublicDocuments,clearPublicDocuments}=require('../../utils/public-documents');
const questions=[
  {question:'入会需要经过审核吗？',answer:'基础会员和星级会员付款成功后开通，无需资质预审。机构及专业会员本期仅预报名，提交后待审核，暂不收费或开通。'},
  {question:'会籍有效期如何计算？',answer:'从核验付款成功时起算一年。提交申请及资质审核期间不计入会籍有效期。'},
  {question:'当前如何付款和开通？',answer:'付款方式以订单页面当前开放状态为准。未开放时请勿付款。提交付款说明不会直接开通，须核实真实到账；若已扣款而状态未更新，请保留订单编号并提交问题，勿重复付款。'},
  {question:'付款异常或申请售后怎么办？',answer:'请在本页提交反馈，或联系会员服务协议中的服务邮箱57230431@qq.com，提供订单编号并说明情况。已扣款但未确认到账时，先刷新原订单，不要重复付款。退款条件及处理方式以会员服务协议和核实结果为准；提交反馈不代表退款已经完成。'},
  {question:'推荐来源怎么记录？',answer:'从有效邀请链接或小程序卡片进入时会自动承接推荐来源，已有有效来源不会被覆盖。默认来源以后台实际配置为准，可在“我的”查看推荐信息。'},
  {question:'在哪里查看审核结果？',answer:'打开“我的 → 申请与订单”，进入对应订单并刷新状态，即可查看审核结果及说明。'}
];
Page({
  data:{questions,expanded:-1,error:''},
  onShow(){showPublicDocuments(this);},onHide(){hidePublicDocuments(this);},
  onUnload(){this._unloaded=true;clearPublicDocuments(this);},
  toggle(e){const index=Number(e.currentTarget.dataset.index);if(Number.isInteger(index)&&index>=0&&index<questions.length)this.setData({expanded:this.data.expanded===index?-1:index});},
  openFeedback(){wx.navigateTo({url:'/pages/feedback/index'});},
  openGuide(){wx.navigateTo({url:'/pages/guide/index?id=getting-started'});},
  async openLegal(e){const id=e.currentTarget.dataset.id;if(!['terms','privacy'].includes(id))return;try{this.setData({error:''});await openPublicDocument('/legal/'+id+'/document','pdf',this);}catch(error){if(!this._unloaded)this.setData({error:error.message});}},
  onShareAppMessage(){return {title:'俱乐部 · 帮助与反馈',path:'/pages/help/index'};}
});
