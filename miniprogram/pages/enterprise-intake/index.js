const {api, newKey, submitEnterpriseIntake, hasSession, sessionStamp, isCurrentSession, subscribeSession, enterpriseDraftScope, identifyDraftOwner} = require('../../utils/api');
const drafts = require('../../utils/drafts');
const form = require('../../utils/enterprise-form');
const {loadLegal, legalConsent} = require('../../utils/legal');
const {openPublicDocument, showPublicDocuments, hidePublicDocuments, clearPublicDocuments} = require('../../utils/public-documents');
const slot = 'text';
const guestNote = '游客文字仅在当前页面保留；如需关闭后找回，请先登录。附件需要重新选择，同意选项需要重新确认。';
function emptyForm() { return {answers: {}, company: '', contact: '', phone: '', note: '', file: null, consent: false, policy: false, hongKong: false,
  fieldErrors: {}, validationSummary: '', fileNotice: '', showPrivacy: false, filePurposeAgreed: false, uploadProgress: null, receipt: '', draftDirty: false}; }
Page({
  data: {...emptyForm(), config: null, fields: [], legal: null, legalReady: false, busy: false, error: '', loggedIn: false, identityReady: false,
    draftNote: guestNote, draftSaved: false, privacyContractName: '《小程序用户隐私保护指引》'},
  onLoad() {
    this._key = newKey();
    this._unsubscribe = subscribeSession(() => this.invalidateIdentity('登录状态已变化，当前页私有资料已清空；请重新读取或登录。'));
    return this.load();
  },
  onShow() {
    showPublicDocuments(this);
    if (this._loaded && !this.checkContext() && !this.data.busy) return this.load();
  },
  onHide() {hidePublicDocuments(this);},
  openLogin() {if (!this.data.busy) wx.navigateTo({url: '/pages/login/index'});},
  onUnload() {
    this._disposed = true; this._file = null; this._owner = ''; this._stamp = null;
    if (this._unsubscribe) this._unsubscribe(); this.stopTimers(); clearPublicDocuments(this);
  },
  stopTimers() {
    if (typeof clearTimeout === 'function') {clearTimeout(this._sessionTimer); clearTimeout(this._draftTimer);}
  },
  invalidateIdentity(message) {
    if (this._disposed) return;
    this.stopTimers(); this._privateRead = (this._privateRead || 0) + 1; this._identityRead = (this._identityRead || 0) + 1;
    this._file = null; this._owner = ''; this._stamp = null; this._draftScope = ''; this._key = newKey();
    this.setData({...emptyForm(), busy: false, loggedIn: false, identityReady: false, draftSaved: false, draftNote: message || guestNote});
    if (this.data.config) this.showFields();
  },
  checkContext() {
    if (this._disposed) return false;
    const loggedIn = hasSession();
    if (this.data.identityReady && this._stamp && isCurrentSession(this._stamp) && loggedIn === this.data.loggedIn) return true;
    if (this._stamp || this.data.identityReady) this.invalidateIdentity('登录或环境已变化，当前页私有资料已清空；请重新读取。');
    return false;
  },
  active(stamp, revision) {return !this._disposed && revision === (this._privateRead || 0) && this.checkContext() && isCurrentSession(stamp);},
  async load() {
    if (this.data.busy || this._disposed) return;
    hasSession(); const stamp = sessionStamp(), read = this._loadRead = (this._loadRead || 0) + 1;
    this.setData({busy: true, error: '', legalReady: false});
    try {
      const [config, legal] = await Promise.all([api('/enterprise-intake'), loadLegal()]);
      if (this._disposed || read !== this._loadRead) return;
      if (!isCurrentSession(stamp)) throw new Error('登录或环境已变化，请重新读取。');
      if (!Array.isArray(config.fields)) throw new Error('企业登记字段暂未就绪，请稍后重试');
      if (this.data.config && this.data.config.templateVersion !== config.templateVersion) this.invalidateIdentity('模板版本已变化，请按新问卷重新填写。');
      this.setData({config, legal, legalReady: true}); this.showFields(); this._loaded = true;
      await this.refreshIdentity();
    } catch (e) {if (!this._disposed && read === this._loadRead) this.setData({error: e.message});}
    finally {if (!this._disposed && read === this._loadRead) this.setData({busy: false});}
  },
  async refreshIdentity() {
    const loggedIn = hasSession(), stamp = sessionStamp(), read = this._identityRead = (this._identityRead || 0) + 1;
    try {
      const session = loggedIn ? await api('/me') : null;
      if (this._disposed || read !== this._identityRead || !isCurrentSession(stamp)) return;
      if (loggedIn && (typeof session?.user?.id !== 'string' || !session.user.id)) throw new Error('未能核实登录身份，请重新登录或读取。');
      this._stamp = stamp; this._owner = session?.user?.id || '';
      this._draftScope = this._owner ? enterpriseDraftScope(stamp.scope, this._owner) : '';
      this.setData({loggedIn, identityReady: true, draftNote: loggedIn ? '未提交的文字会在本机保留24小时；附件和同意选项不保存。退出账号会清除草稿。' : guestNote});
      if (loggedIn) {
        try {identifyDraftOwner(this._owner, stamp); this.restoreDraft();}
        catch (error) {this.setData({draftSaved: false, draftNote: '本机存储暂不可用，未能读取或保存草稿，请保持当前页面。'});}
        this.armSessionTimer(stamp);
      }
    } catch (error) {
      if (!this._disposed && read === this._identityRead) {this.invalidateIdentity(); this.setData({error: error.status === 401 ? '登录已过期，请重新登录；同账号24小时内的文字草稿可在核实身份后恢复。' : error.message});}
    }
  },
  armSessionTimer(stamp) {
    if (typeof setTimeout !== 'function') return;
    if (typeof clearTimeout === 'function') clearTimeout(this._sessionTimer);
    const remaining = Date.parse(stamp.expiresAt) - Date.now();
    if (!Number.isFinite(remaining)) return;
    this._sessionTimer = setTimeout(() => {
      if (this._disposed || this._stamp !== stamp) return;
      if (this.checkContext()) this.armSessionTimer(stamp);
    }, Math.max(1, Math.min(remaining, 60 * 60 * 1000)));
  },
  armDraftTimer(at) {
    if (typeof setTimeout !== 'function') return;
    if (typeof clearTimeout === 'function') clearTimeout(this._draftTimer);
    const stamp = this._stamp;
    this._draftTimer = setTimeout(() => {
      if (!this.checkContext() || this._stamp !== stamp || !this._owner) return;
      const result = drafts.readResult(this._draftScope, this._owner, slot);
      if (result.status === 'saved') this.armDraftTimer(result.at);
      else this.setData({draftSaved: false, draftNote: result.status === 'failed' ? '本机存储暂不可用，无法确认草稿清理结果。' : '本机草稿已过期清除；当前页面的文字仍可继续填写，修改后会重新保存。'});
    }, Math.max(1, Math.min(at + drafts.lifetime - Date.now(), 60 * 60 * 1000)));
  },
  restoreDraft() {
    const result = drafts.readResult(this._draftScope, this._owner, slot);
    if (result.status === 'failed') {this.setData({draftSaved: false, draftNote: '本机暂时无法读取草稿，请保持当前页面；修改后会重试保存。'}); return;}
    if (result.status === 'expired') {this.setData({draftSaved: false, draftNote: '之前的文字草稿已满24小时，已从本机清除，请重新填写。'}); return;}
    if (!result.value) return;
    if (result.value.templateVersion !== this.data.config.templateVersion) {
      const cleared = drafts.write(this._draftScope, this._owner, slot, null);
      this.setData({draftSaved: !cleared, draftNote: cleared ? '问卷模板版本已变化，旧草稿已清除，请按新问卷重新填写。' : '问卷模板版本已变化，未恢复旧草稿；本机清除失败，请重试放弃草稿。'}); return;
    }
    const value = form.draftValue(result.value, this.data.config); delete value.templateVersion;
    this.setData({...emptyForm(), ...value, draftSaved: true, draftNote: '已恢复本人本机文字草稿，请核对资料；附件需重新选择，同意选项需重新确认。'});
    this.showFields(); this.armDraftTimer(result.at);
  },
  saveDraft() {
    if (!this.checkContext() || !this._owner || !this.data.config || this.data.receipt) return;
    const value = form.draftValue(this.data, this.data.config), hasText = form.hasText(value);
    const saved = drafts.write(this._draftScope, this._owner, slot, hasText ? value : null);
    this.setData({draftSaved: saved && hasText, draftNote: saved ? (hasText ? '文字草稿已保存在本机，24小时内可继续；附件和同意选项不保存，退出账号会清除。' : '当前没有未提交的文字草稿。') : '本机暂时无法保存草稿，请保持当前页面，关闭后可能无法找回。'});
    if (saved && hasText) this.armDraftTimer(Date.now());
  },
  discardDraft() {
    if (!this.checkContext() || this.data.busy) return;
    const stamp = this._stamp, revision = this._privateRead || 0;
    wx.showModal({title: '放弃本次草稿', content: '清除本表单的文字、当前所选附件和同意选项；其他表单草稿不受影响。', confirmText: '放弃草稿', success: result => {
      if (!result.confirm || !this.active(stamp, revision)) return;
      if (this._owner && !drafts.write(this._draftScope, this._owner, slot, null)) {this.setData({draftNote: '本机草稿清除失败，资料仍保留，请重试。'}); return;}
      const receipt = this.data.receipt; this._file = null; this._key = newKey();
      this.setData({...emptyForm(), receipt, draftSaved: false, draftNote: '本表单草稿已放弃。'}); this.showFields();
    }});
  },
  changed() {this._key = newKey(); this.setData({error: '', draftDirty: true});},
  showFields() {
    this.setData({fields: this.data.config.fields.map(f => ({...f, value: this.data.answers[f.id] || '', error: this.data.fieldErrors[f.id] || '',
      choices: (f.options || []).map(value => ({value, checked: f.type === 'multi' ? (this.data.answers[f.id] || []).includes(value) : this.data.answers[f.id] === value}))}))});
  },
  correctError(id) {
    if (!this.data.fieldErrors[id]) return;
    const error = form.fieldError(id, this.data, this.data.config), errors = {...this.data.fieldErrors};
    if (error) errors[id] = error; else delete errors[id];
    this.setData({fieldErrors: errors, validationSummary: Object.keys(errors).length ? '请补齐标红内容后再提交' : ''});
  },
  change(e) {
    if (this.data.busy || this.data.receipt || !this.checkContext()) return;
    const id = e.currentTarget.dataset.id;
    if (!['company', 'contact', 'phone', 'note'].includes(id)) return;
    this.changed(); this.setData({[id]: e.detail.value}); this.correctError(id); this.saveDraft();
  },
  answer(e) {
    if (this.data.busy || this.data.receipt || !this.checkContext() || !this.data.config) return;
    const id = e.currentTarget.dataset.id, f = this.data.config.fields.find(field => field.id === id);
    if (!f) return;
    let value = e.detail.value;
    if (f.type === 'multi') {
      if (!Array.isArray(value)) return;
      const previous = this.data.answers[id] || [], added = value.find(v => !previous.includes(v));
      if (added === f.exclusive) value = [f.exclusive];
      else if (added && value.includes(f.exclusive)) value = value.filter(v => v !== f.exclusive);
      if (value.length > f.maxChoices) {this.setData({fieldErrors: {...this.data.fieldErrors, [id]: f.label + '最多选择' + f.maxChoices + '项'}}); this.showFields(); return;}
    }
    this.changed(); this.setData({['answers.' + id]: value}); this.correctError(id); this.showFields(); this.saveDraft();
  },
  agree(e) {
    if (this.data.busy || this.data.receipt || !this.checkContext()) return;
    const id = e.currentTarget.dataset.id;
    if (!['policy', 'hongKong', 'consent'].includes(id)) return;
    this.changed(); const agreed = e.detail.value.length > 0, errors = {...this.data.fieldErrors};
    if (agreed) delete errors[id];
    this.setData({[id]: agreed, fieldErrors: errors, validationSummary: Object.keys(errors).length ? this.data.validationSummary : ''});
  },
  setFileError(message) {
    this.setData({fieldErrors: {...this.data.fieldErrors, file: message}, fileNotice: this._file ? '本次未替换，仍保留此前所选文件。' : ''});
  },
  confirmFilePurpose(e) {
    if (this.data.busy || this.data.receipt || !this.checkContext()) return;
    const agreed = Array.isArray(e.detail.value) && e.detail.value.includes('purpose');
    const errors = {...this.data.fieldErrors};
    if (agreed && errors.file === '请先勾选并确认文件用途，再选择材料') delete errors.file;
    this.setData({filePurposeAgreed: agreed, fieldErrors: errors});
  },
  async chooseFile() {
    if (this.data.busy || this.data.showPrivacy || this.data.receipt || !this.data.config || !this.checkContext()) return;
    if (!this.data.filePurposeAgreed) {this.setFileError('请先勾选并确认文件用途，再选择材料'); return;}
    if (!wx.chooseMessageFile) {this.setFileError('当前环境不能选择文件，请在手机微信中打开'); return;}
    const stamp = this._stamp, revision = this._privateRead || 0;
    this.setData({busy: true, error: ''});
    try {
      if (wx.getPrivacySetting) {
        const privacy = await new Promise((resolve, reject) => wx.getPrivacySetting({success: resolve, fail: reject}));
        if (!this.active(stamp, revision)) return;
        if (typeof privacy.needAuthorization !== 'boolean') throw new Error('Invalid privacy status');
        if (privacy.needAuthorization) {this.setData({showPrivacy: true, busy: false, privacyContractName: privacy.privacyContractName || '《小程序用户隐私保护指引》'}); return;}
      }
      if (this.active(stamp, revision)) this.selectFile();
    } catch (error) {if (this.active(stamp, revision)) {this.setData({busy: false}); this.setFileError('未能读取微信隐私授权状态，请稍后重新选择文件');}}
  },
  agreeFilePrivacy() {
    if (!this.data.showPrivacy || !this.data.filePurposeAgreed || this.data.busy || !this.checkContext()) return;
    this.setData({showPrivacy: false, busy: true, error: ''}); this.selectFile();
  },
  cancelFilePrivacy() {
    if (!this.checkContext()) return;
    this.setData({showPrivacy: false, filePurposeAgreed: false, busy: false}); this.setFileError('未授权读取所选文件。你可以继续填写资料，需要上传时再选择文件。');
  },
  openFilePrivacy() {
    if (!this.checkContext()) return;
    const stamp = this._stamp, revision = this._privateRead || 0;
    if (wx.openPrivacyContract) wx.openPrivacyContract({fail: () => {if (this.active(stamp, revision)) this.setFileError('微信隐私指引暂未打开，请稍后重试');}});
  },
  selectFile() {
    if (!this.data.filePurposeAgreed || !this.checkContext()) return;
    const stamp = this._stamp, revision = this._privateRead || 0;
    wx.chooseMessageFile({count: 1, type: 'file', extension: ['docx', 'pdf'],
      success: result => {
        if (!this.active(stamp, revision)) return;
        const file = result.tempFiles && result.tempFiles[0], error = form.fileError(file);
        if (error) {this.setFileError(error); return;}
        this._file = {name: file.name, path: file.path, size: file.size}; this.changed();
        const errors = {...this.data.fieldErrors}; delete errors.file;
        this.setData({file: {name: file.name, sizeLabel: (file.size / 1024).toFixed(1) + 'KB'}, fieldErrors: errors, fileNotice: '文件已选中；点击提交后才会上传。', validationSummary: Object.keys(errors).length ? this.data.validationSummary : ''});
      },
      fail: e => {
        if (!this.active(stamp, revision)) return;
        const message = e.errMsg || '';
        if (/privacy|permission.*not authorized/i.test(message)) this.setFileError('未取得微信文件隐私授权，请重新选择文件并按提示确认。');
        else if (/cancel/i.test(message)) this.setData({fileNotice: this._file ? '已取消本次选择，原文件和填写内容保留。' : '已取消选择，填写内容保留，可随时重新选择。'});
        else this.setFileError('文件选择未完成，请先把材料保存到微信聊天，再重新选择');
      },
      complete: () => {if (this.active(stamp, revision)) this.setData({busy: false});}
    });
  },
  removeFile() {
    if (this.data.busy || this.data.receipt || !this.checkContext()) return;
    this._file = null; this.changed(); const errors = {...this.data.fieldErrors}; delete errors.file;
    this.setData({file: null, fieldErrors: errors, fileNotice: '附件已移除，填写的文字保留；提交前请重新选择。'});
  },
  async openDocument(e) {
    const {type, id} = e.currentTarget.dataset;
    if (type !== 'legal' && type !== 'docx') return;
    try {await openPublicDocument(type === 'legal' ? '/legal/' + id + '/document' : '/enterprise-intake/template/docx', type === 'docx' ? 'docx' : 'pdf', this);}
    catch (error) {if (!this._disposed) this.setData({error: error.message});}
  },
  async submit() {
    if (this.data.busy || this.data.showPrivacy || this.data.receipt || this.data.config?.mode !== 'hybrid' || !this.checkContext()) return;
    const errors = form.validate(this.data, this.data.config, this._file);
    if (this.data.fieldErrors.file) errors.file = this.data.fieldErrors.file;
    this.setData({fieldErrors: errors, validationSummary: Object.keys(errors).length ? '请补齐标红内容后再提交' : ''}); this.showFields();
    if (Object.keys(errors).length) {if (wx.pageScrollTo) wx.pageScrollTo({selector: '#field-' + Object.keys(errors)[0], duration: 250}); return;}
    let legal; try {legal = legalConsent(this.data);} catch (e) {this.setData({fieldErrors: {policy: e.message}, validationSummary: '请补齐标红内容后再提交'}); return;}
    const stamp = this._stamp, revision = this._privateRead || 0, file = this._file;
    const text = form.draftValue(this.data, this.data.config), key = this._key;
    this.setData({busy: true, error: '', uploadProgress: 0});
    let reading = true;
    try {
      const fileBase64 = await new Promise((resolve, reject) => wx.getFileSystemManager().readFile({filePath: file.path, encoding: 'base64',
        success: r => resolve(r.data), fail: () => reject(new Error('文件读取失败，请重新选择材料'))}));
      if (!this.active(stamp, revision)) return;
      reading = false;
      const payload = {...text, filename: file.name, fileBase64, consent: true, legalConsent: legal};
      const result = await submitEnterpriseIntake(payload, key, progress => {if (this.active(stamp, revision)) this.setData({uploadProgress: progress});}, () => this.active(stamp, revision));
      if (!this.active(stamp, revision)) return;
      if (typeof result?.receipt?.id !== 'string' || !result.receipt.id) throw new Error('未取得有效回执，请用原提交重试');
      const cleared = !this._owner || drafts.write(this._draftScope, this._owner, slot, null);
      this._file = null; this.setData({...emptyForm(), receipt: result.receipt.id, fields: [], draftSaved: !cleared,
        draftNote: cleared ? '本表单已提交，文字草稿已清除。' : '提交已取得回执，但本机草稿清除失败，请重试放弃草稿。'});
    } catch (e) {
      if (this.active(stamp, revision)) {
        if (reading) this.setFileError(e.message);
        else this.setData({error: e.message + '；填写资料和所选文件保留，可重试。'});
      }
    } finally {if (this.active(stamp, revision)) this.setData({busy: false, uploadProgress: null});}
  }
});
