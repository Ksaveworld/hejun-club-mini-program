const categories = require('../../data/service-directory');
const { api, hasSession, sessionStamp, isCurrentSession, subscribeSession } = require('../../utils/api');
const { readDirectory, searchDirectory } = require('../../utils/directory');
const { isOfficialArticleUrl, openOfficialArticle } = require('../../utils/official-article');

Page({
  openProfessionalMaterials(){wx.navigateTo({url:'/pages/articles/index?section=professional'});},
  data: { categories, filtered: categories, selected: null, tab: 'services', query: '',
    entries: [], companyFiltered: [], companyQuery: '', directoryState: 'idle', directoryError: '',
    articleFailureId: '', articleFailureMessage: '' },
  onLoad(query = {}) {
    this._generation = 0; this._articleAttempt = 0; this._visible = false;
    this.setData({ selected: query.id ? categories.find(category => category.id === query.id) || null : null });
  },
  onShow() {
    if (this._unloaded) return;
    this._visible = true;
    if (!this._unsubscribe) this._unsubscribe = subscribeSession(() => {
      if (this._visible && !this._unloaded) this.clearForSessionChange();
    });
    if (this.data.tab === 'companies' && !this.data.selected) return this.refreshDirectory();
  },
  onHide() { this._visible = false; this.stopWatching(); this.clearDirectory(); },
  onUnload() {
    this._visible = false; this.stopWatching(); this.clearDirectory(); this._unloaded = true;
  },
  stopWatching() {
    if (this._unsubscribe) this._unsubscribe(); this._unsubscribe = null;
    if (this._sessionTimer) clearTimeout(this._sessionTimer); this._sessionTimer = null;
  },
  clearDirectory(state = 'idle', error = '') {
    this._generation = (this._generation || 0) + 1; this._articleAttempt = (this._articleAttempt || 0) + 1;
    this._stamp = null;
    if (this._sessionTimer) clearTimeout(this._sessionTimer); this._sessionTimer = null;
    if (!this._unloaded) this.setData({ entries: [], companyFiltered: [], companyQuery: '',
      directoryState: state, directoryError: error, articleFailureId: '', articleFailureMessage: '' });
  },
  clearForSessionChange() {
    const loggedIn = hasSession(), stamp = sessionStamp();
    this.clearDirectory(!loggedIn ? 'guest' : stamp.authMode === 'review' ? 'review' : 'changed',
      loggedIn ? '登录状态已变化，请重新读取名录。' : '登录已过期或已退出，请重新登录。');
  },
  current(stamp, generation) {
    if (this._unloaded || !this._visible || this.data.tab !== 'companies' || this._generation !== generation || !stamp) return false;
    if (!hasSession() || !isCurrentSession(stamp) || this._generation !== generation) return false;
    const now = sessionStamp();
    return now.authMode !== 'review' && now.authMode === stamp.authMode && now.ownerId === stamp.ownerId && now.expiresAt === stamp.expiresAt;
  },
  ensureCurrent() {
    if (this.current(this._stamp, this._generation)) return true;
    if (!this._unloaded && this._visible) this.clearForSessionChange();
    return false;
  },
  watchSession(stamp, generation) {
    // Login/logout emits session notifications. The visible-page check also
    // clears expiry or runtime environment changes without waiting for a tap.
    const remaining = Date.parse(stamp.expiresAt) - Date.now();
    this._sessionTimer = setTimeout(() => {
      this._sessionTimer = null;
      if (this._unloaded || !this._visible || generation !== this._generation) return;
      if (!this.current(stamp, generation)) {
        if (generation === this._generation) this.clearForSessionChange();
        return;
      }
      this.watchSession(stamp, generation);
    }, Math.max(1, Math.min(1000, remaining)));
  },
  async refreshDirectory() {
    if (this._unloaded || !this._visible || this.data.selected || this.data.tab !== 'companies') return;
    this.clearDirectory();
    const loggedIn = hasSession(), stamp = sessionStamp(), generation = this._generation;
    if (!loggedIn) { this.setData({ directoryState: 'guest' }); return; }
    if (stamp.authMode === 'review') { this.setData({ directoryState: 'review' }); return; }
    this.setData({ directoryState: 'loading' });
    try {
      const result = await api('/directory');
      if (this._unloaded || !this._visible || generation !== this._generation) return;
      if (!this.current(stamp, generation)) { this.clearForSessionChange(); return; }
      const directory = readDirectory(result);
      this._stamp = stamp;
      this.setData({ entries: directory.entries, companyFiltered: directory.entries,
        directoryState: !directory.configured ? 'unconfigured' : directory.entries.length ? 'ready' : 'empty' });
      this.watchSession(stamp, generation);
    } catch (error) {
      if (this._unloaded || !this._visible || generation !== this._generation) return;
      if (!this.current(stamp, generation)) { this.clearForSessionChange(); return; }
      this.clearDirectory(error.status === 404 ? 'unconfigured' : 'error', error.status === 404 ? ''
        : error.status === 403 ? '当前账号暂不可查看会员企业名录。' : error.message || '名录暂时无法读取，请稍后重试。');
    }
  },
  async onPullDownRefresh() { try { await this.refreshDirectory(); } finally { wx.stopPullDownRefresh(); } },
  searchCompanies(event) {
    if (!this.ensureCurrent()) return;
    const companyQuery = event.detail.value;
    this.setData({ companyQuery, companyFiltered: searchDirectory(this.data.entries, companyQuery) });
  },
  clearCompanySearch() { this.searchCompanies({ detail: { value: '' } }); },
  articleCurrent(ticket) {
    if (!this.current(ticket.stamp, ticket.generation) || ticket.attempt !== this._articleAttempt || this.data.directoryState !== 'ready') return false;
    return this.data.entries.some(entry => entry.id === ticket.id && entry.revision === ticket.revision
      && entry.articleUrl === ticket.url && isOfficialArticleUrl(entry.articleUrl));
  },
  openCompanyArticle(event) {
    if (this.data.directoryState !== 'ready' || !this.ensureCurrent()) return;
    const entry = this.data.entries.find(item => item.id === event.currentTarget.dataset.id);
    if (!entry || !isOfficialArticleUrl(entry.articleUrl)) return;
    const ticket = { stamp: this._stamp, generation: this._generation, attempt: ++this._articleAttempt,
      id: entry.id, revision: entry.revision, url: entry.articleUrl };
    this.setData({ articleFailureId: '', articleFailureMessage: '' });
    openOfficialArticle({ platform: wx, url: ticket.url, isCurrent: () => this.articleCurrent(ticket),
      onFailure: reason => this.setData({ articleFailureId: entry.id, articleFailureMessage: reason === 'unsupported'
        ? '当前微信不支持直接打开公众号文章，请更新微信，或点击下方复制链接。'
        : '公众号文章未能打开，可再次点击重试，或点击下方复制链接。' }) });
  },
  copyCompanyArticle(event) {
    if (!this.ensureCurrent() || this.data.directoryState !== 'ready') return;
    const entry = this.data.entries.find(item => item.id === event.currentTarget.dataset.id);
    if (!entry || entry.id !== this.data.articleFailureId || !isOfficialArticleUrl(entry.articleUrl)) return;
    const ticket = { stamp: this._stamp, generation: this._generation, attempt: this._articleAttempt,
      id: entry.id, revision: entry.revision, url: entry.articleUrl };
    wx.showModal({ title: '复制公众号文章链接', content: '复制后可在微信中粘贴打开该文章。', confirmText: '复制链接',
      success: decision => {
        if (!decision.confirm || !this.articleCurrent(ticket)) return;
        wx.setClipboardData({ data: ticket.url,
          fail: () => { if (this.articleCurrent(ticket)) this.setData({ articleFailureMessage: '链接复制未完成，请再次点击复制链接。' }); } });
      } });
  },
  onShareAppMessage() {
    const category = this.data.selected;
    return category ? { title: category.title || category.name || '跨境专业服务', path: '/pages/directory/index?id=' + encodeURIComponent(category.id) }
      : { title: '跨境企业家俱乐部 · 专业服务', path: '/pages/directory/index' };
  },
  openCategory(event) {
    const id = event.currentTarget.dataset.id;
    if (categories.some(category => category.id === id)) wx.navigateTo({ url: '/pages/directory/index?id=' + encodeURIComponent(id) });
  },
  search(event) { const query = event.detail.value; this.setData({ query, filtered: categories.filter(category => (category.title + category.modules.join('')).includes(query.trim())) }); },
  clearSearch() { this.search({ detail: { value: '' } }); },
  changeTab(event) {
    const tab = event.currentTarget.dataset.tab;
    if (!['services', 'partners'].includes(tab)) return;
    this.setData({ tab });
    this.clearDirectory();
  },
  jumpModule(event) { const id = event.currentTarget.dataset.id; if (this.data.selected?.details.some(item => item.id === id)) wx.pageScrollTo({ selector: '#module-' + id, duration: 300 }); },
  openPartnerApplication() { wx.navigateTo({ url: '/pages/applications/index?kind=partner' }); },
  openHelp() { wx.navigateTo({ url: '/pages/help/index' }); },
  openLogin() { wx.navigateTo({ url: '/pages/login/index' }); },
  back() { wx.navigateBack({ fail: () => wx.redirectTo({ url: '/pages/directory/index' }) }); }
});
