const { returnToPrevious } = require('../../utils/navigation');
const { api, hasSession, clearSession, sessionStamp, isCurrentSession, newKey } = require('../../utils/api');
const drafts = require('../../utils/drafts');

const labels = { pending: '待审核', published: '已发表', rejected: '未通过' };
function formatPost(post) {
  return Object.assign({}, post, { statusLabel: labels[post.status] || post.status,
    createdLabel: post.createdAt ? new Date(post.createdAt).toLocaleString() : '',
    reviewedLabel: post.reviewedAt ? new Date(post.reviewedAt).toLocaleString() : '' });
}
function blankDraft() { return { title: '', body: '' }; }

Page({
  onPageScroll(event) { if(!this.data.loading && !this._restoringScroll) this._scrollTop=event.scrollTop; },
  restoreListPosition() { if(this.data.mode==='list' && wx.nextTick && this._scrollTop) { this._restoringScroll=true;wx.nextTick(()=>{ if(!this._unloaded)wx.pageScrollTo({scrollTop:this._scrollTop,duration:0});this._restoringScroll=false; }); } },
  data: { mode: 'list', loggedIn: false, ready: false, canSubmit: false, loading: false, busy: false,
    posts: [], selectedId: '', selectedPost: null, title: '', body: '', error: '', message: '', accessNote: '', draftNote: '' },
  onLoad(options = {}) { this._draft = blankDraft(); this._detailId=options.id || '';this.setData({mode:['new','detail'].includes(options.mode)?options.mode:'list',selectedId:this._detailId}); },
  newPost() { wx.navigateTo({url:'/pages/posts/index?mode=new'}); },
  navigatePost(event) {
    if(this.data.busy || this.data.loading || !this._viewStamp || !isCurrentSession(this._viewStamp))return;
    const id=event.currentTarget.dataset.postId;if(this.data.posts.some(p=>p.id===id))wx.navigateTo({url:'/pages/posts/index?mode=detail&id='+encodeURIComponent(id)});
  },
  backToList() { returnToPrevious(this,'/pages/posts/index'); },
  async onPullDownRefresh() { try { await this.refreshPosts(); } finally { wx.stopPullDownRefresh(); } },
  onShow() { this._hidden=false;return this.refreshPosts(); },
  onHide() { this._hidden=true;this.clearView(); },
  onUnload() { this._unloaded = true; this._draft = blankDraft(); },
  assertContext(stamp) {
    if (this._unloaded || this._hidden || !hasSession() || !isCurrentSession(stamp)) {
      throw Object.assign(new Error('登录状态已变化，请重新读取稿件。'), { code: 'CONTEXT_CHANGED' });
    }
  },
  clearView() {
    this._viewStamp = null;
    this.setData({ loggedIn: hasSession(), ready: false, canSubmit: false, posts: [], selectedId: '',
      selectedPost: null, title: '', body: '', message: '', accessNote: '' });
  },
  acceptMember(session, stamp) {
    this.assertContext(stamp);
    if (!session.user) {
      clearSession();
      throw Object.assign(new Error('请重新登录后查看稿件。'), { status: 401 });
    }
    const changed = this._owner && (this._owner !== session.user.id || this._scope !== stamp.scope);
    if (changed) { this._draft = blankDraft(); this._key = ''; this._payload = ''; }
    this._owner = session.user.id; this._scope = stamp.scope;
    const ownerKey = stamp.scope + ':' + session.user.id;
    if (this.data.mode === 'new' && this._draftLoadedFor !== ownerKey) {
      this._draftLoadedFor = ownerKey;
      const saved = drafts.read(stamp.scope, session.user.id, 'post:new');
      if (saved) { this._draft = saved.form; this._key = saved.key || ''; this._payload = saved.payload || '';
        this.setData({ draftNote: '已恢复本机草稿，可继续编辑。' }); }
    }
    const canSubmit = session.user.role === 'member' && !!(session.membership && session.membership.active);
    this.setData({ loggedIn: true, canSubmit, title: this._draft.title, body: this._draft.body,
      accessNote: canSubmit ? '' : '投稿需要有效会籍。你仍可以查看自己的历史稿件和审核结果。' });
    return !changed;
  },
  showFailure(error) {
    if (this._unloaded) return;
    if (error.status === 401 || error.code === 'CONTEXT_CHANGED') this.clearView();
    this.setData({ error: error.status === 401 ? '登录已过期，请重新登录。未提交文字仍保留在当前页面。' : error.message || '暂时无法读取稿件，请重试。' });
  },
  async refreshPosts() {
    if (this._unloaded) return;
    if (this._viewStamp && !isCurrentSession(this._viewStamp)) this.clearView();
    if (this.data.loading || this.data.busy) return;
    const selectedId = this.data.mode==='detail' ? this._detailId : this.data.selectedId;
    this.clearView();
    this.setData({ error: '' });
    if (!hasSession()) return;
    const stamp = sessionStamp();
    this.setData({ loading: true });
    try {
      const sameOwner = this.acceptMember(await api('/me'), stamp);
      const response = await api('/posts');
      this.assertContext(stamp);
      const posts = response.posts.map(formatPost);
      const selectedPost = sameOwner ? posts.find(post => post.id === selectedId) || null : null;
      if(this.data.mode==='detail'&&!selectedPost)throw new Error('没有找到此稿件，请返回我的稿件列表。');
      this._viewStamp = stamp;
      this.setData({ ready: true, posts, selectedId: selectedPost ? selectedPost.id : '', selectedPost });
      this.restoreListPosition();
    } catch (error) { if (!this._unloaded) this.clearView(); this.showFailure(error); }
    finally { if (!this._unloaded) this.setData({ loading: false }); }
  },
  saveDraft() {
    if (this.data.mode !== 'new' || !this._viewStamp || !hasSession() || !isCurrentSession(this._viewStamp)) return;
    const saved = drafts.write(this._scope, this._owner, 'post:new', { form: this._draft, key: this._key, payload: this._payload });
    this.setData({ draftNote: saved ? '草稿已保存在本机，24 小时内可继续；退出账号会清除。' : '本机暂时无法保存草稿，请保持当前页面。' });
  },
  changeField(event) {
    if (this.data.busy || this.data.loading || !this.data.ready || !this.data.canSubmit) return;
    if (!this._viewStamp || !isCurrentSession(this._viewStamp) || !hasSession()) {
      this.clearView(); this.setData({ error: '登录状态已变化，请刷新后继续。' }); return;
    }
    const field = event.currentTarget.dataset.field;
    if (!['title', 'body'].includes(field)) return;
    this._draft[field] = event.detail.value;
    this.setData({ [field]: event.detail.value, error: '', message: '' });
    this.saveDraft();
  },
  togglePost(event) {
    if (this.data.loading || this.data.busy) return;
    if (!this._viewStamp || !isCurrentSession(this._viewStamp) || !hasSession()) {
      this.clearView(); this.setData({ error: '登录状态已变化，请刷新后查看。' }); return;
    }
    const id = event.currentTarget.dataset.postId;
    const post = this.data.posts.find(item => item.id === id);
    const selectedPost = post && this.data.selectedId !== id ? post : null;
    this.setData({ selectedId: selectedPost ? selectedPost.id : '', selectedPost });
  },
  async submit() {
    if (this._unloaded || this.data.busy || this.data.loading || !this.data.ready || !this.data.canSubmit) return;
    const stamp = this._viewStamp;
    this.setData({ busy: true, error: '', message: '' });
    try {
      if (!stamp) throw new Error('请先刷新稿件信息。');
      this.assertContext(stamp);
      const payload = { title: this._draft.title.trim(), body: this._draft.body.trim() };
      if (!payload.title || payload.title.length > 60 || !payload.body || payload.body.length > 2000) {
        throw new Error('请填写标题（最多 60 字）和正文（最多 2000 字）。');
      }
      const serialized = JSON.stringify(payload);
      if (!this._key || this._payload !== serialized) { this._key = newKey(); this._payload = serialized; }
      this.saveDraft();
      if (!this.acceptMember(await api('/me'), stamp)) throw new Error('账号已变化，请重新填写稿件。');
      if (!this.data.canSubmit) throw new Error('当前会籍不具备投稿权限，未提交文字仍保留在本页。');
      const response = await api('/posts', payload, this._key);
      this.assertContext(stamp);
      const post = formatPost(response.post);
      drafts.write(this._scope, this._owner, 'post:new', null);
      this._draft = blankDraft(); this._key = ''; this._payload = '';
      this.setData({ title: '', body: '', posts: [post].concat(this.data.posts.filter(item => item.id !== post.id)),
        selectedId: post.id, selectedPost: post, message: '稿件已保存，可在下方查看审核状态。' });
      if(this.data.mode==='new')wx.redirectTo({url:'/pages/posts/index?mode=detail&id='+encodeURIComponent(post.id),fail:()=>{this._detailId=post.id;this.setData({mode:'detail'});}});
    } catch (error) { this.showFailure(error); }
    finally { if (!this._unloaded) this.setData({ busy: false }); }
  },
  openLogin() { wx.navigateTo({ url: '/pages/login/index' }); },
  openMembers() { wx.navigateTo({ url: '/pages/members/index' }); }
});
