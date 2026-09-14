const { api, loginLocal, loginWechat, captureReferral } = require('../../utils/api');

Page({
  data: {
    healthLoading: false, healthReady: false, wechatAvailable: false, localAvailable: false,
    localExpanded: false, register: false, username: '', password: '',
    navigationBusy: false, returnReady: false, consent: false, busy: false, busyMode: '', error: '', healthError: ''
  },
  onLoad(options) {
    this._planId = ['basic', 'star', 'organization'].includes(options.planId) ? options.planId : '';
    captureReferral(options);
    this.loadCapabilities();
  },
  onUnload() { this._unloaded = true; },
  async loadCapabilities() {
    if (this.data.healthLoading || this.data.busy) return;
    this.setData({ healthLoading: true, healthReady: false, healthError: '' });
    try {
      const health = await api('/health');
      const nativeAuth = health.nativeAuth || {};
      this.setData({ healthReady: true, wechatAvailable: nativeAuth.wechat === true, localAvailable: nativeAuth.localTrial === true });
    } catch (error) {
      this.setData({ wechatAvailable: false, localAvailable: false, healthError: error.message || '暂时连接不上测试服务，请重试。' });
    } finally { this.setData({ healthLoading: false }); }
  },
  changeField(event) {
    if (this.data.busy) return;
    const field = event.currentTarget.dataset.field;
    if (!['username', 'password'].includes(field)) return;
    this.setData({ [field]: event.detail.value, error: '' });
  },
  changeConsent(event) {
    if (!this.data.busy) this.setData({ consent: event.detail.value.includes('agree'), error: '' });
  },
  toggleLocal() {
    if (!this.data.busy && this.data.localAvailable) this.setData({ localExpanded: !this.data.localExpanded, error: '' });
  },
  toggleRegister() {
    if (!this.data.busy) this.setData({ register: !this.data.register, password: '', error: '' });
  },
  checkConsent() {
    if (this.data.consent) return true;
    this.setData({ error: '请先阅读并勾选下方内测资料保存说明。' });
    return false;
  },
  async useWechat() {
    if (this.data.busy || !this.data.wechatAvailable || !this.checkConsent()) return;
    this.setData({ busy: true, busyMode: 'wechat', error: '' });
    try {
      await loginWechat();
      this.setData({ password: '' });
      await this.finishLogin();
    } catch (error) {
      this.setData({ error: error.message || '微信登录未完成，你可以重试或使用已开放的内测账号。' });
    } finally { if (!this._unloaded) this.setData({ busy: false, busyMode: '' }); }
  },
  async submitLocal() {
    if (this.data.busy || !this.data.localAvailable || !this.checkConsent()) return;
    const username = this.data.username.trim();
    if (!/^[a-zA-Z0-9_]{4,32}$/.test(username)) {
      this.setData({ error: '账号须为 4–32 位字母、数字或下划线。' }); return;
    }
    if (this.data.password.length < 10 || this.data.password.length > 128) {
      this.setData({ error: '密码须为 10–128 位，请勿使用常用密码。' }); return;
    }
    this.setData({ busy: true, busyMode: 'local', error: '' });
    try {
      await loginLocal({ username, password: this.data.password, register: this.data.register });
      this.setData({ password: '' });
      await this.finishLogin();
    } catch (error) {
      this.setData({ error: error.message || '登录未完成，请检查账号后重试。' });
    } finally { if (!this._unloaded) this.setData({ busy: false, busyMode: '' }); }
  },
  finishLogin() {
    if(this._returning) return Promise.resolve(false);
    this._returning=true;this.setData({navigationBusy:true});
    return new Promise(resolve => {
      const success=()=>{this._returning=false;if(!this._unloaded)this.setData({navigationBusy:false});resolve(true);};
      const fail=()=>{this._returning=false;if(!this._unloaded)this.setData({navigationBusy:false,returnReady:true,error:'登录已成功，页面暂未打开。点击“继续办理”即可，无需重新登录。'});resolve(false);};
      if(this._planId) {wx.redirectTo({url:'/pages/join/index?planId='+this._planId,success,fail});return;}
      if(getCurrentPages().length>1)wx.navigateBack({delta:1,success,fail:()=>wx.switchTab({url:'/pages/account/index',success,fail})});
      else wx.switchTab({url:'/pages/account/index',success,fail});
    });
  }
});
