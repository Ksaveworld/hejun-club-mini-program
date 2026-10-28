Page({
  data: {
    sections: [
      {number:'01', title:'出海启航', tagline:'让产品与服务被更多人看见', text:'了解市场资讯与研究报告，展示已获授权发布的会员企业及产品服务。企业可提交资料，由工作人员联系、评估并安排展示。'},
      {number:'02', title:'圈层链接', tagline:'和有跨境需求的人同行', text:'查看专题分享、业务提升、标杆参访及其他交流活动；填写出海调研与供需问卷，让工作人员更好地了解你的需求。'},
      {number:'03', title:'落地加速', tagline:'从了解方向，到参考实务', text:'查找政策法规、国别投资指南、企业出海指引与经营实务资料，通过出海案例拓宽思路。'},
      {number:'04', title:'专业护航', tagline:'为企业寻找合适的专业支持', text:'了解战略咨询等六大专业服务、专业合作伙伴与相关资料。具体服务方案、费用及优惠由双方沟通确认。'}
    ]
  },
  openMembers() { wx.navigateTo({url: '/pages/members/index'}); },
  openServices() { wx.switchTab({url: '/pages/services/index'}); },
  openSurveys() { wx.navigateTo({url: '/pages/surveys/index'}); },
  callContact() { wx.makePhoneCall({phoneNumber: '15502170129'}); },
  onShareAppMessage() { return {title: '中国—东盟跨境企业家俱乐部', path: '/pages/club-intro/index'}; }
});
