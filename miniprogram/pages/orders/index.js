const { returnToPrevious } = require('../../utils/navigation');
const { api, hasSession, sessionStamp, isCurrentSession, money, statusLabels } = require('../../utils/api');
const { plans } = require('../../data/content');

function sessionExpired(error) { return error && (error.status === 401 || error.statusCode === 401); }
function dateLabel(value) { return value ? new Date(value).toLocaleString() : ''; }
function formatOrder(order) {
  const plan = plans.find(item => item.id === order.planId);
  return Object.assign({}, order, {
    planName: plan ? plan.name : '会员订单', amountLabel: money(order.amountCents),
    actualPaidLabel: order.actualPaidCents === null || order.actualPaidCents === undefined ? '' : money(order.actualPaidCents),
    statusLabel: statusLabels[order.status] || order.status, createdLabel: dateLabel(order.createdAt),
    paidLabel: dateLabel(order.paidAt), expiryLabel: dateLabel(order.expiresAt), reviewedLabel: dateLabel(order.reviewedAt),
    canCancel: ['pending', 'review'].includes(order.status)
  });
}

Page({
  onPageScroll(event) { if(!this.data.loading && !this._restoringScroll) this._scrollTop=event.scrollTop; },
  restoreListPosition() { if(!this.data.detailMode && wx.nextTick && this._scrollTop) { this._restoringScroll=true;wx.nextTick(()=>{ if(!this._unloaded)wx.pageScrollTo({scrollTop:this._scrollTop,duration:0});this._restoringScroll=false; }); } },
  data: { detailMode: false, moreOpen: false, loggedIn: false, orders: [], selectedId: '', selectedOrder: null, loading: false, detailLoading: false, busy: false, error: '', message: '' },
  onLoad(options) { this.setData({ detailMode: !!options.id, selectedId: options.id || '' }); },
  async onPullDownRefresh() { try { await this.refreshOrders(); } finally { wx.stopPullDownRefresh(); } },
  openOrder(event) {
    if (this.data.loading || !this._orderStamp || !isCurrentSession(this._orderStamp)) return;
    const id=event.currentTarget.dataset.orderId;
    if (this.data.orders.some(item=>item.id===id)) wx.navigateTo({url:'/pages/orders/index?id='+encodeURIComponent(id)});
  },
  reapply() {
    const order = this.data.selectedOrder;
    if (this.data.busy || this.data.loading || !order || order.status !== 'rejected' || !this._orderStamp || !isCurrentSession(this._orderStamp)) return;
    wx.navigateTo({ url: '/pages/join/index?planId=' + encodeURIComponent(order.planId) + '&reapplyId=' + encodeURIComponent(order.id) });
  },
  toggleMore() { this.setData({ moreOpen: !this.data.moreOpen }); },
  openHelp() { if (this.data.selectedOrder && this._orderStamp && isCurrentSession(this._orderStamp)) wx.navigateTo({url:'/pages/feedback/index?mode=new&relatedOrderId='+encodeURIComponent(this.data.selectedOrder.id)}); },
  backToRecords() { returnToPrevious(this,'/pages/orders/index'); },
  onUnload() { this._unloaded = true; },
  onShow() { this.refreshOrders(); },
  clearOrders() {
    this._orderStamp = null;
    this.setData({ loggedIn: hasSession(), orders: [], selectedId: '', selectedOrder: null, message: '' });
  },
  assertContext(stamp) {
    if (this._unloaded || !hasSession() || !stamp || !isCurrentSession(stamp)) {
      throw Object.assign(new Error('登录状态已变化，请重新读取订单。'), { code: 'CONTEXT_CHANGED' });
    }
  },
  showFailure(error, fallback) {
    if (this._unloaded) return;
    if (sessionExpired(error) || error.code === 'CONTEXT_CHANGED') this.clearOrders();
    this.setData({ error: sessionExpired(error) ? '登录已过期，请重新登录后查看订单。' : (error.message || fallback) });
  },
  async refreshOrders() {
    if (this._unloaded) return;
    if (this._orderStamp && !isCurrentSession(this._orderStamp)) this.clearOrders();
    if (this.data.loading || this.data.detailLoading || this.data.busy) return;
    if (!hasSession()) {
      this.clearOrders(); return;
    }
    const stamp = sessionStamp();
    this._orderStamp = stamp;
    this.setData({ loggedIn: true, loading: true, error: '', message: '', orders: [], selectedOrder: null });
    try {
      const response = await api('/orders');
      this.assertContext(stamp);
      this.setData({ orders: response.orders.map(formatOrder) });
      this.restoreListPosition();
      if (this.data.selectedId) {
        const detail = await api('/orders/' + encodeURIComponent(this.data.selectedId));
        this.assertContext(stamp);
        this.setData({ selectedOrder: formatOrder(detail.order) });
      }
    } catch (error) {
      this.showFailure(error, '暂时无法读取订单，请重试。');
    } finally { if (!this._unloaded) this.setData({ loading: false }); }
  },
  async toggleOrder(event) {
    if (this.data.loading || this.data.detailLoading || this.data.busy) return;
    const id = event.currentTarget.dataset.orderId;
    if (id === this.data.selectedId && this.data.selectedOrder) {
      this.setData({ selectedId: '', selectedOrder: null, error: '', message: '' }); return;
    }
    this.setData({ selectedId: id, selectedOrder: null, detailLoading: true, error: '', message: '' });
    const stamp = this._orderStamp;
    try {
      this.assertContext(stamp);
      const response = await api('/orders/' + encodeURIComponent(id));
      this.assertContext(stamp);
      this.setData({ selectedOrder: formatOrder(response.order) });
      wx.pageScrollTo({ scrollTop: 0, duration: 200 });
    } catch (error) { this.showFailure(error, '暂时无法读取订单详情，请重试。'); }
    finally { if (!this._unloaded) this.setData({ detailLoading: false }); }
  },
  closeDetail() {
    if (!this.data.busy && !this.data.loading && !this.data.detailLoading) this.setData({ selectedId: '', selectedOrder: null, error: '', message: '' });
  },
  async cancelOrder() {
    const order = this.data.selectedOrder;
    if (!order || !order.canCancel || this.data.busy || this.data.loading || this.data.detailLoading) return;
    this.setData({ busy: true, error: '', message: '' });
    const stamp = this._orderStamp;
    let sent = false;
    try {
      this.assertContext(stamp);
      const decision = await new Promise((resolve, reject) => wx.showModal({
        title: '确认取消这笔订单？', content: '取消后可重新选择会员方案，原申请与订单记录仍会保留。',
        confirmText: '取消订单', cancelText: '保留订单', confirmColor: '#164c3d', success: resolve, fail: reject
      }));
      if (!decision.confirm) return;
      this.assertContext(stamp);
      sent = true;
      const response = await api('/orders/' + encodeURIComponent(order.id) + '/cancel', {});
      this.assertContext(stamp);
      const updated = formatOrder(response.order);
      this.setData({ selectedOrder: updated, orders: this.data.orders.map(item => item.id === updated.id ? updated : item), message: '订单已取消，原记录已保留。' });
    } catch (error) {
      this.showFailure(error, '取消未完成，请刷新订单状态后重试。');
      if (!this._unloaded && sent && isCurrentSession(stamp) && (error.status === undefined || error.status >= 500)) {
        this.setData({ orders: [], selectedOrder: null, message: '',
          error: '取消请求已发出，但结果暂未确认。请刷新订单状态后再操作。' });
      }
    }
    finally { if (!this._unloaded) this.setData({ busy: false }); }
  },
  openLogin() { wx.navigateTo({ url: '/pages/login/index' }); },
  openMembers() { wx.navigateTo({ url: '/pages/members/index' }); }
});
