const { api, hasSession, sessionStamp, isCurrentSession, removeReportFile } = require('../../utils/api');
const { drawInvite } = require('../../utils/invite-art');
const { downloadInviteCode } = require('../../utils/invite-code');

Page({
  data: { loading: false, saving: false, ready: false, scanReady: false, code: '', cardPath: '', posterPath: '', error: '', message: '', albumDenied: false,
    showPrivacy: false, privacyRequestId: '', privacyContractName: '《小程序用户隐私保护指引》' },
  openAmbassador(){wx.navigateTo({url:'/pages/ambassador/index'});},
  onLoad() { this._generation = 0; this._saveSequence = 0; this._files = new Set(); },
  onShow() { this._shown = true; if (this._canvasReady) return this.refresh(); },
  onReady() { this._canvasReady = true; if (this._shown) return this.refresh(); },
  onHide() { this._shown = false; this.clear(); },
  onUnload() { this._unloaded = true; this._generation++; this._saveRequest = null; this.dropFiles(); },
  removeFile(path) { if(path && removeReportFile)removeReportFile(path); },
  dropFiles() { if(this._files){for(const path of this._files)this.removeFile(path);this._files.clear();} },
  clear() {
    this._generation++; this._stamp = null; this._owner = null; this._saveRequest = null;
    this.dropFiles();
    this.setData({ ready: false, scanReady: false, code: '', cardPath: '', posterPath: '', loading: false, saving: false, albumDenied: false,
      showPrivacy: false, privacyRequestId: '' });
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
  exportImage(kind, code, stamp, generation, qrPath) {
    return new Promise((resolve, reject) => {
      let done = false;
      const finish = (error, value) => { if (done) return; done = true; clearTimeout(timer); error ? reject(error) : resolve(value); };
      const timer = setTimeout(() => finish(new Error('图片生成超时，请重试。')), 12000);
      wx.createSelectorQuery().in(this).select('#invite-' + kind).fields({ node: true, size: true }).exec(result => {
        try {
          this.assertCurrent(stamp, generation);
          const canvas = result && result[0] && result[0].node;
          if (!canvas) throw new Error('画布尚未准备好，请重试。');
          const exportCanvas = image => {
            try {
              if(done)return;
              this.assertCurrent(stamp,generation);
              const size = drawInvite(canvas, kind, code, image);
              wx.canvasToTempFilePath({ canvas, width: size.width, height: size.height, destWidth: size.width, destHeight: size.height,
                fileType: 'png', success: value => {
                  if(done){this.removeFile(value.tempFilePath);return;}
                  try { this.assertCurrent(stamp, generation); if (!value.tempFilePath) throw new Error('图片生成未完成，请重试。');
                    this._files.add(value.tempFilePath);finish(null, value.tempFilePath); }
                  catch (error) { this.removeFile(value.tempFilePath);finish(error); }
                }, fail: () => finish(new Error('暂时无法生成图片，请重试。')) }, this);
            }catch(error){finish(error);}
          };
          if(kind==='poster'&&qrPath){
            if(typeof canvas.createImage!=='function')throw new Error('当前微信版本不能生成扫码海报，请更新后重试。');
            const image=canvas.createImage();image.onload=()=>exportCanvas(image);
            image.onerror=()=>finish(new Error('扫码图片未能载入，请重试。'));image.src=qrPath;
          }else exportCanvas();
        } catch (error) { finish(error); }
      });
    });
  },
  async refresh() {
    if (this._unloaded || !this._shown || !this._canvasReady || this.data.saving || this.data.showPrivacy) return;
    this.clear(); this.setData({ error: '', message: '' });
    if (!hasSession()) { this.setData({ error: '请先登录会员账号。' }); return; }
    const stamp = sessionStamp(), generation = this._generation;
    this.setData({ loading: true });
    try {
      const user = await this.identity(stamp, generation);
      const cardPath = await this.exportImage('card', user.referralCode, stamp, generation);
      let qrPath,scanError='';
      try {
        qrPath=await downloadInviteCode(user.referralCode,stamp,()=>this.current(stamp,generation));
        if(!this.current(stamp,generation)){this.removeFile(qrPath);this.assertCurrent(stamp,generation);}
        this._files.add(qrPath);
      }catch(error){this.assertCurrent(stamp,generation);scanError=error.message||'邀请扫码图片暂未生成，可先分享小程序卡片。';}
      const posterPath = await this.exportImage('poster', user.referralCode, stamp, generation, qrPath);
      this.assertCurrent(stamp, generation); this._stamp = stamp; this._owner = user.id;
      this.setData({ ready: true, scanReady:!!qrPath, code: user.referralCode, cardPath, posterPath,
        message:scanError?'扫码入口暂未生成，你仍可分享小程序卡片。 '+scanError:'' });
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
    if (this.data.saving || this.data.loading || this.data.showPrivacy || !this.data.ready || this._unloaded || !this._shown) return;
    const request = { stamp: this._stamp, generation: this._generation, path: this.data.posterPath,
      owner: this._owner, code: this.data.code, id: 'invite-' + this._generation + '-' + (++this._saveSequence) };
    this._saveRequest = request;
    this.setData({ saving: true, error: '', message: '', albumDenied: false });
    try {
      this.assertCurrent(request.stamp, request.generation);
      if (wx.getPrivacySetting) {
        const privacy = await new Promise((resolve, reject) => wx.getPrivacySetting({ success: resolve, fail: reject }));
        this.assertCurrent(request.stamp, request.generation);
        if (this._saveRequest !== request) return;
        if (typeof privacy.needAuthorization !== 'boolean') throw new Error('Invalid privacy status');
        if (privacy.needAuthorization) {
          this.setData({ saving: false, showPrivacy: true, privacyRequestId: request.id,
            privacyContractName: privacy.privacyContractName || '《小程序用户隐私保护指引》' });
          return;
        }
      }
    } catch (error) {
      this.saveFailure(request, error, true); return;
    }
    return this.saveAuthorizedPoster(request);
  },
  // Only the official agreePrivacyAuthorization button event continues saving.
  agreePosterPrivacy(event) {
    const request = this._saveRequest;
    if (!this.data.showPrivacy || this.data.saving || !request || event?.currentTarget?.dataset?.privacyRequest !== request.id) return;
    if (!this.current(request.stamp, request.generation)) {
      this.saveFailure(request, new Error('登录状态已变化，请重新生成邀请图片。')); return;
    }
    this.setData({ showPrivacy: false, privacyRequestId: '', saving: true, error: '' });
    return this.saveAuthorizedPoster(request);
  },
  cancelPosterPrivacy() {
    const request = this._saveRequest;
    if (!this.data.showPrivacy || !request || this._unloaded || !this._shown) return;
    if (!this.current(request.stamp, request.generation)) {
      this.saveFailure(request, new Error('登录状态已变化，请重新生成邀请图片。')); return;
    }
    this._saveRequest = null;
    this.setData({ showPrivacy: false, privacyRequestId: '', saving: false,
      error: '未授权保存介绍图片。你仍可分享小程序卡片，需要保存时可再点击。' });
  },
  openPosterPrivacy() {
    const request = this._saveRequest;
    if (this.data.showPrivacy && request && this.current(request.stamp, request.generation) && wx.openPrivacyContract) {
      wx.openPrivacyContract({ fail: () => {
        if (this._saveRequest === request && this.data.showPrivacy && this.current(request.stamp, request.generation))
          this.setData({ error: '微信隐私指引暂未打开，请稍后重试' });
      } });
    }
  },
  async saveAuthorizedPoster(request) {
    if (this._saveRequest !== request) return;
    try {
      const user = await this.identity(request.stamp, request.generation);
      if (this._saveRequest !== request) return;
      if (user.id !== request.owner || user.referralCode !== request.code) throw new Error('推荐信息已变化，请重新生成图片。');
      await new Promise((resolve, reject) => wx.saveImageToPhotosAlbum({ filePath: request.path, success: resolve, fail: reject }));
      this.assertCurrent(request.stamp, request.generation);
      if (this._saveRequest === request) this.setData({ message: this.data.scanReady?'邀请海报已保存。扫码可进入所配置的小程序版本，请确认该版本已开放。'
        :'介绍图片已保存。请配合小程序卡片分享，朋友才能直接进入。' });
    } catch (error) { this.saveFailure(request, error); }
    finally {
      if (this._saveRequest === request && !this._unloaded && this._shown && request.generation === this._generation) {
        this._saveRequest = null; this.setData({ saving: false });
      }
    }
  },
  saveFailure(request, error, privacyLookup = false) {
    if (this._saveRequest !== request || this._unloaded || !this._shown || request.generation !== this._generation) return;
    if (!this.current(request.stamp, request.generation) || (!privacyLookup && !error.errMsg)) {
      this.clear(); this.setData({ error: error.message || '请重新生成邀请图片。' }); return;
    }
    const denied = !privacyLookup && /auth deny|auth denied|authorize|permission/i.test(error.errMsg || '');
    this._saveRequest = null;
    this.setData({ saving: false, showPrivacy: false, privacyRequestId: '', albumDenied: denied,
      error: privacyLookup ? '未能读取微信隐私授权状态，请稍后重新点击保存介绍图片。'
        : denied ? '未获得相册权限。你仍可分享小程序卡片，也可在设置中允许保存图片。' : '图片未保存，可稍后重试。' });
  },
  openSettings() { wx.openSetting({}); },
  openLogin() { wx.navigateTo({ url: '/pages/login/index' }); }
});
