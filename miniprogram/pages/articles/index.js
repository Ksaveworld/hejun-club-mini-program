const { openOfficialArticle } = require('../../utils/official-article');
const { showsInfo } = require('../../utils/article-display');
const supportTopics = require('../../data/landing-support');
const { returnToPrevious } = require('../../utils/navigation');
const { readArticleCatalog } = require('../../utils/article-catalog');
const { api, hasSession, sessionStamp, isCurrentSession,downloadArticle,removeReportFile } = require('../../utils/api');

// Display-only topics: never change stored categories or server reading permissions.
function articleTopic(item) {
  const title = String(item.title || '');
  if (/投资指南|出海指引|政策法规|法律法规|国别指南/.test(title)) return 'policy';
  if (/案例|经营实务|业务实务|操作实务/.test(title)) return 'practice';
  return '';
}
Page({
  onPageScroll(event) { if(!this.data.loading && !this._restoringScroll) this._scrollTop=event.scrollTop; },
  restoreListPosition() { if(!this.data.detailId && wx.nextTick && this._scrollTop) { this._restoringScroll=true;wx.nextTick(()=>{ if(!this._unloaded)wx.pageScrollTo({scrollTop:this._scrollTop,duration:0});this._restoringScroll=false; }); } },
  data: { supportMode: false, supportTopics, supportSelected: null, loading: false, ready: false, loggedIn: false, articles: [], filtered: [],
    practiceCategory: '', policyCategory: '', fixedTopic: '', isRecap: false, detailId: '', query: '', category: 'all', topic: 'all', section: 'all', placements: {}, selected: null, officialError: false, error: '', hasMore: false },
  onLoad(options = {}) { this._request = 0; if(options.support==='all'||supportTopics.some(t=>t.id===options.support)){this.setData({supportMode:true,supportSelected:supportTopics.find(t=>t.id===options.support)||null});return;} this.setData({ fixedTopic:['policy','practice'].includes(options.topic)?options.topic:'', isRecap: options.recap === '1', detailId: options.id || '', section: ['launch','landing','professional'].includes(options.section) ? options.section : 'all', topic: ['policy','practice'].includes(options.topic) ? options.topic : 'all', category: ['news','knowledge'].includes(options.category) ? options.category : 'all' }); },
  openSupport(event){const topic=supportTopics.find(t=>t.id===event.currentTarget.dataset.id);if(topic)wx.navigateTo({url:topic.articleId?'/pages/articles/index?id='+encodeURIComponent(topic.articleId):'/pages/articles/index?support='+topic.id});},
  backSupport(){returnToPrevious(this,'/pages/articles/index?support=all');},
  onShareAppMessage() {
    if(this.data.supportMode)return {title:this.data.supportSelected?.title||'落地配套',path:'/pages/articles/index?support='+(this.data.supportSelected?.id||'all')};
    const article=this.data.ready&&!this.data.loading&&this._stamp&&this.current(this._stamp,this._request)&&this.data.selected;
    return article&&/^[a-f0-9-]+$/.test(article.id)
      ? {title:article.title,path:'/pages/articles/index?id='+encodeURIComponent(article.id)}
      : {title:'跨境企业家俱乐部 · 资讯报告',path:'/pages/articles/index'};
  },
  async onPullDownRefresh() { try { await this.refresh(); } finally { wx.stopPullDownRefresh(); } },
  navigateArticle(event) {
    if (!this.data.ready || this.data.loading || !this._stamp || !this.current(this._stamp, this._request)) return;
    const id = event.currentTarget.dataset.id;
    if (this.data.articles.some(item => item.id === id)) wx.navigateTo({url:'/pages/articles/index?id='+encodeURIComponent(id)});
  },
  backToList() { returnToPrevious(this,'/pages/articles/index'); },
  onShow() { if(this._pdfPath)removeReportFile(this._pdfPath);this._pdfPath=null;return this.refresh(); },
  onHide() { this.invalidate(); },
  onUnload() { this._unloaded = true; this._request++; removeReportFile(this._pdfPath); this._pdfPath = null; },
  invalidate() {
    this._request++; this._stamp = null;
    this.setData({ articles: [], filtered: [], placements: {}, selected: null, officialError: false, ready: false, loading: false, hasMore: false });
  },
  current(stamp, request) {
    hasSession(); // Clear an expired credential before comparing the response context.
    return !this._unloaded && this._request === request && isCurrentSession(stamp);
  },
  filter() {
    if (this._stamp && !this.current(this._stamp, this._request)) {
      this.invalidate(); this.setData({ error: '登录状态已变化，请刷新内容。' }); return;
    }
    const keyword = this.data.query.trim().toLowerCase();
    this.setData({ filtered: this.data.articles.filter(item =>
      showsInfo(this.data.placements[item.id])
      && (!this.data.supportSelected || this.data.placements[item.id]?.supportCategory === this.data.supportSelected.id)
      && (this.data.category === 'all' || (item.document ? 'knowledge' : 'news') === this.data.category)
      && (!this.data.practiceCategory || this.data.placements[item.id]?.practiceCategory === this.data.practiceCategory)
      && (!this.data.policyCategory || this.data.placements[item.id]?.policyCategory === this.data.policyCategory)
      && (this.data.topic === 'all' || (this.data.placements[item.id] ? this.data.placements[item.id].topic : articleTopic(item)) === this.data.topic)
      && (this.data.section === 'all' || (this.data.placements[item.id]?.section || (articleTopic(item) ? 'landing' : 'launch')) === this.data.section)
      && (item.title + ' ' + item.summary).toLowerCase().includes(keyword)) });
  },
  search(event) { this.setData({ query: event.detail.value }); this.filter(); },
  choosePracticeCategory(event){const value=event.currentTarget.dataset.value;if(!['','cases','methods','library'].includes(value))return;this.setData({practiceCategory:value});this.filter();},
  choosePolicyCategory(event){const value=event.currentTarget.dataset.value;if(!['','investment','compliance','guides'].includes(value))return;this.setData({policyCategory:value});this.filter();},
  chooseCategory(event) {
    const category = event.currentTarget.dataset.category;
    if (!['all', 'news', 'knowledge'].includes(category)) return;
    this.setData({ category }); this.filter();
  },
  showAllSections() { this.setData({section: 'all', topic: 'all'}); this.filter(); },
  chooseTopic(event) {
    const topic = event.currentTarget.dataset.topic;
    if (!['all', 'policy', 'practice'].includes(topic)) return;
    this.setData({ topic }); this.filter();
  },
  resetFilters() { this.setData({ query: '', category: 'all', policyCategory:'', practiceCategory:'', topic: this.data.fixedTopic||'all', section:this.data.fixedTopic?'landing':'all' }); this.filter(); },
  async refresh() {
    if (this._unloaded) return;
    this.invalidate();
    this.setData({ loading: true, loggedIn: hasSession(), error: '' });
    const stamp = sessionStamp(), request = this._request;
    try {
      if (this.data.detailId) {
        const detail=await api('/articles/'+encodeURIComponent(this.data.detailId));
        if (!this.current(stamp,request)) throw new Error('登录状态已变化，请重新打开内容。');
        this._stamp=stamp;this.setData({selected:detail.article,ready:true});return;
      }
      const [result, classification] = await Promise.all([readArticleCatalog(api,()=>this.current(stamp,request)), api('/content-topics').catch(()=>null)]);
      if (!this.current(stamp, request)) throw Object.assign(new Error('登录状态已变化，请刷新内容。'), { code: 'CONTEXT_CHANGED' });
      this._stamp = stamp;
      if(!classification)throw new Error('资料归类暂不可用，请稍后重新读取。');
      this.setData({ articles: result.articles, placements: Object.fromEntries((classification?.topics || []).map(item=>[item.articleId,item])), hasMore: result.hasMore, ready: true });
      this.filter();
      if(this.data.supportMode)this.setData({supportTopics:supportTopics.map(t=>({...t,count:result.articles.filter(a=>showsInfo(this.data.placements[a.id])&&this.data.placements[a.id]?.supportCategory===t.id).length}))});
      this.restoreListPosition();
    } catch (error) { this.failure(error, request); }
    finally { if (!this._unloaded && request === this._request) this.setData({ loading: false }); }
  },
  async openArticle(event) {
    if (this._unloaded || this.data.loading || !this.data.ready) return;
    const id = event.currentTarget.dataset.id;
    if (!this.data.articles.some(item => item.id === id)) return;
    const stamp = this._stamp, request = ++this._request;
    this.setData({ selected: null, loading: true, error: '' });
    try {
      if (!stamp || !this.current(stamp, request)) throw new Error('登录状态已变化，请刷新内容。');
      const result = await api('/articles/' + id);
      if (!this.current(stamp, request)) throw new Error('登录状态已变化，请刷新内容。');
      this.setData({ selected: result.article });
    } catch (error) { this.failure(error, request); }
    finally { if (!this._unloaded && request === this._request) this.setData({ loading: false }); }
  },
  failure(error, request) {
    if (this._unloaded || request !== this._request) return;
    this._stamp = null;
    this.setData({ articles: [], filtered: [], placements: {}, selected: null, ready: false, hasMore: false, loggedIn: hasSession(),
      error: error.status === 401 ? '登录已过期，可重新登录，或刷新查看公开内容。'
        : error.status === 404 ? '该内容已撤下或当前不可阅读，请刷新列表。' : error.message || '暂时无法读取，请重试。' });
  },
  closeArticle() { this.setData({ selected: null }); },
  officialCurrent(article,stamp,request) {
    return !!article && !article.document && !!article.originalUrl && this.data.ready && !this.data.loading && this.data.selected?.id===article.id && this.data.selected?.originalUrl===article.originalUrl && !!stamp && this.current(stamp,request);
  },
  readOfficial() {
    const article=this.data.selected,stamp=this._stamp,request=this._request;
    if(!this.officialCurrent(article,stamp,request))return;
    this.setData({officialError:false});
    openOfficialArticle({platform:wx,url:article.originalUrl,isCurrent:()=>this.officialCurrent(article,stamp,request),onFailure:()=>this.setData({officialError:true})});
  },
  copyOfficial() {
    const article=this.data.selected,stamp=this._stamp,request=this._request;
    if(!this.data.officialError||!this.officialCurrent(article,stamp,request))return;
    wx.showModal({title:'复制公众号原文链接',content:'复制后可在微信中粘贴打开该文章。',confirmText:'复制链接',success:r=>{if(r.confirm&&this.officialCurrent(article,stamp,request))wx.setClipboardData({data:article.originalUrl});}});
  },
  async readPdf(){
    if(this._pdfBusy||!this.data.selected?.document||!this._stamp)return;
    if(!this.data.selected.fullAccess && !this.data.selected.document.previewPages)return;
    const article=this.data.selected,stamp=this._stamp,request=this._request;
    this._pdfBusy=true;this.setData({downloading:true,error:''});
    let path;
    try{
      if(!this.current(stamp,request))throw new Error('登录状态已变化，请刷新。');
      path=await downloadArticle(article.id,!article.fullAccess);
      if(!this.current(stamp,request))throw new Error('页面或账号已变化，请重新打开报告。');
      this._pdfPath=path;
      await new Promise((resolve,reject)=>wx.openDocument({filePath:path,fileType:'pdf',showMenu:!!article.fullAccess,success:resolve,fail:()=>reject(new Error('文件打开失败，请重试。'))}));
      path=null; // Retain while the viewer is open; onShow removes it on return.
    }catch(error){if(this.current(stamp,request))this.setData({error:error.message});}
    finally{removeReportFile(path);this._pdfBusy=false;if(!this._unloaded)this.setData({downloading:false});}
  },
  openMembers(){wx.navigateTo({url:'/pages/members/index'});},
  openLogin() { wx.navigateTo({ url: '/pages/login/index' }); }
});
