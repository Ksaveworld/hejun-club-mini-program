const {api} = require('./api');
async function loadLegal() {return (await api('/legal')).release;}
function legalConsent(data) {
  if (!data.legalReady) throw new Error('请先读取当前协议后再提交');
  if (!data.legal) return undefined;
  if (!data.policy) throw new Error('请阅读并同意当前协议');
  if (data.legal.requireHongKongConsent !== false && !data.hongKong) throw new Error('请单独确认香港存储安排');
  return {accepted: true, hongKongAccepted: data.hongKong===true, releaseId: data.legal.id};
}
module.exports = {loadLegal, legalConsent};
