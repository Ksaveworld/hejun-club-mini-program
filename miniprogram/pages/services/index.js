const {api,hasSession,sessionStamp,isCurrentSession}=require('../../utils/api');
const categories={translation:'翻译服务',lectures:'课程学习',directory:'资源名录',visits:'参访交流'};
const entries = [
  {id:'knowledge', title:'跨境知识库', category:'阅读与学习', summary:'搜索知识资料，阅读跨境经营实务。'},
  {id:'activities', title:'俱乐部活动', category:'交流与参与', summary:'查看活动安排、地点及参与说明。'},
  {id:'insights', title:'行业资讯', category:'阅读与学习', summary:'查看俱乐部发布的资讯与市场观察。'},
  {id:'posts', title:'我的投稿', category:'会员参与', summary:'提交文字稿件，跟进审核结果。'},
  {id:'feedback', title:'帮助与反馈', category:'会员支持', summary:'提交问题、补充说明，查看处理回复。'}
];
Page({
  data:{query:'',filteredServices:entries,resources:[],loading:false,error:'',hasMore:false},
  onShow(){ const app=getApp(); const id=app.globalData.pendingServiceId; app.globalData.pendingServiceId=null;
    if(entries.some(item=>item.id===id)) this.openService({currentTarget:{dataset:{serviceId:id}}}); return this.refresh(); },
  onHide(){this._request=(this._request||0)+1;this._stamp=null;this.setData({resources:[],loading:false,error:'',hasMore:false});this.filter();},
  onUnload(){this._unloaded=true;this._request=(this._request||0)+1;},
  async onPullDownRefresh(){try{await this.refresh();}finally{wx.stopPullDownRefresh();}},
  async refresh(){
    if(this._unloaded)return;hasSession();const stamp=sessionStamp(),request=this._request=(this._request||0)+1;
    this._stamp=null;this.setData({resources:[],loading:true,error:'',hasMore:false});this.filter();
    try{const result=await api('/resources');hasSession();if(this._unloaded||request!==this._request)return;
      if(!isCurrentSession(stamp))throw new Error('登录状态已变化，请刷新服务。');
      this._stamp=stamp;this.setData({resources:result.resources.map(item=>({...item,category:categories[item.category]||'会员服务'})),hasMore:result.hasMore});this.filter();
    }catch(error){if(!this._unloaded&&request===this._request)this.setData({error:error.message||'服务读取失败，请重试。'});}
    finally{if(!this._unloaded&&request===this._request)this.setData({loading:false});}
  },
  filter(){this.setData({filteredServices:[...entries,...this.data.resources].filter(item=>(item.title+item.category+item.summary).includes(this.data.query.trim()))});},
  search(event){this.setData({query:event.detail.value});hasSession();if(this._stamp&&!isCurrentSession(this._stamp)){this.onHide();this.setData({error:'登录状态已变化，请刷新服务。'});}this.filter();},
  clearSearch(){this.search({detail:{value:''}});},
  openService(event){const id=event.currentTarget.dataset.serviceId;
    if(id==='knowledge'||id==='insights') wx.navigateTo({url:'/pages/articles/index?category='+(id==='knowledge'?'knowledge':'news')});
    else if(id==='posts'||id==='feedback'||id==='activities') wx.navigateTo({url:'/pages/'+id+'/index'});
    else {hasSession();if(this._stamp&&isCurrentSession(this._stamp)&&this.data.resources.some(item=>item.id===id)) wx.navigateTo({url:'/pages/service-detail/index?id='+encodeURIComponent(id)});else this.refresh();}
  },
  openDirectory(){wx.navigateTo({url:"/pages/directory/index"});},
  openMembers(){wx.navigateTo({url:'/pages/members/index'});},
  openArticles(){wx.navigateTo({url:'/pages/articles/index'});}
});
