const {fileError,submitSurvey}=require('../../utils/survey-upload');
const {api, newKey, sessionStamp, isCurrentSession, subscribeSession} = require('../../utils/api');
const {loadLegal, legalConsent} = require('../../utils/legal');
const {openPublicDocument,showPublicDocuments,hidePublicDocuments,clearPublicDocuments} = require('../../utils/public-documents');
const sides = ['supply', 'demand', 'singapore', 'salon', 'general-demand', 'general-supply'];
Page({
  data: {generalMenu:false,file:null,progress:null,showPrivacy:false,privacyContractName:'《小程序用户隐私保护指引》',side: '', survey: null, section: 1, fields: [], answers: {}, consent: false, policy: false,
    hongKong: false, legal: null, legalReady: false, busy: false, error: '', receipt: ''},
  onLoad(query = {}) {
    this._unsubscribe=subscribeSession(()=>{if(this.data.survey?.general){this._generation=(this._generation||0)+1;this._file=null;this._key=newKey();this.setData({answers:{},fields:[],file:null,progress:null,consent:false,policy:false,hongKong:false,busy:false,showPrivacy:false,receipt:'',error:'登录状态已变化，请重新填写。'});this.showSection();}});
    if (sides.includes(query.side)) return this.loadSurvey(query.side);
    if(query.group==='general')this.setData({generalMenu:true});
  },
  openGeneral(){if(!this.data.busy)this.setData({generalMenu:true,error:''});},
  backList(){if(!this.data.busy)this.setData({generalMenu:false});},
  onShow(){showPublicDocuments(this);},
  onHide(){hidePublicDocuments(this);},
  onUnload() {if(this._unsubscribe)this._unsubscribe();this._file=null;this._disposed = true; this._generation = (this._generation || 0) + 1;clearPublicDocuments(this);},
  choose(event) {if (!this.data.busy) return this.loadSurvey(event.currentTarget.dataset.side);},
  async loadSurvey(side) {
    if (!sides.includes(side)) return;
    const generation = this._generation = (this._generation || 0) + 1;
    const current = () => !this._disposed && this._generation === generation;
    this._key = newKey(); this._submitted = false;this._file=null;
    this.setData({file:null,progress:null,showPrivacy:false,side, survey: null, section: 1, answers: {}, fields: [], consent: false, policy: false,
      hongKong: false, legal: null, legalReady: false, receipt: '', error: '', busy: true});
    try {
      const [result, legal] = await Promise.all([api('/surveys/' + side), loadLegal()]);
      if (!current()) return;
      this.setData({survey: result.survey, legal, legalReady: true}); this.showSection();
    } catch (err) {if (current()) this.setData({error: err.message});}
    finally {if (current()) this.setData({busy: false});}
  },
  retry() {return this.loadSurvey(this.data.side);},
  showSection() {
    if (!this.data.survey) return;
    this.setData({fields: this.data.survey.fields.filter(f => f.section === this.data.section).map(f => ({...f,
      label: f.label + (f.enLabel ? '\n' + f.enLabel : ''),
      value: this.data.answers[f.id] || '', note: this.data.answers[f.id + 'Note'] || '',
      showNote: !!f.options.length && (this.data.survey.general ? !!f.noteLabel : (this.data.side !== 'salon' || !!f.noteLabel)),
      choices: f.options.map((value, index) => ({value, label: value + (f.enOptions && f.enOptions[index] ? '\n' + f.enOptions[index] : ''),
        checked: f.type === 'multi' ? (this.data.answers[f.id] || []).includes(value) : this.data.answers[f.id] === value}))
    }))});
    wx.pageScrollTo({scrollTop: 0, duration: 0});
  },
  changed() {if (this._submitted) {this._key = newKey(); this._submitted = false;}},
  change(event) {
    if (this.data.busy || this.data.receipt) return;
    this.changed(); this.setData({['answers.' + event.currentTarget.dataset.id]: event.detail.value, error: ''});
  },
  consent(event) {if (!this.data.busy) {this.changed(); this.setData({consent: event.detail.value.length > 0});}},
  policyChange(event) {if (!this.data.busy) {this.changed(); this.setData({policy: event.detail.value.length > 0});}},
  hongKongChange(event) {if (!this.data.busy) {this.changed(); this.setData({hongKong: event.detail.value.length > 0});}},
  async openLegal(event) {
    try {await openPublicDocument('/legal/' + event.currentTarget.dataset.id + '/document', 'pdf',this);}
    catch (e) {if (!this._disposed) this.setData({error: e.message});}
  },
  move(event) {
    if (this.data.busy || !this.data.survey) return;
    const next = this.data.section + Number(event.currentTarget.dataset.step);
    if (next < 1 || next > this.data.survey.sections.length) return;
    this.setData({section: next}); this.showSection();
  },
  async chooseFile(){
    if(this.data.busy||this.data.receipt||this.data.showPrivacy||!this.data.survey?.attachment)return;
    if(!wx.chooseMessageFile){this.setData({error:'请在手机微信中选择PDF'});return;}
    const generation=this._generation,stamp=sessionStamp(),current=()=>!this._disposed&&generation===this._generation&&isCurrentSession(stamp);
    this.setData({busy:true,error:''});
    try{if(wx.getPrivacySetting){const privacy=await new Promise((resolve,reject)=>wx.getPrivacySetting({success:resolve,fail:reject}));if(!current())return;if(typeof privacy.needAuthorization!=='boolean')throw new Error('隐私授权状态读取失败，请重试');if(privacy.needAuthorization){this.setData({showPrivacy:true,busy:false,privacyContractName:privacy.privacyContractName||this.data.privacyContractName});return;}}if(current())this.selectFile();}
    catch(e){if(current())this.setData({busy:false,error:e.message||'未能读取文件授权，请重试'});}
  },
  agreeFilePrivacy(){if(!this.data.showPrivacy||this.data.busy)return;this.setData({showPrivacy:false,busy:true});this.selectFile();},
  cancelFilePrivacy(){this.setData({showPrivacy:false,busy:false});},
  openFilePrivacy(){if(wx.openPrivacyContract)wx.openPrivacyContract({});},
  selectFile(){const generation=this._generation,stamp=sessionStamp(),current=()=>!this._disposed&&generation===this._generation&&isCurrentSession(stamp);
    wx.chooseMessageFile({count:1,type:'file',extension:['pdf'],success:r=>{if(!current())return;const f=r.tempFiles&&r.tempFiles[0],error=fileError(f);if(error){this.setData({error});return;}this.changed();this._file={name:f.name,path:f.path,size:f.size};this.setData({file:{name:f.name,sizeLabel:(f.size/1024).toFixed(1)+' KB'},error:''});},fail:e=>{if(current()&&!/cancel/i.test(e.errMsg||''))this.setData({error:'请先把PDF保存到微信聊天，再重新选择'});},complete:()=>{if(current())this.setData({busy:false});}});
  },
  removeFile(){if(this.data.busy||this.data.receipt)return;this.changed();this._file=null;this.setData({file:null,error:''});},
  async submit() {
    if (this.data.busy || this.data.receipt || this.data.showPrivacy || !this.data.survey) return;
    const missing = this.data.survey.fields.find(f => f.required && !(typeof this.data.answers[f.id] === 'string' ? this.data.answers[f.id].trim() : this.data.answers[f.id] || []).length);
    if (missing) {this.setData({section: missing.section, error: '请填写第' + missing.number + '题：' + missing.label}); this.showSection(); return;}
    if (this.data.survey.requireAnswer && !Object.values(this.data.answers).some(v => typeof v === 'string' ? v.trim().length : v.length)) {
      this.setData({error: '请至少填写一项反馈后提交'}); return;
    }
    if (!this.data.consent) {this.setData({error: '请确认问卷信息用途'}); return;}
    let legal;
    try {legal = legalConsent(this.data);} catch (e) {this.setData({error: e.message}); return;}
    const generation=this._generation,stamp=sessionStamp(),current=()=>!this._disposed&&generation===this._generation&&(!this.data.survey?.general||isCurrentSession(stamp));
    this.setData({busy: true, error: ''}); this._submitted = true;
    try {
      const result = await submitSurvey(this.data.side, {version: this.data.survey.version, answers: this.data.answers, consent: true, legalConsent: legal}, this._file, this._key, progress=>{if(current())this.setData({progress});},current);
      if(current()){if(typeof result?.receipt?.id!=='string'||!result.receipt.id)throw new Error('未取得有效回执，请重试');this._file=null;this.setData({receipt: result.receipt.id, answers: {}, fields: [],file:null});}
    } catch (err) {if(current()) this.setData({error: err.message + '。原填写内容保留，可重试。'});}
    finally {if(current()) this.setData({busy: false,progress:null});}
  }
});
