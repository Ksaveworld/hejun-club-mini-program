const { api, clearSession, hasSession, newKey, money, captureReferral, memberContext, sessionStamp, isCurrentSession } = require('../../utils/api');
const { plans } = require('../../data/content');
const drafts = require('../../utils/drafts');

function sessionExpired(error) { return error && (error.status === 401 || error.statusCode === 401); }
function emptyForm() { return { name: '', phone: '', city: '', company: '', industry: '', need: '', organizationType: '机构会员', referral: '' }; }

Page({
  data: {
    planId: '', plan: null, amountLabel: '', planReady: false, loading: false, busy: false,
    loggedIn: false, user: null, sourceCode: '', sourceExplicit: false, defaultReferralConfigured: false,
    form: emptyForm(), referralNotice: '',
    organizationTypes: ['机构会员', '专业会员'], organizationIndex: 0, consent: false,
    error: '', loadError: '', conflict: false, draftNote: '', reapplyNote: ''
  },
  onLoad(options) {
    const plan = plans.find(item => item.id === options.planId);
    this.setData({ planId: plan ? plan.id : '', plan: plan || null });
    if (!plan) this.setData({ loadError: '没有找到该会员方案，请返回重新选择。' });
    this._reapplyId = options.reapplyId || '';
    this._draftSlot = 'join:' + (plan ? plan.id : '') + ':' + this._reapplyId;
    captureReferral(options);
    this._lastPayload = '';
    this._idempotencyKey = '';
  },
  onUnload() { this._unloaded = true; },
  onShow() { this.loadContext(); },
  applyMember(session) {
    const scope = sessionStamp().scope;
    const changed = (this._formOwnerId && this._formOwnerId !== session.user.id) || (this._formScope && this._formScope !== scope);
    if (changed) {
      this._lastPayload = ''; this._idempotencyKey = '';
      this.setData({ form: emptyForm(), consent: false, organizationIndex: 0, error: '账号或测试环境已变化，请重新填写本次申请。' });
    }
    this._formOwnerId = session.user.id; this._formScope = scope;
    this._formStamp = sessionStamp();
    const ownerKey = scope + ':' + session.user.id;
    if (this._draftLoadedFor !== ownerKey) {
      this._draftLoadedFor = ownerKey;
      const saved = drafts.read(scope, session.user.id, this._draftSlot);
      this._restoredDraft = !!saved;
      if (saved) {
        this._lastPayload = saved.payload || ''; this._idempotencyKey = saved.key || '';
        this.setData({ form: Object.assign(emptyForm(), saved.form), organizationIndex: saved.organizationIndex || 0,
          consent: false, draftNote: '已恢复本机草稿，请核对资料后提交。' });
      }
    }
    this.setData({ loggedIn: true, user: session.user, sourceCode: session.user.sourceCode || '', sourceExplicit: session.user.referralSource === 'explicit',
      defaultReferralConfigured: session.defaultReferralConfigured === true, referralNotice: session.referralNotice || '' });
    return !changed;
  },
  assertContext(stamp) {
    if (this._unloaded || !isCurrentSession(stamp)) {
      const error = new Error('账号或测试环境已变化，请重新读取申请信息。');
      error.code = 'CONTEXT_CHANGED'; throw error;
    }
  },
  async loadContext() {
    if (!this.data.planId || this.data.loading || this.data.busy) return;
    this.setData({ loading: true, planReady: false, loadError: '', loggedIn: hasSession() });
    const stamp = sessionStamp();
    try {
      const result = await api('/plans');
      this.assertContext(stamp);
      const plan = result.plans.find(item => item.id === this.data.planId);
      if (!plan) throw new Error('该会员方案当前不可用，请返回重新选择。');
      this.setData({ planReady: true, amountLabel: money(plan.amountCents) });
      if (hasSession()) {
        const session = await memberContext();
        this.assertContext(stamp);
        if (!session.user) {
          clearSession();
          this.setData({ loggedIn: false, user: null, sourceCode: '', sourceExplicit: false });
        } else {
          this.applyMember(session);
          if (this._reapplyId && !this._prefillDone && !this._restoredDraft) {
            const prior = await api('/orders/' + encodeURIComponent(this._reapplyId)); this.assertContext(stamp);
            if (prior.order.status !== 'rejected' || prior.order.planId !== this.data.planId) throw new Error('此申请不能重新办理，请返回查看最新进度。');
            this._prefillDone = true;
            const form = Object.assign(emptyForm(), prior.order.form, { referral: '' });
            this.setData({ form, consent: false, organizationIndex: form.organizationType === '专业会员' ? 1 : 0,
              reapplyNote: '已带入上次资料。请根据审核说明修改后重新提交，原申请记录会保留。' });
          }
        }
      } else { this.setData({ loggedIn: false, user: null, sourceCode: '', sourceExplicit: false }); }
    } catch (error) {
      if (this._unloaded) return;
      if (sessionExpired(error)) {
        this.setData({ loggedIn: false, user: null, sourceCode: '', sourceExplicit: false });
      }
      this.setData({ planReady: false, loadError: sessionExpired(error) ? '登录已过期，请重新登录。已填写的资料仍保留在本页。' : (error.message || '暂时无法读取申请信息，请重试。') });
    } finally { if (!this._unloaded) this.setData({ loading: false }); }
  },
  saveDraft() {
    if (!this._formOwnerId || !hasSession() || !this._formStamp || !isCurrentSession(this._formStamp)) return;
    const saved = drafts.write(this._formScope, this._formOwnerId, this._draftSlot, {
      form: this.data.form, organizationIndex: this.data.organizationIndex, key: this._idempotencyKey, payload: this._lastPayload
    });
    this.setData({ draftNote: saved ? '草稿已保存在本机，24 小时内可继续；退出账号会清除。' : '本机暂时无法保存草稿，请保持当前页面。' });
  },
  changeField(event) {
    if (this.data.busy) return;
    const field = event.currentTarget.dataset.field;
    if (!['name', 'phone', 'city', 'company', 'industry', 'need'].includes(field)) return;
    this.setData({ ['form.' + field]: event.detail.value, error: '', conflict: false });
    this.saveDraft();
  },
  changeOrganization(event) {
    if (this.data.busy) return;
    const index = Number(event.detail.value);
    if (![0, 1].includes(index)) return;
    this.setData({ organizationIndex: index, 'form.organizationType': this.data.organizationTypes[index], error: '', conflict: false });
    this.saveDraft();
  },
  changeConsent(event) {
    if (!this.data.busy) this.setData({ consent: event.detail.value.includes('agree'), error: '' });
  },
  openLogin() {
    wx.navigateTo({ url: '/pages/login/index' });
  },
  openOrders() { wx.navigateTo({ url: '/pages/orders/index' }); },
  openMembers() { wx.navigateBack({ delta: 1, fail() { wx.redirectTo({url:'/pages/members/index'}); } }); },
  async submit() {
    if (this.data.busy || this.data.loading || !this.data.planReady) return;
    if (!hasSession() || !this.data.loggedIn) {
      this.setData({ loggedIn: false, error: '请先登录，已填写的资料会保留在当前页面。' }); return;
    }
    if (this.data.user && this.data.user.role === 'admin') {
      this.setData({ error: '后台管理账号不能申请入会，请使用会员账号。' }); return;
    }
    if (!this.data.consent) { this.setData({ error: '请先勾选内测资料保存说明。' }); return; }
    const form = {};
    Object.keys(this.data.form).forEach(key => { form[key] = this.data.form[key].trim(); });
    form.referral = '';
    if (!form.name || !form.city || (this.data.planId === 'organization' && !form.company)) {
      this.setData({ error: '请填写称呼、所在城市，以及机构或专业会员所需的机构名称。' }); return;
    }
    if (!/^1\d{10}$/.test(form.phone)) { this.setData({ error: '请输入 11 位手机号码格式，仅使用虚构联系资料。' }); return; }
    const payload = { planId: this.data.planId, form, consent: true };
    const serialized = JSON.stringify(payload);
    if (serialized !== this._lastPayload || !this._idempotencyKey) {
      this._lastPayload = serialized;
      this._idempotencyKey = newKey();
    }
    this.saveDraft();
    this.setData({ busy: true, error: '', conflict: false });
    const stamp = sessionStamp();
    try {
      const session = await memberContext();
      this.assertContext(stamp);
      if (!session.user) throw Object.assign(new Error('请重新登录'), { status: 401 });
      if (!this.applyMember(session)) return;
      const response = await api('/orders', payload, this._idempotencyKey);
      this.assertContext(stamp);
      if (response.order.status === 'cancelled' || response.order.status === 'rejected') {
        this._idempotencyKey = '';
        this.setData({ error: '上次申请已' + (response.order.status === 'cancelled' ? '取消' : '未通过') + '。确认重新申请请再次提交。', conflict: true });
        return;
      }
      drafts.write(this._formScope, this._formOwnerId, this._draftSlot, null);
      wx.redirectTo({
        url: '/pages/orders/index?id=' + encodeURIComponent(response.order.id),
        fail: () => this.setData({ error: '订单已保存。请前往“我的订单”查看，避免重新提交。', conflict: true })
      });
    } catch (error) {
      if (this._unloaded) return;
      if (sessionExpired(error)) {
        this.setData({ loggedIn: false, user: null });
      }
      this.setData({ error: sessionExpired(error) ? '登录已过期，请重新登录后继续。已填写的资料仍保留。' : (error.message || '保存未完成，可以重试；也可先查看是否已生成订单。'), conflict: error.status === 409 || error.statusCode === 409 });
    } finally { if (!this._unloaded) this.setData({ busy: false }); }
  }
});
