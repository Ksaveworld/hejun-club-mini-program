const { plans, testNotice } = require('../../data/content');
const { captureReferral, hasSession } = require('../../utils/api');

Page({
  onLoad(options) { captureReferral(options); },
  data: { plans, testNotice },
  openPlan(event) {
    const plan = plans.find(item => item.id === event.currentTarget.dataset.planId);
    if (!plan) return;
    wx.navigateTo({ url: (hasSession() ? '/pages/join/index?planId=' : '/pages/login/index?planId=') + plan.id });
  },
  openServices() {
    getApp().globalData.pendingServiceId = null;
    wx.switchTab({ url: '/pages/services/index' });
  }
});
