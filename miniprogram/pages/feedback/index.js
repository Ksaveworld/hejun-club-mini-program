const { returnToPrevious } = require('../../utils/navigation');
const { api, hasSession, sessionStamp, isCurrentSession, newKey } = require('../../utils/api');
const drafts = require('../../utils/drafts');
const labels = { open: '待受理', processing: '处理中', resolved: '处理完成' };
const format = ticket => Object.assign({}, ticket, { statusLabel: ticket.confirmedAt ? '已解决' : ticket.status === 'resolved' ? '已回复，待你确认' : labels[ticket.status], createdLabel: new Date(ticket.createdAt).toLocaleString(),
  events: (ticket.events || []).map(event => Object.assign({}, event, { authorLabel: event.authorKind === 'member_followup' ? '我的补充' : event.authorKind === 'member_confirm' ? '我已确认解决' : event.action === 'accept' ? '已受理' : '后台回复', statusLabel: labels[event.status], createdLabel: new Date(event.createdAt).toLocaleString() })) });
Page({
  onPageScroll(event) { if(!this.data.loading && !this._restoringScroll) this._scrollTop=event.scrollTop; },
  restoreListPosition() { if(this.data.mode==='list' && wx.nextTick && this._scrollTop) { this._restoringScroll=true;wx.nextTick(()=>{ if(!this._unloaded)wx.pageScrollTo({scrollTop:this._scrollTop,duration:0});this._restoringScroll=false; }); } },
  data: { mode: 'list', ticketId: '', relatedOrderId: '', followup: '', loggedIn: false, ready: false, loading: false, busy: false, title: '', body: '', category: 'other',
    categories: ['账号问题', '订单问题', '内容问题', '其他问题'], categoryIndex: 3,
    tickets: [], selected: null, nextCursor: null, error: '', message: '', draftNote: '' },
  onLoad(options = {}) { this._generation = 0; this._draft = { title: '', body: '', category: options.relatedOrderId ? 'order' : 'other', categoryIndex: options.relatedOrderId ? 1 : 3 }; this.setData({mode: ['new','detail'].includes(options.mode) ? options.mode : 'list', ticketId: options.id || '', relatedOrderId: options.relatedOrderId || ''}); },
  async onPullDownRefresh() { try { await this.refresh(); } finally { wx.stopPullDownRefresh(); } },
  newFeedback() { wx.navigateTo({url:'/pages/feedback/index?mode=new'}); },
  navigateTicket(event) {
    if (!this.data.ready || this.data.busy || !this.current(this._stamp,this._generation)) return;
    const id=event.currentTarget.dataset.id; if(this.data.tickets.some(t=>t.id===id)) wx.navigateTo({url:'/pages/feedback/index?mode=detail&id='+encodeURIComponent(id)});
  },
  backToList() { returnToPrevious(this,'/pages/feedback/index'); },
  changeFollowup(event) { if(!this.data.busy && this.data.ready && this.current(this._stamp,this._generation)) { this._replyDraft=event.detail.value; this.setData({followup:event.detail.value}); this.saveReplyDraft(); } },
  onShow() { this._visible = true; return this.refresh(); },
  onHide() { this._visible = false; this.clear(); },
  onUnload() { this._unloaded = true; this._generation++; this._draft = {}; },
  clear() {
    this._generation++; this._stamp = null;
    this.setData({ ready: false, loggedIn: hasSession(), loading: false, busy: false, title: '', body: '', followup: '', tickets: [], selected: null, nextCursor: null });
  },
  current(stamp, generation) {
    return !this._unloaded && this._visible && hasSession() && this._generation === generation && isCurrentSession(stamp);
  },
  assert(stamp, generation) { if (!this.current(stamp, generation)) throw new Error('登录状态已变化，请刷新后继续。'); },
  async identity(stamp, generation) {
    const session = await api('/me'); this.assert(stamp, generation);
    if (!session.user || session.user.role !== 'member') throw new Error('请使用会员账号登录。');
    if (this._owner && (this._owner !== session.user.id || this._scope !== stamp.scope)) {
      this._draft = { title: '', body: '', category: 'other', categoryIndex: 3 }; this._key = ''; this._payload = ''; this._replyDraft = ''; this._replyKey = ''; this._replyPayload = ''; this.setData({relatedOrderId:''});
    }
    this._owner = session.user.id; this._scope = stamp.scope;
    const ownerKey = stamp.scope + ':' + session.user.id;
    if (this.data.mode === 'new' && this._draftLoadedFor !== ownerKey) {
      this._draftLoadedFor = ownerKey;
      const saved = drafts.read(stamp.scope, session.user.id, 'feedback:new:' + this.data.relatedOrderId);
      if (saved) { this._draft = saved.form; this._key = saved.key || ''; this._payload = saved.payload || '';
        this.setData({ draftNote: '已恢复本机草稿，可继续描述问题。' }); }
    }
    if (this.data.mode === 'detail' && this._replyLoadedFor !== ownerKey + ':' + this.data.ticketId) {
      this._replyLoadedFor = ownerKey + ':' + this.data.ticketId;
      const saved = drafts.read(stamp.scope, session.user.id, 'feedback:reply:' + this.data.ticketId);
      if (saved) { this._replyDraft = saved.body || ''; this._replyKey = saved.key || ''; this._replyPayload = saved.payload || ''; }
    }
    this.setData(Object.assign({ loggedIn: true, followup: this._replyDraft || '' }, this._draft));
  },
  failure(error, generation) {
    if (this._unloaded || !this._visible || generation !== this._generation) return;
    this.clear(); this.setData({ error: error.status === 401 ? '登录已过期，请重新登录。未提交文字仍保留在当前页。' : error.message || '暂时无法读取，请重试。' });
  },
  async refresh() {
    if (this._unloaded || !this._visible || this.data.busy) return;
    this.clear(); this.setData({ error: '', message: '' }); if (!hasSession()) return;
    const stamp = sessionStamp(), generation = this._generation;
    this.setData({ loading: true });
    try {
      await this.identity(stamp, generation);
      if(this.data.mode === 'new') { this._stamp=stamp;this.setData({ready:true});return; }
      if(this.data.mode === 'detail') {
        const detail=await api('/feedback/'+encodeURIComponent(this.data.ticketId));this.assert(stamp,generation);this._stamp=stamp;this.setData({ready:true,selected:format(detail.ticket)});
        try { await api('/feedback/'+encodeURIComponent(this.data.ticketId)+'/read',{eventId:Math.max(0,...detail.ticket.events.map(e=>e.id))});this.assert(stamp,generation); } catch(error) { if(error.status===401) throw error; }
        return;
      }
      const result = await api('/feedback'); this.assert(stamp, generation);
      this._stamp = stamp; this.setData({ ready: true, tickets: result.tickets.map(format), nextCursor: result.nextCursor });
      this.restoreListPosition();
    } catch (error) { this.failure(error, generation); }
    finally { if (!this._unloaded && generation === this._generation) this.setData({ loading: false }); }
  },
  saveDraft() {
    if (this.data.mode !== 'new' || !this.current(this._stamp, this._generation)) return;
    const saved = drafts.write(this._scope, this._owner, 'feedback:new:' + this.data.relatedOrderId,
      { form: this._draft, key: this._key, payload: this._payload });
    this.setData({ draftNote: saved ? '草稿已保存在本机，24 小时内可继续；退出账号会清除。' : '本机暂时无法保存草稿，请保持当前页面。' });
  },
  changeField(event) {
    if (!this.data.ready || this.data.busy || this.data.loading) return;
    if (!this.current(this._stamp, this._generation)) { this.clear(); return; }
    const field = event.currentTarget.dataset.field; if (!['title', 'body'].includes(field)) return;
    this._draft[field] = event.detail.value; this.setData({ [field]: event.detail.value });
    this.saveDraft();
  },
  changeCategory(event) {
    if (!this.data.ready || this.data.busy || this.data.loading) return;
    if (!this.current(this._stamp, this._generation)) { this.clear(); return; }
    const index = Number(event.detail.value); if (![0, 1, 2, 3].includes(index)) return;
    this._draft.categoryIndex = index; this._draft.category = ['account', 'order', 'content', 'other'][index];
    this.setData({ categoryIndex: index, category: this._draft.category });
    this.saveDraft();
  },
  async submit() {
    if (!this.data.ready || this.data.busy || this.data.loading) return;
    const stamp = this._stamp, generation = this._generation;
    this.setData({ busy: true, error: '', message: '' });
    try {
      this.assert(stamp, generation); await this.identity(stamp, generation);
      const payload = { title: this._draft.title.trim(), body: this._draft.body.trim(), category: this._draft.category, ...(this.data.relatedOrderId ? {relatedOrderId:this.data.relatedOrderId} : {}) };
      if (!payload.title || payload.title.length > 60 || !payload.body || payload.body.length > 2000) {
        this.setData({ error: '请填写问题标题（60字内）和描述（2000字内）。' }); return;
      }
      const serialized = JSON.stringify(payload);
      if (!this._key || serialized !== this._payload) { this._key = newKey(); this._payload = serialized; }
      this.saveDraft();
      const result = await api('/feedback', payload, this._key); this.assert(stamp, generation);
      const ticket = format(result.ticket);
      drafts.write(this._scope, this._owner, 'feedback:new:' + this.data.relatedOrderId, null);
      this._draft = { title: '', body: '', category: 'other', categoryIndex: 3 }; this._key = ''; this._payload = '';
      this.setData(Object.assign({ selected: ticket, tickets: [ticket].concat(this.data.tickets.filter(t => t.id !== ticket.id)), message: '反馈已保存，可在下方查看处理进度。' }, this._draft));
      if(this.data.mode==='new') wx.redirectTo({url:'/pages/feedback/index?mode=detail&id='+encodeURIComponent(ticket.id),fail:()=>this.setData({mode:'detail',ticketId:ticket.id,message:'反馈已保存。'})});
    } catch (error) { this.failure(error, generation); }
    finally { if (!this._unloaded && generation === this._generation) this.setData({ busy: false }); }
  },
  async sendFollowup() { return this.memberAction('followup'); },
  saveReplyDraft() {
    if (!this.current(this._stamp, this._generation) || !this.data.ticketId) return;
    const saved = drafts.write(this._scope, this._owner, 'feedback:reply:' + this.data.ticketId,
      { body: this._replyDraft, key: this._replyKey, payload: this._replyPayload });
    this.setData({ draftNote: saved ? '补充说明已存为本机草稿，发送后对方才能看到。' : '本机暂时无法保存草稿，请保持当前页面。' });
  },
  async confirmResolved() {
    if(this.data.busy || !this.data.selected || !this.current(this._stamp,this._generation)) return;
    const stamp=this._stamp, generation=this._generation;
    const decision=await new Promise(resolve=>wx.showModal({title:'确认问题已解决？',content:'确认后保留全部沟通记录。如问题仍未解决，可先补充说明。',confirmText:'已解决',cancelText:'继续跟进',success:resolve,fail:()=>resolve({confirm:false})}));
    if(decision.confirm && this.current(stamp,generation)) return this.memberAction('confirm');
  },
  async memberAction(action) {
    if(this.data.busy || this.data.loading || !this.data.selected || !this.current(this._stamp,this._generation)) return;
    const selected=this.data.selected, stamp=this._stamp, generation=this._generation;
    if(action==='followup' && !this.data.followup.trim()) {this.setData({error:'请填写补充说明。'});return;}
    const body={revision:selected.revision,...(action==='followup'?{body:this.data.followup.trim()}:{})};
    const payload=JSON.stringify({id:selected.id,action,body});
    if(this._replyPayload!==payload){this._replyPayload=payload;this._replyKey=newKey();}
    if (action === 'followup') this.saveReplyDraft();
    this.setData({busy:true,error:''});
    try {
      await this.identity(stamp,generation);
      const result=await api('/feedback/'+selected.id+'/'+action,body,this._replyKey);this.assert(stamp,generation);
      drafts.write(this._scope, this._owner, 'feedback:reply:' + selected.id, null);
      this._replyDraft='';this._replyPayload='';this._replyKey='';this.setData({selected:format(result.ticket),followup:'',message:action==='confirm'?'已确认解决，沟通记录保留。':'补充说明已保存。'});
    } catch(error) {
      if(this._unloaded || !this._visible || generation!==this._generation)return;
      if(error.status===401 || !this.current(stamp,generation))this.failure(error,generation);
      else this.setData({error:error.status===409?'有新的处理记录，请下拉更新后核对，再发送补充。':error.message||'未确认保存结果，可重试；文字已保留。'});
    } finally {if(!this._unloaded && generation===this._generation)this.setData({busy:false});}
  },
  async openTicket(event) {
    if (!this.data.ready || this.data.busy || this.data.loading) return;
    const id = event.currentTarget.dataset.id; if (!this.data.tickets.some(t => t.id === id)) return;
    const stamp = this._stamp, generation = this._generation; this.setData({ busy: true, selected: null, error: '' });
    try { this.assert(stamp, generation); const result = await api('/feedback/' + id); this.assert(stamp, generation); this.setData({ selected: format(result.ticket) }); }
    catch (error) { this.failure(error, generation); }
    finally { if (!this._unloaded && generation === this._generation) this.setData({ busy: false }); }
  },
  async loadMore() {
    if (!this.data.nextCursor || !this.data.ready || this.data.busy || this.data.loading) return;
    const stamp = this._stamp, generation = this._generation; this.setData({ busy: true });
    try { this.assert(stamp, generation); const result = await api('/feedback/before/' + this.data.nextCursor); this.assert(stamp, generation);
      this.setData({ tickets: this.data.tickets.concat(result.tickets.map(format)), nextCursor: result.nextCursor }); }
    catch (error) { this.failure(error, generation); }
    finally { if (!this._unloaded && generation === this._generation) this.setData({ busy: false }); }
  },
  openLogin() { wx.navigateTo({ url: '/pages/login/index' }); }
});
