const { api, captureReferral, hasSession, sessionStamp, isCurrentSession } = require('../../utils/api');
const { memberJourney } = require('../../utils/member-journey');
Page({
  data: { loading: false, contentError: '', articles: [], journey: null,
    shortcuts: [{ id: 'knowledge', label: '知识资料', mark: '知' }, { id: 'activities', label: '俱乐部活动', mark: '聚' },
      { id: 'orders', label: '申请进度', mark: '会' }, { id: 'feedback', label: '帮助反馈', mark: '问' }] },
  onLoad(options) { captureReferral(options); this._generation = 0; },
  onShow() { this._visible = true; return this.refresh(); },
  onHide() { this._visible = false; this._generation++; this.setData({articles: [], journey: null, loading: false}); },
  onUnload() { this._visible = false; this._generation++; },
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
  openMembers() { wx.navigateTo({url:'/pages/members/index'}); },
  openServices(event) {
    const id=event.currentTarget.dataset.serviceId;
    if(id==='knowledge'||id==='insights') wx.navigateTo({url:'/pages/articles/index?category='+(id==='knowledge'?'knowledge':'news')});
    else if(id==='orders'||id==='feedback'||id==='activities') wx.navigateTo({url:'/pages/'+id+'/index'});
    else wx.switchTab({url:'/pages/services/index'});
  },
  openGuide() { this.openMembers(); },
  openArticles(){wx.navigateTo({url:'/pages/articles/index'});}
});
