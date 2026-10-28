const { api, clearSession, hasSession, sessionStamp, isCurrentSession, newKey, subscribeSession } = require('../../utils/api');
const { accountDisplayLabel } = require('../../utils/user-display');
const { plans } = require('../../data/content');
const { saveProfileAvatar: saveAvatar, clearProfileAvatar: clearAvatar } = require('../../utils/profile-avatar');
const { chineseDateTime } = require('../../utils/display-time');
const { memberJourney } = require('../../utils/member-journey');

function sessionExpired(error) {
  return error && (error.status === 401 || error.statusCode === 401);
}
const reviewNotice='审核只读体验：仅可阅读已授权的发布内容和服务说明。申请、投稿、付款、推荐、奖励、提现及通知演示尚未开放，不能代表全功能审核已完成。';
function reviewGrant(session,stamp){
  const value=session.reviewAccess,user=session.user;
  const reviewing=stamp.authMode==='review'||user?.authMode==='review'||user?.role==='reviewer'||value?.readOnly===true;
  if(!reviewing)return null;
  const starts=Date.parse(value?.startsAt),ends=Date.parse(value?.expiresAt);
  if(user?.authMode!=='review'||user.role!=='reviewer'||!/^review-[a-f0-9-]{36}$/.test(user.id||'')||session.membership!=null||value?.appId!=='wx47d5e3e20fd77f65'||value.appVersion!=='1.1.0'||value.readOnly!==true||!['basic','star'].includes(value.planId)||!Number.isFinite(starts)||!Number.isFinite(ends)||ends-starts!==30*86400000||starts>Date.now()||ends<=Date.now())throw new Error('审核只读授权信息不完整或已失效，请重新登录后核对。');
  return value;
}

