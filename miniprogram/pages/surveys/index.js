const { api, newKey } = require('../../utils/api');
Page({
  data: { side: '', survey: null, section: 1, fields: [], answers: {}, consent: false, busy: false, error: '', receipt: '' },
  onLoad(query) { if (['supply', 'demand'].includes(query.side)) this.loadSurvey(query.side); },
  choose(event) { this.loadSurvey(event.currentTarget.dataset.side); },
  async loadSurvey(side) {
    this._key = newKey(); this._submitted = false;
    this.setData({ side, survey: null, section: 1, answers: {}, consent: false, receipt: '', error: '', busy: true });
    try { const result = await api('/surveys/' + side); this.setData({ survey: result.survey }); this.showSection(); }
    catch (err) { this.setData({ error: err.message }); }
    finally { this.setData({ busy: false }); }
  },
  showSection() {
    this.setData({ fields: this.data.survey.fields.filter(f => f.section === this.data.section).map(f => ({ ...f,
      label: f.label + (f.enLabel ? '\n' + f.enLabel : ''),
      value: this.data.answers[f.id] || '', note: this.data.answers[f.id + 'Note'] || '',
      choices: f.options.map((value, index) => ({ value, label: value + (f.enOptions && f.enOptions[index] ? '\n' + f.enOptions[index] : ''), checked: f.type === 'multi' ? (this.data.answers[f.id] || []).includes(value) : this.data.answers[f.id] === value }))
    })) });
    wx.pageScrollTo({ scrollTop: 0, duration: 0 });
  },
  change(event) {
    if (this.data.busy) return;
    if (this._submitted) { this._key = newKey(); this._submitted = false; }
    this.setData({ ['answers.' + event.currentTarget.dataset.id]: event.detail.value, error: '' });
  },
  consent(event) { this.setData({ consent: event.detail.value.length > 0 }); },
  move(event) {
    const next = this.data.section + Number(event.currentTarget.dataset.step);
    if (next < 1 || next > this.data.survey.sections.length) return;
    this.setData({ section: next }); this.showSection();
  },
  async submit() {
    if (this.data.busy || this.data.receipt) return;
    const missing = this.data.survey.fields.find(f => f.required && !(this.data.answers[f.id] || []).length);
    if (missing) { this.setData({ section: missing.section, error: '请填写第' + missing.number + '题' }); this.showSection(); return; }
    if (!this.data.consent) { this.setData({ error: '请同意将信息用于对接撮合与活动安排' }); return; }
    this.setData({ busy: true, error: '' }); this._submitted = true;
    try {
      const result = await api('/surveys/' + this.data.side, { version: this.data.survey.version, answers: this.data.answers, consent: true }, this._key);
      this.setData({ receipt: result.receipt.id, answers: {}, fields: [] });
    } catch (err) { this.setData({ error: err.message + '。原填写内容保留，可重试。' }); }
    finally { this.setData({ busy: false }); }
  }
});
