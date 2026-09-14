const { api, clearSession, hasSession, sessionStamp, isCurrentSession } = require('../../utils/api');
const { plans } = require('../../data/content');
const { memberJourney } = require('../../utils/member-journey');

function sessionExpired(error) {
  return error && (error.status === 401 || error.statusCode === 401);
}

Page({
  data: {
    loggedIn: false, user: null, membership: null, membershipLabel: '尚未开通会员',
    expiryLabel: '', unreadFeedback: 0, journey: null, journeyError: '', loading: false, busy: false, error: '', shareReady: false
  },
  onUnload() { this._unloaded = true; },
  onShow() { this._hidden = false; return this.refreshAccount(); },
  onHide() { this._hidden = true; this.clearAccount(); },
  async onPullDownRefresh() { try { await this.refreshAccount(); } finally { wx.stopPullDownRefresh(); } },
  clearAccount() {
    this._accountStamp = null;
    this.setData({ unreadFeedback: 0, journey: null, journeyError: '', loggedIn: false, user: null, membership: null, expiryLabel: '', membershipLabel: '尚未开通会员', shareReady: false });
  },
  async refreshAccount() {
    if (this._unloaded) return;
    if (this._accountStamp && !isCurrentSession(this._accountStamp)) this.clearAccount();
    if (this.data.loading || this.data.busy) return;
    if (!hasSession()) {
      this.clearAccount();
      this.setData({ error: '' });
      return;
    }
    this.clearAccount();
    this.setData({ loading: true, error: '', shareReady: false });
    const stamp = sessionStamp();
    try {
      const session = await api('/me');
      if (this._unloaded || this._hidden) return;
      if (!isCurrentSession(stamp)) throw new Error('账号已变化，请刷新后继续。');
      if (!session.user) {
        clearSession();
        this.setData({ loggedIn: false, user: null, membership: null, expiryLabel: '' });
        return;
      }
      const membership = session.membership || null;
      const plan = membership && plans.find(item => item.id === membership.planId);
      this._accountStamp = stamp;
      this.setData({
        loggedIn: true, user: session.user, membership,
        shareReady: session.user.role === 'member' && /^[A-Z0-9]{6}$/.test(session.user.referralCode || ''),
        membershipLabel: membership ? (membership.active ? (plan ? plan.name : '有效会员') : '会员已到期') : '尚未开通会员',
        expiryLabel: membership && membership.expiresAt ? new Date(membership.expiresAt).toLocaleDateString() : ''
      });
      try {
        const result = await api('/orders');
        if (this._unloaded || this._hidden) return;
        if (!isCurrentSession(stamp)) { this.clearAccount(); return; }
        this.setData({ journey: memberJourney(membership, result.orders) });
        const feedback=await api('/feedback/summary');
        if(this._unloaded || this._hidden)return;
        if(!isCurrentSession(stamp)){this.clearAccount();return;}
        this.setData({unreadFeedback:feedback.unreadCount || 0});
      } catch (error) {
        if (this._unloaded || this._hidden) return;
        if (!isCurrentSession(stamp)) { this.clearAccount(); return; }
        if (sessionExpired(error)) throw error;
        if(!this.data.journey) this.setData({ journeyError: '暂时无法读取申请进度，请下拉重试。' });
      }
    } catch (error) {
      if (this._unloaded) return;
      this.clearAccount();
      this.setData({ error: sessionExpired(error) ? '登录已过期，请重新登录。' : (error.message || '暂时无法读取账号，请重试。') });
    } finally { if (!this._unloaded) this.setData({ loading: false }); }
  },
  openJourney() {
    if (!this._accountStamp || !hasSession() || !isCurrentSession(this._accountStamp) || this.data.loading) { this.clearAccount(); return; }
    const item = this.data.journey; if (!item) return;
    if (item.kind === 'order') wx.navigateTo({ url: '/pages/orders/index?id=' + encodeURIComponent(item.id) });
    else if (item.kind === 'services') wx.switchTab({ url: '/pages/services/index' });
    else this.openMembers();
  },
  openLogin() { wx.navigateTo({ url: '/pages/login/index' }); },
  openOrders() { wx.navigateTo({ url: '/pages/orders/index' }); },
  openPosts() { wx.navigateTo({ url: '/pages/posts/index' }); },
  openInvite() { wx.navigateTo({ url: '/pages/invite/index' }); },
  openFeedback() { wx.navigateTo({ url: '/pages/feedback/index' }); },
  openMembers() { wx.navigateTo({ url: '/pages/members/index' }); },
  onShareAppMessage() {
    const user = this.data.user;
    const ready = hasSession() && this._accountStamp && isCurrentSession(this._accountStamp)
      && this.data.loggedIn && this.data.shareReady && !this.data.loading && !this.data.busy;
    const code = ready && user && user.role === 'member' && /^[A-Z0-9]{6}$/.test(user.referralCode || '') ? user.referralCode : '';
    return { title: '跨境企业家俱乐部 · 会员服务', path: '/pages/home/index' + (code ? '?ref=' + encodeURIComponent(code) : '') };
  },
  async logout() {
    if (this.data.busy || this.data.loading) return;
    if (!hasSession() || !this._accountStamp || !isCurrentSession(this._accountStamp)) {
      this.clearAccount();
      this.setData({ error: '登录状态已变化，请刷新账号后继续。' });
      return;
    }
    const stamp = this._accountStamp;
    this.setData({ busy: true, error: '' });
    try {
      await api('/native/auth/logout', {});
      if (!isCurrentSession(stamp)) throw new Error('登录状态已变化，请刷新账号后继续。');
      clearSession({ logout: true });
      if (!this._unloaded) this.clearAccount();
    } catch (error) {
      if (this._unloaded) return;
      if (sessionExpired(error)) {
        this.clearAccount();
      } else {
        if (!isCurrentSession(stamp)) this.clearAccount();
        this.setData({ error: error.message || '退出未完成，请重试。' });
      }
    } finally { if (!this._unloaded) this.setData({ busy: false }); }
  }
});
