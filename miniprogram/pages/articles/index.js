const { returnToPrevious } = require('../../utils/navigation');
const { api, hasSession, sessionStamp, isCurrentSession,downloadArticle,removeReportFile } = require('../../utils/api');

Page({
  onPageScroll(event) { if(!this.data.loading && !this._restoringScroll) this._scrollTop=event.scrollTop; },
  restoreListPosition() { if(!this.data.detailId && wx.nextTick && this._scrollTop) { this._restoringScroll=true;wx.nextTick(()=>{ if(!this._unloaded)wx.pageScrollTo({scrollTop:this._scrollTop,duration:0});this._restoringScroll=false; }); } },
  data: { loading: false, ready: false, loggedIn: false, articles: [], filtered: [],
    detailId: '', query: '', category: 'all', selected: null, error: '', hasMore: false },
  onLoad(options = {}) { this._request = 0; this.setData({ detailId: options.id || '', category: ['news','knowledge'].includes(options.category) ? options.category : 'all' }); },
  async onPullDownRefresh() { try { await this.refresh(); } finally { wx.stopPullDownRefresh(); } },
  navigateArticle(event) {
    if (!this.data.ready || this.data.loading || !this._stamp || !this.current(this._stamp, this._request)) return;
    const id = event.currentTarget.dataset.id;
    if (this.data.articles.some(item => item.id === id)) wx.navigateTo({url:'/pages/articles/index?id='+encodeURIComponent(id)});
  },
  backToList() { returnToPrevious(this,'/pages/articles/index'); },
  onShow() { if(this._pdfPath)removeReportFile(this._pdfPath);this._pdfPath=null;return this.refresh(); },
  onHide() { this.invalidate(); },
  onUnload() { this._unloaded = true; this._request++; },
  invalidate() {
    this._request++; this._stamp = null;
    this.setData({ articles: [], filtered: [], selected: null, ready: false, loading: false, hasMore: false });
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
      (this.data.category === 'all' || item.category === this.data.category)
      && (item.title + ' ' + item.summary).toLowerCase().includes(keyword)) });
  },
  search(event) { this.setData({ query: event.detail.value }); this.filter(); },
  chooseCategory(event) {
    const category = event.currentTarget.dataset.category;
    if (!['all', 'news', 'knowledge'].includes(category)) return;
    this.setData({ category }); this.filter();
  },
  resetFilters() { this.setData({ query: '', category: 'all' }); this.filter(); },
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
      const result = await api('/articles');
      if (!this.current(stamp, request)) throw Object.assign(new Error('登录状态已变化，请刷新内容。'), { code: 'CONTEXT_CHANGED' });
      this._stamp = stamp;
      this.setData({ articles: result.articles, hasMore: result.hasMore, ready: true });
      this.filter();
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
    this.setData({ articles: [], filtered: [], selected: null, ready: false, hasMore: false, loggedIn: hasSession(),
      error: error.status === 401 ? '登录已过期，可重新登录，或刷新查看公开内容。'
        : error.status === 404 ? '该内容已撤下或当前不可阅读，请刷新列表。' : error.message || '暂时无法读取，请重试。' });
  },
  closeArticle() { this.setData({ selected: null }); },
  async readPdf(){
    if(this._pdfBusy||!this.data.selected?.document||!this._stamp)return;
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
