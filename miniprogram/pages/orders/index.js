const { returnToPrevious } = require('../../utils/navigation');
const { api, hasSession, sessionStamp, isCurrentSession, money, statusLabels } = require('../../utils/api');
const { orderMembership, orderAftercare, memberNextStep } = require('../../utils/membership-display');
const { chineseDateTime } = require('../../utils/display-time');

const reconciliationMessage = '已收到付款，需人工核对，请勿重复付款';
function needsReconciliation(order) { return order?.paymentReconciliationRequired === true || order?.cancellation?.paymentReconciliationRequired === true; }
function sessionExpired(error) { return error && (error.status === 401 || error.statusCode === 401); }
function dateLabel(value) { return value ? chineseDateTime(value) : ''; }
function formatOrder(order) {
  return Object.assign({}, order, orderMembership(order), orderAftercare(order), {
    amountLabel: money(order.amountCents),
    paymentReconciliationRequired: needsReconciliation(order),
    hasMemberNextStep: orderAftercare(order).hasMemberNextStep && !needsReconciliation(order),
    refundCompletedLabel: dateLabel(order.aftercare?.refundCompletedAt),
    actualPaidLabel: order.actualPaidCents === null || order.actualPaidCents === undefined ? '' : money(order.actualPaidCents),
    statusLabel: needsReconciliation(order) ? reconciliationMessage : statusLabels[order.status] || order.status, createdLabel: chineseDateTime(order.createdAt),
    paidLabel: dateLabel(order.paidAt), expiryLabel: dateLabel(order.expiresAt), reviewedLabel: dateLabel(order.reviewedAt),
    canCancel: !needsReconciliation(order) && ['pending', 'review'].includes(order.status)
  });
}

Page({
  onPageScroll(event) { if(!this.data.loading && !this._restoringScroll) this._scrollTop=event.scrollTop; },
  restoreListPosition() { if(!this.data.detailMode && wx.nextTick && this._scrollTop) { this._restoringScroll=true;wx.nextTick(()=>{ if(!this._unloaded)wx.pageScrollTo({scrollTop:this._scrollTop,duration:0});this._restoringScroll=false; }); } },
  data: { memberNextStep, detailMode: false, moreOpen: false, loggedIn: false, orders: [], selectedId: '', selectedOrder: null, loading: false, detailLoading: false, busy: false, cancelUncertain: false, error: '', message: '' },
  onLoad(options) { this._routeOrderId = options.id || ''; this.setData({ detailMode: !!this._routeOrderId, selectedId: this._routeOrderId }); },
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
  openPayment(){if(!this.data.cancelUncertain && !this.data.busy && !this.data.loading && ['pending','paid'].includes(this.data.selectedOrder?.status) && !needsReconciliation(this.data.selectedOrder) && this._orderStamp && isCurrentSession(this._orderStamp))wx.navigateTo({url:'/pages/payment/index?id='+encodeURIComponent(this.data.selectedOrder.id)});},
  openEnterprise(){if(this.data.selectedOrder?.hasMemberNextStep && hasSession() && this._orderStamp && isCurrentSession(this._orderStamp))wx.navigateTo({url:'/pages/enterprise-intake/index'});},
  backToRecords() { returnToPrevious(this,'/pages/orders/index'); },
  onUnload() { this._unloaded = true; },
  onShow() { this.refreshOrders(); },
  clearOrders() {
    this._orderStamp = null;
    // Keep the public route ID so returning from login can reread the same
    // order. Contact data and actions stay empty until the server authorizes it.
    this.setData({ loggedIn: hasSession(), orders: [], selectedId: this.data.detailMode ? this._routeOrderId || '' : '', selectedOrder: null, cancelUncertain: false, message: '' });
  },
  assertContext(stamp) {
    if (this._unloaded || !hasSession() || !stamp || !isCurrentSession(stamp)) {
      throw Object.assign(new Error('登录状态已变化，请重新读取订单。'), { code: 'CONTEXT_CHANGED' });
    }
  },
  showFailure(error, fallback) {
    if (this._unloaded) return;
    const expired = sessionExpired(error) || !hasSession();
    if (expired || error.code === 'CONTEXT_CHANGED') this.clearOrders();
    this.setData({ error: expired ? '登录已过期，请重新登录后查看订单。' : (error.message || fallback) });
  },
  async refreshOrders() {
    if (this._unloaded) return;
    if (this._orderStamp && !isCurrentSession(this._orderStamp)) this.clearOrders();
    if (this.data.loading || this.data.detailLoading || this.data.busy) return;
    if (!hasSession()) {
      this.clearOrders(); return;
    }
    const stamp = sessionStamp();
    const uncertainSnapshot = this.data.cancelUncertain ? { orders: this.data.orders, selectedOrder: this.data.selectedOrder } : null;
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
      this.setData({ cancelUncertain: false });
    } catch (error) {
      this.showFailure(error, '暂时无法读取订单，请重试。');
      if (uncertainSnapshot && !this._unloaded && hasSession() && isCurrentSession(stamp) && error.code !== 'CONTEXT_CHANGED'
        && (error.status === undefined || error.status >= 500)) {
        this.setData({ ...uncertainSnapshot, cancelUncertain: true, error: '订单状态暂时读取失败，取消结果仍未确认。请稍后刷新；以下为上次读取的订单。' });
      }
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
    if (!order || needsReconciliation(order) || !order.canCancel || this.data.cancelUncertain || this.data.busy || this.data.loading || this.data.detailLoading) return;
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
      const current = await api('/orders/' + encodeURIComponent(order.id));
      this.assertContext(stamp);
      const checked = formatOrder(current.order);
      this.setData({selectedOrder: checked, orders: this.data.orders.map(item => item.id === checked.id ? checked : item)});
      if (needsReconciliation(checked)) { this.setData({message: reconciliationMessage}); return; }
      if (!checked.canCancel) throw Object.assign(new Error('订单状态已变化，请刷新核对。'), {status:409});
      sent = true;
      const response = await api('/orders/' + encodeURIComponent(order.id) + '/cancel', {});
      this.assertContext(stamp);
      const updated = formatOrder(response.order);
      this.setData({ selectedOrder: updated, orders: this.data.orders.map(item => item.id === updated.id ? updated : item) });
      if (needsReconciliation(updated)) { this.setData({message: reconciliationMessage, cancelUncertain:false}); return; }
      if (updated.status !== 'cancelled') throw Object.assign(new Error('订单未取消，请核对当前订单状态。'), {status:409});
      this.setData({ selectedId: '', selectedOrder: null, moreOpen: false, cancelUncertain: false, message: '订单已取消，原记录已保留。' });
      if (this.data.detailMode) {
        this._routeOrderId = '';
        this.setData({detailMode:false});
        wx.redirectTo({url:'/pages/orders/index'});
      }
    } catch (error) {
      this.showFailure(error, '取消未完成，请刷新订单状态后重试。');
      if (!this._unloaded && sent && hasSession() && isCurrentSession(stamp) && (error.status === undefined || error.status >= 500)) {
        this.setData({ cancelUncertain: true, message: '',
          error: '取消请求已发出，但结果暂未确认。原订单已保留，请先刷新状态；核实前不要付款或再次取消。' });
      }
    }
    finally { if (!this._unloaded) this.setData({ busy: false }); }
  },
  openLogin() { wx.navigateTo({ url: '/pages/login/index' }); },
  openMembers() { wx.navigateTo({ url: '/pages/members/index' }); }
});
