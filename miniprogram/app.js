const { captureReferral } = require('./utils/api');
App({
  onLaunch(options) { captureReferral(options && options.query); },
  onShow(options) { captureReferral(options && options.query); },
  globalData: {
    pendingServiceId: null
  }
});
