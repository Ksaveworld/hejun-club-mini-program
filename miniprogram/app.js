const { captureReferral, initCloud } = require('./utils/api');
// Customer testing must not retain a debug switch enabled on a previous visit.
function closeDebugPanel() {
  try {
    if (typeof wx !== 'undefined' && typeof wx.setEnableDebug === 'function') {
      wx.setEnableDebug({ enableDebug: false, fail() {} });
    }
  } catch (_) { /* Older clients must still start normally. */ }
}
App({
  onLaunch(options) { closeDebugPanel(); if (initCloud) initCloud(); captureReferral(options && options.query); },
  onShow(options) { closeDebugPanel(); captureReferral(options && options.query); },
  globalData: {
    pendingServiceId: null
  }
});
