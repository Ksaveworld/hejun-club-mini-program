const {api,hasSession,sessionStamp,isCurrentSession}=require('../../utils/api');
const categories={translation:'翻译服务',lectures:'课程学习',directory:'资源名录',visits:'参访交流'};
const entries = [
  {id:'partner-application',title:'专业服务合作伙伴申请',category:"合作伙伴招募",group:'professional',summary:"下载合作申请材料，查阅申报要求与审核流程。"},
  {id:'enterprises', title:'会员企业与产品', category:"品牌出海", group:'launch', summary:"展示会员企业与产品，面向海外市场塑造品牌形象。"},
  {id:'reports', title:'资讯报告', category:"行业资讯报告", group:'launch', summary:"查阅海外市场动态、行业研究与出海参考报告。"},
  {id:'enterprise-intake', title:'产品服务入库', category:"出海产品服务入库", group:'launch', summary:"提交企业产品、服务资料，纳入出海会员企业名录展示。"},
  {id:'activities', title:'交流活动', category:"活动交流", group:'connections', summary:"汇聚行业沙龙、热门展会，查看线上线下活动信息；预留热门展会持续上传窗口"},
  {id:'surveys', title:'调研与供需问卷', category:"供需调研", group:'connections', summary:"填写 AI 方案、应用场景、大咖沙龙相关供需调研问卷"},
  {id:'landing-support',title:'落地配套',category:'落地指引',group:'landing',summary:'去哪选址、找谁对接、合作事项；首批资料待补充。'},
  {id:'policy', title:'政策法规', category:"国别政策指引", group:'landing', summary:"查阅海外国别投资规则、出海合规政策与指南文件。"},
  {id:'practice', title:'经营实务', category:"出海经营实务", group:'landing', summary:"参考企业出海实战案例、跨境业务实操方法资料。"},
  {id:'directory', title:"专业服务体系", category:"服务体系介绍", group:'professional', summary:"查看完整出海专业服务类目、服务内容及对接渠道。"}
];
// Display-only grouping; access rules and stored resource categories stay unchanged.
entries.push({id:'exclusive-contacts',title:"专属服务人员",category:"服务团队介绍",group:'professional',summary:"查阅各业务模块专属服务人员信息及对接方式"});
const professionalOrder=['directory','partner-application','exclusive-contacts'];
const serviceGroups = [
  {id:'launch', title:'出海启航', summary:"洞察海外机遇，展示企业实力。", categories:[]},
  {id:'connections', title:'圈层链接', summary:"链接出海同行伙伴，线上线下交流对接，共建产业圈层。", categories:['参访交流','交流与参与']},
  {id:'landing', title:'落地加速', summary:"助力出海方案落地，获取国别政策、实务案例与参考资料。", categories:['阅读与学习','课程学习']},
  {id:'professional', title:'专业护航', summary:"专业团队全程护航，定制出海方案，助力业务落地推进。", categories:['翻译服务','资源名录']}
];
const serviceIcons = {
  reports:'BookOpen-duotone', 'enterprise-intake':'Order-duotone',
  'landing-support':'services-BuildingTwo-duotone', enterprises:'services-BuildingTwo-duotone',
  'partner-application':'Edit-duotone', 'exclusive-contacts':'PeoplesTwo-duotone',
  activities:'PeoplesTwo-duotone', surveys:'Edit-duotone', policy:'BookOpen-duotone', practice:'BookOpen-duotone', directory:'services-BuildingTwo-duotone',
  '课程学习':'services-Slide-duotone', '翻译服务':'services-Translate-duotone',
  '资源名录':'services-BuildingTwo-duotone', '参访交流':'PeoplesTwo-duotone'
};
function groupServices(items) {
  const groups=serviceGroups.map(group=>({id:group.id,title:group.title,summary:group.summary,items:[]}));
  items.forEach(item=>{
    const entry=entries.find(entry=>entry.id===item.id);
    const index=entry?serviceGroups.findIndex(group=>group.id===entry.group):serviceGroups.findIndex(group=>group.categories.includes(item.category));
    const key=entry?item.id:item.category;
    const icon=Object.prototype.hasOwnProperty.call(serviceIcons,key)?serviceIcons[key]:'AllApplication-outline';
    // Unknown published resources remain accessible in professional support.
    groups[index<0?groups.length-1:index].items.push({...item,icon});
  });
  groups.forEach(group=>{if(group.id==='professional')group.items.sort((a,b)=>(professionalOrder.includes(a.id)?professionalOrder.indexOf(a.id):99)-(professionalOrder.includes(b.id)?professionalOrder.indexOf(b.id):99));});
  return groups.filter(group=>group.items.length);
}
Page({
  onShareAppMessage(){return {title:'跨境企业家俱乐部 · 服务与资料',path:'/pages/services/index'};},
  data:{query:'',filteredServices:entries,serviceGroups:groupServices(entries),resources:[],loading:false,error:'',hasMore:false},
  onShow(){ const app=getApp(); const id=app.globalData.pendingServiceId; app.globalData.pendingServiceId=null;
    if(entries.some(item=>item.id===id)||['knowledge','insights','posts','feedback'].includes(id)) this.openService({currentTarget:{dataset:{serviceId:id}}}); return this.refresh(); },
  onHide(){this._request=(this._request||0)+1;this._stamp=null;this.setData({resources:[],loading:false,error:'',hasMore:false});this.filter();},
  onUnload(){this._unloaded=true;this._request=(this._request||0)+1;},
  async onPullDownRefresh(){try{await this.refresh();}finally{wx.stopPullDownRefresh();}},
  async refresh(){
    if(this._unloaded)return;hasSession();const stamp=sessionStamp(),request=this._request=(this._request||0)+1;
    this._stamp=null;this.setData({resources:[],loading:true,error:'',hasMore:false});this.filter();
    try{const result=await api('/resources');hasSession();if(this._unloaded||request!==this._request)return;
      if(!isCurrentSession(stamp))throw new Error('登录状态已变化，请刷新服务。');
      this._stamp=stamp;this.setData({resources:result.resources.filter(item=>item.category!=='translation').map(item=>({...item,category:categories[item.category]||'会员服务'})),hasMore:result.hasMore});this.filter();
    }catch(error){if(!this._unloaded&&request===this._request)this.setData({error:error.message||'服务读取失败，请重试。'});}
    finally{if(!this._unloaded&&request===this._request)this.setData({loading:false});}
  },
  filter(){const filteredServices=[...entries,...this.data.resources].filter(item=>(item.title+item.category+item.summary).includes(this.data.query.trim()));this.setData({filteredServices,serviceGroups:groupServices(filteredServices)});},
  search(event){this.setData({query:event.detail.value});hasSession();if(this._stamp&&!isCurrentSession(this._stamp)){this.onHide();this.setData({error:'登录状态已变化，请刷新服务。'});}this.filter();},
  clearSearch(){this.search({detail:{value:''}});},
  openService(event){const id=event.currentTarget.dataset.serviceId;
    if(id==='exclusive-contacts') wx.navigateTo({url:'/pages/exclusive-contacts/index'});
    else if(id==='partner-application') wx.navigateTo({url:'/pages/applications/index?kind=partner'});
    else if(id==='enterprises') wx.navigateTo({url:'/pages/enterprises/index'});
    else if(id==='professional-content') wx.navigateTo({url:'/pages/articles/index?section=professional'});
    else if(id==='reports') wx.navigateTo({url:'/pages/articles/index?section=launch'});
    else if(id==='landing-support') wx.navigateTo({url:'/pages/articles/index?support=all'});
    else if(id==='policy'||id==='practice') wx.navigateTo({url:'/pages/articles/index?section=landing&topic='+id});
    else if(id==='directory') this.openDirectory();
    else if(id==='enterprise-intake'||id==='surveys') wx.navigateTo({url:'/pages/'+id+'/index'});
    else if(id==='knowledge'||id==='insights') wx.navigateTo({url:'/pages/articles/index?category='+(id==='knowledge'?'knowledge':'news')});
    else if(id==='posts'||id==='feedback'||id==='activities') wx.navigateTo({url:'/pages/'+id+'/index'});
    else {hasSession();if(this._stamp&&isCurrentSession(this._stamp)&&this.data.resources.some(item=>item.id===id)) wx.navigateTo({url:'/pages/service-detail/index?id='+encodeURIComponent(id)});else this.refresh();}
  },
  openDirectory(){wx.navigateTo({url:"/pages/directory/index"});},
  openMembers(){wx.navigateTo({url:'/pages/members/index'});},
  openArticles(){wx.navigateTo({url:'/pages/articles/index'});}
});
