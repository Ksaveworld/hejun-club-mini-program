const { api, hasSession, sessionStamp, isCurrentSession } = require('../../utils/api');
const { drawInvite } = require('../../utils/invite-art');

Page({
  data: { loading: false, saving: false, ready: false, code: '', cardPath: '', posterPath: '', error: '', message: '', albumDenied: false },
  openAmbassador(){wx.navigateTo({url:'/pages/ambassador/index'});},
  onLoad() { this._generation = 0; },
  onShow() { this._shown = true; if (this._canvasReady) return this.refresh(); },
  onReady() { this._canvasReady = true; if (this._shown) return this.refresh(); },
  onHide() { this._shown = false; this.clear(); },
  onUnload() { this._unloaded = true; this._generation++; },
  clear() {
    this._generation++; this._stamp = null; this._owner = null;
    this.setData({ ready: false, code: '', cardPath: '', posterPath: '', loading: false, saving: false, albumDenied: false });
  },
  current(stamp, generation) {
    return !this._unloaded && this._shown && hasSession() && generation === this._generation && isCurrentSession(stamp);
  },
  assertCurrent(stamp, generation) {
    if (!this.current(stamp, generation)) throw new Error('登录状态已变化，请重新生成邀请图片。');
  },
  async identity(stamp, generation) {
    const result = await api('/me'); this.assertCurrent(stamp, generation);
    const user = result.user;
    if (!user || user.role !== 'member' || !/^[A-Z0-9]{6}$/.test(user.referralCode || '')) throw new Error('请使用会员账号登录后生成邀请图片。');
    return user;
  },
  exportImage(kind, code, stamp, generation) {
    return new Promise((resolve, reject) => {
      let done = false;
      const finish = (error, value) => { if (done) return; done = true; clearTimeout(timer); error ? reject(error) : resolve(value); };
      const timer = setTimeout(() => finish(new Error('图片生成超时，请重试。')), 12000);
      wx.createSelectorQuery().in(this).select('#invite-' + kind).fields({ node: true, size: true }).exec(result => {
        try {
          this.assertCurrent(stamp, generation);
          const canvas = result && result[0] && result[0].node;
          if (!canvas) throw new Error('画布尚未准备好，请重试。');
          const size = drawInvite(canvas, kind, code);
          wx.canvasToTempFilePath({ canvas, width: size.width, height: size.height, destWidth: size.width, destHeight: size.height,
            fileType: 'png', success: value => {
              try { this.assertCurrent(stamp, generation); if (!value.tempFilePath) throw new Error('图片生成未完成，请重试。'); finish(null, value.tempFilePath); }
              catch (error) { finish(error); }
            }, fail: () => finish(new Error('暂时无法生成图片，请重试。')) }, this);
        } catch (error) { finish(error); }
      });
    });
  },
  async refresh() {
    if (this._unloaded || !this._shown || !this._canvasReady || this.data.saving) return;
    this.clear(); this.setData({ error: '', message: '' });
    if (!hasSession()) { this.setData({ error: '请先登录会员账号。' }); return; }
    const stamp = sessionStamp(), generation = this._generation;
    this.setData({ loading: true });
    try {
      const user = await this.identity(stamp, generation);
      const cardPath = await this.exportImage('card', user.referralCode, stamp, generation);
      const posterPath = await this.exportImage('poster', user.referralCode, stamp, generation);
      this.assertCurrent(stamp, generation); this._stamp = stamp; this._owner = user.id;
      this.setData({ ready: true, code: user.referralCode, cardPath, posterPath });
    } catch (error) {
      if (!this._unloaded && this._shown && generation === this._generation) { this.clear(); this.setData({ error: error.message || '图片生成失败，请重试。' }); }
    } finally { if (!this._unloaded && generation === this._generation) this.setData({ loading: false }); }
  },
  onShareAppMessage() {
    const valid = this.data.ready && !this.data.loading && this._stamp && this.current(this._stamp, this._generation);
    return valid ? { title: '跨境企业家俱乐部 · 会员服务', path: '/pages/home/index?ref=' + this.data.code, imageUrl: this.data.cardPath }
      : { title: '跨境企业家俱乐部 · 会员服务', path: '/pages/home/index' };
  },
  async savePoster() {
    if (this.data.saving || this.data.loading || !this.data.ready) return;
    const stamp = this._stamp, generation = this._generation, path = this.data.posterPath;
    this.setData({ saving: true, error: '', message: '', albumDenied: false });
    try {
      this.assertCurrent(stamp, generation);
      const user = await this.identity(stamp, generation);
      if (user.id !== this._owner || user.referralCode !== this.data.code) throw new Error('推荐信息已变化，请重新生成图片。');
      await new Promise((resolve, reject) => wx.saveImageToPhotosAlbum({ filePath: path, success: resolve, fail: reject }));
      this.assertCurrent(stamp, generation); this.setData({ message: '介绍图片已保存。请配合小程序卡片分享，朋友才能直接进入。' });
    } catch (error) {
      if (this._unloaded || !this._shown || generation !== this._generation) return;
      if (!this.current(stamp, generation) || !error.errMsg) { this.clear(); this.setData({ error: error.message || '请重新生成邀请图片。' }); }
      else {
        const denied = /auth deny|auth denied|authorize|permission/i.test(error.errMsg || '');
        this.setData({ albumDenied: denied, error: denied ? '未获得相册权限。你仍可分享小程序卡片，也可在设置中允许保存图片。' : '图片未保存，可稍后重试。' });
      }
    } finally { if (!this._unloaded && generation === this._generation) this.setData({ saving: false }); }
  },
  openSettings() { wx.openSetting({}); },
  openLogin() { wx.navigateTo({ url: '/pages/login/index' }); }
});