Page({
  data: {
    profileAvatar: '', profileNickname: '', loggedIn: false, user: null, displayLabel: '访客浏览', membership: null, membershipLabel: '尚未开通会员',
    expiryLabel: '', sourceState: '', unreadFeedback: 0, journey: null, journeyError: '', loading: false, busy: false, error: '', shareReady: false,
    reminders:null,reminderBusy:false,reminderError:'',reminderMessage:'',reminderPending:false,
    reviewAccess:null,reviewLabel:'',reviewStartsLabel:'',reviewExpiryLabel:'',reviewNotice:'',logoutCleanupPending:false
  },
  onLoad() {
    this._unsubscribeProfile = subscribeSession(() => {
      if (this._accountStamp && !isCurrentSession(this._accountStamp)) {
        this._accountRequest = (this._accountRequest || 0) + 1;
        this.clearAccount(); this.setData({loading:false});
      }
    });
  },
  onUnload() { this._unsubscribeProfile?.(); this.clearProfile(); this._unloaded = true; this._accountRequest = (this._accountRequest || 0) + 1; },
  onShow() { this._hidden = false; return this.refreshAccount(); },
  onHide() {
    this._hidden = true; this._accountRequest = (this._accountRequest || 0) + 1;
    this._reminderLock=false;
    this.clearAccount(); this.setData({ loading: false });
  },
  currentRead(request) { return !this._unloaded && !this._hidden && request === this._accountRequest; },
  async onPullDownRefresh() { try { await this.refreshAccount(); } finally { wx.stopPullDownRefresh(); } },
  clearProfile() {
    if (this._profileExpiryTimer) { clearTimeout(this._profileExpiryTimer); this._profileExpiryTimer = null; }
    if (this.data.profileAvatar) clearAvatar(this.data.profileAvatar);
    this.setData({profileAvatar: '', profileNickname: ''});
  },
  clearAccount() {
    this.clearProfile();
    this._reminderLock=false;
    this._accountStamp = null;
    this.setData({ logoutCleanupPending:false, unreadFeedback: 0, journey: null, journeyError: '', profileAvatar: '', profileNickname: '', loggedIn: false, user: null, displayLabel: '访客浏览', membership: null, expiryLabel: '', sourceState: '', membershipLabel: '尚未开通会员', shareReady: false,reminders:null,reminderError:'',reminderMessage:'',reminderBusy:false,reminderPending:false,reviewAccess:null,reviewLabel:'',reviewStartsLabel:'',reviewExpiryLabel:'',reviewNotice:'' });
  },
  async refreshAccount() {
    if (this._unloaded || this._hidden) return;
    if (this._accountStamp && !isCurrentSession(this._accountStamp)) this.clearAccount();
    if (this.data.loading || this.data.busy || this.data.reminderBusy) return;
    if (!hasSession()) {
      this.clearAccount();
      const unavailable = sessionStamp().storageUnavailable === true;
      this.setData({ error: unavailable ? '本机会话存储暂不可用，无法确认登录或退出状态；当前页资料已清空，请检查微信存储后重试退出清理。' : '', logoutCleanupPending:unavailable });
      return;
    }
    this.clearAccount();
    this.setData({ loading: true, error: '', shareReady: false });
    const stamp = sessionStamp(), request = this._accountRequest = (this._accountRequest || 0) + 1;
    try {
      const session = await api('/me');
      if (!this.currentRead(request)) return;
      if (!isCurrentSession(stamp)) throw new Error('账号已变化，请刷新后继续。');
      if (!session.user) {
        clearSession();
        this.setData({ profileAvatar: '', profileNickname: '', loggedIn: false, user: null, displayLabel: '访客浏览', membership: null, expiryLabel: '' });
        return;
      }
      const review=reviewGrant(session,stamp);
      if(review){
        const plan=plans.find(item=>item.id===review.planId);
        this._accountStamp=stamp;this._reminderPending=null;
        this.setData({loggedIn:true,user:session.user,displayLabel:accountDisplayLabel(session.user),membership:null,membershipLabel:'审核只读体验',reviewAccess:review,reviewLabel:(plan?plan.name:'会员内容')+'只读授权',reviewStartsLabel:new Date(review.startsAt).toLocaleString(),reviewExpiryLabel:new Date(review.expiresAt).toLocaleString(),reviewNotice,
          sourceState:'审核体验不登记推荐来源',shareReady:false,journey:{kind:'review',title:'审核只读体验',note:'可查看当前获准的发布内容；这份授权不代表真实付费会籍。',action:'查看获准报告'}});
        return;
      }
      const membership = session.membership || null;
      const plan = membership && plans.find(item => item.id === membership.planId);
      this._accountStamp = stamp;
      if(this._reminderPending&&(this._reminderPending.owner!==session.user.id||this._reminderPending.scope!==stamp.scope))this._reminderPending=null;
      this.setData({
        loggedIn: true, user: session.user, displayLabel: accountDisplayLabel(session.user), membership,
        sourceState: session.user.referralLockedAt ? '已随付款锁定' : session.user.referralSource === 'explicit' ? '已保留首次有效来源' : '尚未付款锁定',
        shareReady: session.user.role === 'member' && /^[A-Z0-9]{6}$/.test(session.user.referralCode || ''),
        membershipLabel: membership ? (membership.active ? (plan ? plan.name : '有效会员') : '会员已到期') : '尚未开通会员',
        expiryLabel: membership && membership.expiresAt ? chineseDateTime(membership.expiresAt).split(' ')[0] : ''
      });
      void this.refreshProfile(stamp, request);
      try {
        const result = await api('/orders');
        if (!this.currentRead(request)) return;
        if (!isCurrentSession(stamp)) { this.clearAccount(); return; }
        this.setData({ journey: memberJourney(membership, result.orders) });
        const feedback=await api('/feedback/summary');
        if(!this.currentRead(request))return;
        if(!isCurrentSession(stamp)){this.clearAccount();return;}
        this.setData({unreadFeedback:feedback.unreadCount || 0});
      } catch (error) {
        if (!this.currentRead(request)) return;
        if (!isCurrentSession(stamp)) { this.clearAccount(); return; }
        if (sessionExpired(error)) throw error;
        if(!this.data.journey) this.setData({ journeyError: '暂时无法读取申请进度，请下拉重试。' });
      }
      if(this.currentRead(request)&&isCurrentSession(stamp))await this.refreshReminders(stamp,request);
    } catch (error) {
      if (!this.currentRead(request)) return;
      this.clearAccount();
      this.setData({ error: sessionExpired(error) ? '登录已过期，请重新登录。' : (error.message || '暂时无法读取账号，请重试。') });
    } finally { if (this.currentRead(request)) this.setData({ loading: false }); }
  },
  async refreshProfile(stamp, request) {
    const delay = Date.parse(stamp.expiresAt) - Date.now();
    if (Number.isFinite(delay) && delay > 0 && typeof setTimeout === 'function') this._profileExpiryTimer = setTimeout(() => {
      if (this.currentRead(request) && isCurrentSession(stamp)) this.clearAccount();
    }, Math.min(delay, 2147483647));
    const current = () => this.currentRead(request) && hasSession() && isCurrentSession(stamp) && this.data.loggedIn && !this.data.reviewAccess;
    try {
      const result = await api('/profile');
      if (!current() || !result.profile) return;
      const profile = result.profile;
      const nickname = typeof profile.nickname === 'string' ? profile.nickname.trim().slice(0, 40) : '';
      this.setData({profileNickname: nickname});
      if (profile.avatarDataUrl) {
        const path = await saveAvatar(profile.avatarDataUrl);
        if (!current()) { if (path) clearAvatar(path); return; }
        if (this.data.profileAvatar) clearAvatar(this.data.profileAvatar);
        this.setData({profileAvatar: path || ''});
      }
    } catch (error) { /* Optional profile must not block membership or order access. */ }
  },
  async refreshReminders(stamp=this._accountStamp,request=this._accountRequest){
    if(this.data.reviewAccess||stamp?.authMode==='review')return;
    try{
      const result=await api('/reminders');if(!this.currentRead(request))return;
      if(!isCurrentSession(stamp)){this.clearAccount();return;}
      const labels={waiting_permission:'等待微信确认订阅权限',transmitting:'正在提交微信，结果待确认',accepted:'微信接口已受理，最终推送待确认',delivered:'微信确认推送成功，是否阅读无法确认',failed:'微信确认失败，需核对后处理',unknown:'发送结果未知，暂不重发',cancelled:'任务已停止，未补发'};
      if(typeof result.enabled!=='boolean'||!Array.isArray(result.tasks))throw new Error('提醒状态暂时未能完整读取。');
      this.setData({reminders:Object.assign({},result,{tasks:result.tasks.map(task=>Object.assign({},task,{statusLabel:labels[task.status]||'状态待核对',dueLabel:new Date(task.dueAt).toLocaleString()}))}),reminderError:'',reminderPending:!!this._reminderPending});
    }catch(error){if(!this.currentRead(request))return;if(!isCurrentSession(stamp)||sessionExpired(error)){this.clearAccount();return;}this.setData({reminders:null,reminderError:error.message||'提醒状态暂时无法读取，请重试。'});}
  },
  reminderContext(stamp,owner,request=this._accountRequest){return !this.data.reviewAccess&&stamp?.authMode!=='review'&&this.data.user?.role!=='reviewer'&&this.currentRead(request)&&hasSession()&&isCurrentSession(stamp)&&this.data.user?.id===owner&&this.data.loggedIn;},
  subscribeReminder(){
    const settings=this.data.reminders,stamp=this._accountStamp,owner=this.data.user?.id,request=this._accountRequest;
    if(this.data.busy||this.data.loading||this._reminderLock||this._reminderPending||!settings?.enabled||!this.reminderContext(stamp,owner,request))return;
    if(typeof wx.requestSubscribeMessage!=='function'){this.setData({reminderError:'当前微信版本暂不支持订阅，请更新微信；会籍状态仍可在本页查询。'});return;}
    const actualApp=typeof wx.getAccountInfoSync==='function'?wx.getAccountInfoSync().miniProgram?.appId:null;
    if(actualApp&&actualApp!==settings.appId){this.setData({reminderError:'提醒模板所属小程序与当前环境不符，请联系工作人员核对。'});return;}
    const key=newKey();this._reminderLock=true;this.setData({reminderBusy:true,reminderError:'',reminderMessage:''});
    // Must run directly in the user's click handler; no await before this popup.
    wx.requestSubscribeMessage({tmplIds:[settings.templateId],success:result=>{
      if(!this.reminderContext(stamp,owner,request))return;
      const choice=result[settings.templateId];if(!['accept','reject','ban','filter'].includes(choice)){this._reminderLock=false;this.setData({reminderBusy:false,reminderError:'微信未返回此模板的明确选择，请重新读取提醒状态。'});return;}
      this._reminderPending={owner,scope:stamp.scope,key,body:{templateId:settings.templateId,configVersion:settings.configVersion,result:choice}};
      this._reminderLock=false;void this.persistReminderChoice(stamp,request);
    },fail:()=>{if(!this.reminderContext(stamp,owner,request))return;this._reminderLock=false;this.setData({reminderBusy:false,reminderError:'本次订阅未完成，未记录为同意或已推送。'});}});
  },
  async persistReminderChoice(stamp=this._accountStamp,request=this._accountRequest){
    const pending=this._reminderPending;if(!pending||this._reminderLock||!this.reminderContext(stamp,pending.owner,request))return;
    this._reminderLock=true;this.setData({reminderBusy:true,reminderError:'',reminderPending:true});
    try{
      const current=await api('/me');if(!this.reminderContext(stamp,pending.owner,request))return;
      if(current.user?.id!==pending.owner||current.user.role!=='member'||current.user.authMode==='review'||current.reviewAccess?.readOnly===true)throw Object.assign(new Error('登录身份已变化，请重新读取提醒。'),{status:401});
      const result=await api('/reminders/choices',pending.body,pending.key);if(!this.reminderContext(stamp,pending.owner,request))return;
      if(result.recorded!==true||result.result!==pending.body.result)throw new Error('订阅选择保存回执未确认，请用原记录重试。');
      this._reminderPending=null;this.setData({reminderPending:false,reminderMessage:pending.body.result==='accept'?'已保存同意订阅的选择；是否推送以微信的发送结果为准。':'已记录本次选择；会籍状态仍可在本页查看。'});
      await this.refreshReminders(stamp,this._accountRequest);
    }catch(error){if(!this.reminderContext(stamp,pending.owner,request))return;if(sessionExpired(error)||error.status===403){this._reminderPending=null;this.clearAccount();}else if([400,409,422].includes(error.status)){this._reminderPending=null;this.setData({reminderPending:false,reminderError:error.message||'选择未保存，请重新读取提醒配置。',reminderMessage:'请刷新当前提醒配置后再选择；订阅权限以微信实际结果为准。'});}else{this.setData({reminderError:error.message||'选择保存结果未确认。',reminderPending:true,reminderMessage:'原选择与编号已保留，请重试保存，不会重新弹出订阅。'});}}
    finally{if(this.reminderContext(stamp,pending.owner,request)){this._reminderLock=false;this.setData({reminderBusy:false});}}
  },
  retryReminderChoice(){return this.persistReminderChoice();},
  openJourney() {
    if (!this._accountStamp || !hasSession() || !isCurrentSession(this._accountStamp) || this.data.loading) { this.clearAccount(); return; }
    const item = this.data.journey; if (!item) return;
    if(item.kind==='review')wx.navigateTo({url:'/pages/articles/index'});
    else if (item.kind === 'order') wx.navigateTo({ url: '/pages/orders/index?id=' + encodeURIComponent(item.id) });
    else if (item.kind === 'services') wx.switchTab({ url: '/pages/services/index' });
    else this.openMembers();
  },
  openProfile() {
    if (this.reviewActionBlocked()) return;
    if (!this._accountStamp || !hasSession() || !isCurrentSession(this._accountStamp) || this.data.loading || this.data.busy) return;
    wx.navigateTo({ url: '/pages/profile/index' });
  },
  openLogin() { wx.navigateTo({ url: '/pages/login/index' }); },
  reviewActionBlocked(){
    if(!this.data.reviewAccess)return false;
    if(!this._accountStamp||!hasSession()||!isCurrentSession(this._accountStamp)){this.clearAccount();return true;}
    this.setData({error:reviewNotice});return true;
  },
  openOrders() { if(!this.reviewActionBlocked())wx.navigateTo({ url: '/pages/orders/index' }); },
  openCommunity(){if(!this.reviewActionBlocked())wx.navigateTo({url:'/pages/posts/index?mode=feed'});},
  openPosts() { if(!this.reviewActionBlocked())wx.navigateTo({ url: '/pages/posts/index' }); },
  openInvite() { if(!this.reviewActionBlocked())wx.navigateTo({ url: '/pages/invite/index' }); },
  openRewards() { if(!this.reviewActionBlocked())wx.navigateTo({ url: '/pages/rewards/index' }); },
  openFeedback() { if(!this.reviewActionBlocked())wx.navigateTo({ url: '/pages/feedback/index' }); },
  openHelp() { wx.navigateTo({ url: '/pages/help/index' }); },
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
    const stamp = this._accountStamp, owner = this.data.user?.id, retrying = this.data.logoutCleanupPending;
    let request = Promise.resolve();
    this.setData({ busy: true, error: '' });
    try {
      const loggedIn = hasSession(), active = loggedIn && stamp && isCurrentSession(stamp);
      // Handle this rejection immediately, before any fallible local storage
      // operation. No late server result may modify a newer account's page.
      if (active) request = api('/native/auth/logout', {}).then(() => undefined, () => undefined);
      const cleared = stamp || !loggedIn ? clearSession({logout:true, stamp:stamp || sessionStamp(), owner}) : true;
      const unavailable = sessionStamp().storageUnavailable === true;
      this.clearAccount();
      this.setData({logoutCleanupPending:unavailable || cleared === false, error: unavailable
        ? '本机会话存储清理未能确认，无法确认退出；当前页私有资料已清空，请检查微信存储后重试退出清理。'
        : cleared === false ? '本机账号已退出，但草稿清理未能完成；请检查微信存储后重试退出清理。'
        : !active && !retrying ? '登录状态已变化，请刷新账号后继续。' : ''});
    } catch (error) {
      if (!this._unloaded) {this.clearAccount(); this.setData({logoutCleanupPending:true, error:'本机存储操作未完成，无法确认退出；当前页资料已清空，请检查微信存储后重试退出清理。'});}
    } finally { if (!this._unloaded) this.setData({busy:false}); }
    await request;
  },
  openExclusiveContacts() { wx.navigateTo({url:'/pages/exclusive-contacts/index'}); },
  retryAccount() {return this.data.logoutCleanupPending ? this.logout() : this.refreshAccount();}
});
