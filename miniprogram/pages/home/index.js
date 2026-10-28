const { api, captureReferral, hasSession, sessionStamp, isCurrentSession } = require('../../utils/api');
const { memberJourney } = require('../../utils/member-journey');
const activityCards = [
  {id:'salon',label:'中国—东盟 · AI大咖沙龙',tag:'会后调研',title:'您的反馈，下一场的起点',description:'分享参会感受，告诉我们您的合作与出海需求。',action:'填写参会反馈问卷',url:'/pages/surveys/index?side=salon'},
  {id:'matchmaking',label:'供需对接',tag:'长期征集',title:'让AI找到你的业务',description:'发布技术供给，或说出企业需求。',action:'填写供需问卷',url:'/pages/surveys/index'},
  {id:'expo',label:'东博会 · 南宁',tag:'9.17—9.21',title:'相聚东博会',description:'查看重点投资贸易促进活动安排。',action:'查看活动安排表',url:'/pages/activities/index?id=61ad4bed-7c35-4059-8ee9-799086c86b83'},
  {id:'singapore',label:'新加坡 · AI分论坛',tag:'11月路演',title:'下一站，新加坡',description:'登记路演意向，连接跨境合作机会。',action:'填写路演意向',url:'/pages/surveys/index?side=singapore'}
];
Page({
  data: { activityCards, activeCard: 0, loading: false, contentError: '', articles: [], journey: null,
    shortcuts: [{ id: 'reports', label: '资讯报告', icon: 'BookOpen' }, { id: 'activities', label: '交流活动', icon: 'PeoplesTwo' },
      { id: 'enterprise', label: '产品服务入库', icon: 'Order' }, { id: 'exhibitions', label: '热门展会', icon: 'services-Slide' }] },
  onLoad(options) { captureReferral(options); this._generation = 0; },
  onShareAppMessage() { return {title:'跨境企业家俱乐部 · 会员服务',path:'/pages/home/index'}; },
  onShow() { this._visible = true; this.loadActivities(); return this.refresh(); },
  onHide() { this._visible = false; this._generation++; this._activitiesRequest=(this._activitiesRequest||0)+1; this.setData({articles: [], journey: null, loading: false}); },
  onUnload() { this._visible = false; this._generation++; this._activitiesRequest=(this._activitiesRequest||0)+1; },
  async onPullDownRefresh() { try { await this.refresh(); } finally { wx.stopPullDownRefresh(); } },
  async refresh() {
    const loggedIn = hasSession(), stamp = sessionStamp(), generation = ++this._generation;
    this._stamp = stamp;
    const current = () => { hasSession(); return this._visible && generation === this._generation && isCurrentSession(stamp); };
    this.setData({loading: true, contentError: '', articles: [], journey: null});
    const content = async () => {
      try { const result = await api('/articles'); if(current()) this.setData({articles: result.articles.slice(0,3)}); }
      catch(error) { if(current()) this.setData({contentError: '内容读取失败，请重试。'}); }
    };
    const personal = async () => {
      if(!loggedIn) return;
      try { const me = await api('/me'); if(!current() || me.user?.role !== 'member') return;
        const result = await api('/orders'); if(current()) this.setData({journey: memberJourney(me.membership, result.orders)});
      } catch(error) { /* Personal state is optional here; its dedicated page provides recovery. */ }
    };
    await Promise.all([content(), personal()]);
    if(current()) this.setData({loading: false});
    else if(this._visible && generation === this._generation) this.setData({loading: false, articles: [], journey: null});
  },
  openJourney() { wx.switchTab({url:'/pages/account/index'}); },
  openArticle(event) {
    hasSession();
    if (!this._stamp || !isCurrentSession(this._stamp)) { this.setData({ articles: [], journey: null, contentError: '登录状态已变化，请刷新。' }); return; }
    const id=event.currentTarget.dataset.id;
    if(this.data.articles.some(article=>article.id===id)) wx.navigateTo({url:'/pages/articles/index?id='+encodeURIComponent(id)});
  },
  async loadActivities() {
    const request=this._activitiesRequest=(this._activitiesRequest||0)+1;
    this.setData({activityCards,activeCard:0});
    try {const result=await api('/enterprise-intake'); if(!this._visible || request!==this._activitiesRequest)return;
      const cards=result.mode==='hybrid'?[{id:'enterprise',label:'企业出海 · 资料收集',tag:'需求登记',title:'企业出海需求登记',description:'在线填写关键需求，上传完整材料，方便统计和服务对接。',action:'填写企业出海需求',url:'/pages/enterprise-intake/index'},...activityCards]:activityCards;
      this.setData({activityCards:cards,activeCard:0});
    }catch(error) { /* Existing activity entries remain available when config fails. */ }
  },
  cardChanged(e){this.setData({activeCard:e.detail.current});},
  moveCard(e){this.setData({activeCard:Math.max(0,Math.min(this.data.activityCards.length-1,this.data.activeCard+Number(e.currentTarget.dataset.step)))});},
  openActivity(e){const card=this.data.activityCards.find(c=>c.id===e.currentTarget.dataset.id);if(card)wx.navigateTo({url:card.url});},
  openActivities(){wx.navigateTo({url:'/pages/activities/index'});},
  openSurveys() { wx.navigateTo({url: "/pages/surveys/index"}); },
  openMembers() { wx.navigateTo({url:'/pages/members/index'}); },
  openIntroduction() { wx.navigateTo({url:'/pages/club-intro/index'}); },
  openServices(event) {
    const id=event.currentTarget.dataset.serviceId;
    if(id==='reports') wx.navigateTo({url:'/pages/articles/index'});
    else if(id==='enterprise') wx.navigateTo({url:'/pages/enterprise-intake/index'});
    else if(id==='directory') wx.navigateTo({url:'/pages/directory/index'});
    else if(id==='knowledge'||id==='insights') wx.navigateTo({url:'/pages/articles/index?category='+(id==='knowledge'?'knowledge':'news')});
    else if(id==='exhibitions') wx.navigateTo({url:'/pages/activities/index'});
    else if(id==='feedback') wx.navigateTo({url:'/pages/help/index'});
    else if(id==='orders'||id==='activities') wx.navigateTo({url:'/pages/'+id+'/index'});
    else wx.switchTab({url:'/pages/services/index'});
  },
  openGuide() { wx.navigateTo({url:'/pages/guide/index?id=getting-started'}); },
  openArticles(){wx.navigateTo({url:'/pages/articles/index'});}
});
