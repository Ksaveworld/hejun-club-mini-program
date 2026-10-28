const { api, hasSession, sessionStamp, isCurrentSession, subscribeSession } = require('../../utils/api');

Page({
  data: { people: [], contacts: [], serviceTime: '', notice: '', loading: false, error: '' },
  onLoad() {
    this._sequence = 0;
    this._visible = false;
    this._unsubscribe = subscribeSession(() => {
      this.clearPrivate();
      if (this._visible) this.setData({ error: '登录状态已变化，请重新进入此页面。' });
    });
  },
  clearPrivate() {
    this._sequence++;
    clearTimeout(this._expiryTimer);
    this._expiryTimer = null;
    this._stamp = null;
    this._membershipExpiry = 0;
    this.setData({ contacts: [], serviceTime: '', notice: '', loading: false });
  },
  onShow() { this._visible = true; return this.loadContacts(); },
  onHide() { this._visible = false; this.clearPrivate(); },
  onUnload() { this._visible = false; this.clearPrivate(); if (this._unsubscribe) this._unsubscribe(); },
  async loadContacts() {
    this.clearPrivate();
    this.setData({ error: '' });
    const sequence = this._sequence, stamp = sessionStamp();
    this.setData({ loading: true });
    try {
      const publicResult=await api('/service-people');
      if (!this._visible || sequence !== this._sequence || !isCurrentSession(stamp)) return;
      if(!Array.isArray(publicResult.contacts)||publicResult.contacts.some(p=>typeof p.name!=='string'||typeof p.role!=='string'))throw new Error('人员介绍暂时无法读取。');
      this.setData({people:publicResult.contacts.map(({name,role})=>({name,role}))});
      if(!hasSession())return;
      let result;
      try {result=await api('/exclusive-contacts');} catch(error){if(error.status===403)return;throw error;}
      if (!this._visible || sequence !== this._sequence || !isCurrentSession(stamp)) return;
      const expires = Math.min(Date.parse(result.expiresAt), Date.parse(stamp.expiresAt));
      if (!Number.isFinite(expires) || expires <= Date.now()) throw new Error('会籍或登录已到期，请重新核对。');
      if (!Array.isArray(result.contacts) || result.contacts.length > 20
          || result.contacts.some(row => typeof row.name !== 'string' || typeof row.role !== 'string' || !/^1\d{10}$/.test(row.phone)))
        throw new Error('联系人暂时无法读取，请稍后重试。');
      this._stamp = stamp;
      this._membershipExpiry = expires;
      this.setData({ contacts: result.contacts, serviceTime: result.serviceTime, notice: result.notice });
      this._expiryTimer = setTimeout(() => { this.clearPrivate(); this.setData({ error: '会籍或登录已到期，请重新进入核对。' }); }, Math.min(expires - Date.now(), 2147483647));
    } catch (error) {
      if (this._visible && sequence === this._sequence) this.setData({ error: error.message || '暂时无法读取，请稍后重试。' });
    } finally {
      if (this._visible && sequence === this._sequence) this.setData({ loading: false });
    }
  },
  openMembership() {
    if (!this._visible || this.data.loading || this.data.contacts.length || this.data.error) return;
    wx.navigateTo({url:'/pages/members/index'});
  },
  async callContact(event) {
    const index = Number(event.currentTarget.dataset.index), stamp = this._stamp;
    if (!Number.isInteger(index) || !this._visible || !hasSession() || !isCurrentSession(stamp) || Date.now() >= this._membershipExpiry) {
      this.clearPrivate(); this.setData({ error: '请重新进入页面核对会籍。' }); return;
    }
    // Re-check server access before use, including refunds/revocation while the page was open.
    const sequence = this._sequence;
    try {
      const current = await api('/exclusive-contacts');
      if (!this._visible || sequence !== this._sequence || !isCurrentSession(stamp)) return;
      const contact = current.contacts && current.contacts[index];
      if (!contact || !/^1\d{10}$/.test(contact.phone)) throw new Error('联系人暂时无法读取。');
      wx.makePhoneCall({ phoneNumber: contact.phone, fail(error) {
        if (!/cancel/i.test(error.errMsg || '')) wx.showToast({ title: '未能拨打，请稍后重试', icon: 'none' });
      } });
    } catch (error) {
      if (this._visible && sequence === this._sequence) { this.clearPrivate(); this.setData({ error: error.message || '暂时无法读取，请重试。' }); }
    }
  }
});
