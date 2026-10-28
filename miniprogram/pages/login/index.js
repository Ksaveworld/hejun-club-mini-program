const { api, loginLocal, loginWechat, captureReferral } = require('../../utils/api');
const {loadLegal,legalConsent}=require('../../utils/legal');
const {openPublicDocument,showPublicDocuments,hidePublicDocuments,clearPublicDocuments}=require('../../utils/public-documents');
const {reviewAvailable,loginReview}=require('../../utils/review-access');

Page({
  data: {
    healthLoading: false, healthReady: false, wechatAvailable: false, localAvailable: false, legacyAvailable:false,
    reviewAvailable:false,reviewExpanded:false,reviewUsername:'',reviewPassword:'',reviewNotice:'',
    transferAvailable:false,transferCode:'',localExpanded: false, register: false, username: '', password: '',referral:'',legacyExpanded:false,
    legal:null,legalReady:false,policy:false,hongKong:false,
    navigationBusy: false, returnReady: false, consent: false, busy: false, busyMode: '', error: '', healthError: ''
  },
  onLoad(options) {
    this._planId = ['basic', 'star', 'organization'].includes(options.planId) ? options.planId : '';
    captureReferral(options);
    this.loadCapabilities();
  },
  onShow(){this._hidden=false;showPublicDocuments(this);},
  onHide(){this._hidden=true;this._reviewRequest=(this._reviewRequest||0)+1;hidePublicDocuments(this);this.setData({reviewPassword:'',...(this.data.busyMode==='review'?{busy:false,busyMode:''}:{})});},
  onUnload() { this._unloaded = true;this._reviewRequest=(this._reviewRequest||0)+1;clearPublicDocuments(this); },
  async loadCapabilities() {
    if (this._unloaded || this.data.healthLoading || this.data.busy) return;
    this.setData({ healthLoading: true, healthReady: false, healthError: '',legalReady:false,policy:false,hongKong:false });
    try {
      const [health,legal] = await Promise.all([api('/health'),loadLegal()]);
      if(this._unloaded)return;
      const nativeAuth = health.nativeAuth || {};
      const review=reviewAvailable(health);
      this.setData({transferAvailable:health.nativeTransfer===true,legacyAvailable:nativeAuth.wechat===true&&nativeAuth.legacyBinding!==false,legal,legalReady:true, healthReady: true, wechatAvailable: nativeAuth.wechat === true, localAvailable: nativeAuth.localTrial === true,
        reviewAvailable:review,reviewExpanded:review&&this.data.reviewExpanded,reviewPassword:'',reviewNotice:review?'审核只读体验：可阅读获准会员内容和服务说明。申请、投稿、付款、推荐、提现及通知演示尚未开放，不能代表全功能审核已完成。':'' });
    } catch (error) {
      if (!this._unloaded) this.setData({ wechatAvailable: false, localAvailable: false, legacyAvailable:false,reviewAvailable:false,reviewExpanded:false,reviewPassword:'',reviewNotice:'', healthError: error.message || '暂时连接不上数据服务，请重试。' });
    } finally { if (!this._unloaded) this.setData({ healthLoading: false }); }
  },
  changeField(event) {
    if (this.data.busy) return;
    const field = event.currentTarget.dataset.field;
    if (!['username', 'password','transferCode','referral','reviewUsername','reviewPassword'].includes(field)) return;
    this.setData({ [field]: field==='referral'?event.detail.value.toUpperCase():event.detail.value, error: '' });
  },
  changeConsent(event) {
    if (!this.data.busy) this.setData({ consent: event.detail.value.includes('agree'), error: '' });
  },
  agreeLegal(event){if(!this.data.busy && ['policy','hongKong'].includes(event.currentTarget.dataset.id))this.setData({[event.currentTarget.dataset.id]:event.detail.value.length>0,error:''});},
  async openLegal(event){try{await openPublicDocument('/legal/'+event.currentTarget.dataset.id+'/document','pdf',this);}catch(error){if(!this._unloaded)this.setData({error:error.message});}},
  toggleLocal() {
    if (!this.data.busy && this.data.localAvailable) this.setData({ localExpanded: !this.data.localExpanded, error: '' });
  },
  toggleRegister() {
    if (!this.data.busy) this.setData({ register: !this.data.register, password: '', error: '' });
  },
  toggleLegacy(){if(!this.data.busy&&this.data.legacyAvailable)this.setData({legacyExpanded:!this.data.legacyExpanded,password:'',error:''});},
  toggleReview(){if(!this.data.busy&&this.data.reviewAvailable)this.setData({reviewExpanded:!this.data.reviewExpanded,reviewPassword:'',error:''});},
  async submitReview(){
    if(this._unloaded||this._hidden||this.data.busy||!this.data.reviewAvailable||!this.checkConsent())return;
    const username=this.data.reviewUsername.trim(),password=this.data.reviewPassword;
    if(!['review_basic_110','review_star_110'].includes(username.toLowerCase())||password.length<10||password.length>128){this.setData({reviewPassword:'',error:'请填写已提供的审核账号及10–128位独立测试密码。'});return;}
    const request=this._reviewRequest=(this._reviewRequest||0)+1;
    const current=()=>!this._unloaded&&!this._hidden&&this._reviewRequest===request&&this.data.reviewAvailable;
    this.setData({busy:true,busyMode:'review',error:''});
    try{
      await loginReview({username,password,legalConsent:legalConsent(this.data)},current);
      if(!current())return;this._reviewReturning=true;this.setData({reviewPassword:''});await this.finishLogin();
    }catch(error){if(current())this.setData({reviewPassword:'',error:error.message||'审核登录未完成，请检查账号后重试。'});}
    finally{if(current())this.setData({busy:false,busyMode:''});}
  },
  async bindExisting(){
    if(this.data.busy || !this.data.wechatAvailable || !this.data.legacyAvailable || !this.checkConsent())return;
    this._reviewReturning=false;
    const username=this.data.username.trim(),password=this.data.password;
    if(!/^[a-zA-Z0-9_]{4,32}$/.test(username)||password.length<10||password.length>128){this.setData({error:'请填写原网页会员账号及10–128位密码'});return;}
    this.setData({busy:true,busyMode:'legacy',error:''});
    try{await loginWechat(legalConsent(this.data),{username,password});if(this._unloaded)return;this.setData({password:''});await this.finishLogin();}
    catch(error){if(!this._unloaded)this.setData({password:'',error:error.message});}
    finally{if(!this._unloaded)this.setData({busy:false,busyMode:''});}
  },
  async bindTransfer(){
    if(this.data.busy||!this.data.transferAvailable||!this.checkConsent())return;
    this._reviewReturning=false;
    const code=this.data.transferCode.trim();
    if(!/^[a-f0-9-]{36}\.[A-Za-z0-9_-]{32}$/.test(code)){this.setData({error:'请粘贴从原网页获取的完整接续码'});return;}
    this.setData({busy:true,busyMode:'transfer',error:''});
    try{await loginWechat(legalConsent(this.data),undefined,code);if(this._unloaded)return;this.setData({transferCode:''});await this.finishLogin();}
    catch(error){if(!this._unloaded)this.setData({error:error.message});}
    finally{if(!this._unloaded)this.setData({busy:false,busyMode:''});}
  },
  checkConsent() {
    try {legalConsent(this.data);}catch(error){this.setData({error:error.message});return false;}
    if (this.data.legal || this.data.consent) return true;
    this.setData({ error: '请先阅读并勾选下方内测资料保存说明。' });
    return false;
  },
  async useWechat() {
    if (this.data.busy || !this.data.wechatAvailable || !this.checkConsent()) return;
    this._reviewReturning=false;
    this.setData({ busy: true, busyMode: 'wechat', error: '' });
    try {
      await loginWechat(legalConsent(this.data));
      if (this._unloaded) return;
      this.setData({ password: '' });
      await this.finishLogin();
    } catch (error) {
      if (!this._unloaded) this.setData({ error: error.message || '微信登录未完成，你可以重试或使用已开放的内测账号。' });
    } finally { if (!this._unloaded) this.setData({ busy: false, busyMode: '' }); }
  },
  async submitLocal() {
    if (this.data.busy || !this.data.localAvailable || !this.checkConsent()) return;
    this._reviewReturning=false;
    const username = this.data.username.trim();
    if (!/^[a-zA-Z0-9_]{4,32}$/.test(username)) {
      this.setData({ error: '账号须为 4–32 位字母、数字或下划线。' }); return;
    }
    if (this.data.password.length < 10 || this.data.password.length > 128) {
      this.setData({ error: '密码须为 10–128 位，请勿使用常用密码。' }); return;
    }
    const referral=this.data.register?this.data.referral.trim().toUpperCase():'';
    if(referral&&!/^[A-Z0-9]{6}$/.test(referral)){this.setData({error:'推荐码须为6位字母或数字，也可以留空。'});return;}
    this.setData({ busy: true, busyMode: 'local', error: '' });
    try {
      await loginLocal({ username, password: this.data.password, register: this.data.register,referral,legalConsent:legalConsent(this.data) });
      if (this._unloaded) return;
      this.setData({ password: '' });
      await this.finishLogin();
    } catch (error) {
      if (!this._unloaded) this.setData({ error: error.message || '登录未完成，请检查账号后重试。' });
    } finally { if (!this._unloaded) this.setData({ busy: false, busyMode: '' }); }
  },
  finishLogin() {
    if(this._unloaded || this._returning) return Promise.resolve(false);
    this._returning=true;this.setData({navigationBusy:true});
    return new Promise(resolve => {
      const success=()=>{this._returning=false;if(!this._unloaded)this.setData({navigationBusy:false});resolve(true);};
      const fail=()=>{this._returning=false;if(!this._unloaded)this.setData({navigationBusy:false,returnReady:true,error:'登录已成功，页面暂未打开。点击“继续办理”即可，无需重新登录。'});resolve(false);};
      if(this._reviewReturning){wx.redirectTo({url:'/pages/articles/index',success,fail});return;}
      if(this._planId) {wx.redirectTo({url:'/pages/join/index?planId='+this._planId,success,fail});return;}
      if(getCurrentPages().length>1)wx.navigateBack({delta:1,success,fail:()=>{if(this._unloaded){fail();return;}wx.switchTab({url:'/pages/account/index',success,fail});}});
      else wx.switchTab({url:'/pages/account/index',success,fail});
    });
  }
});
