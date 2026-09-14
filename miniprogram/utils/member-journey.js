const { plans } = require('../data/content');
function memberJourney(membership, orders) {
  const ordered = (orders || []).slice().sort((a,b) => String(b.createdAt).localeCompare(String(a.createdAt)));
  const order = ordered.find(o => ['review','pending','rejected'].includes(o.status));
  if (membership && membership.active) return { title: (plans.find(p=>p.id===membership.planId)||{}).name || '有效会员', note: '会籍有效，前往查看当前可用的服务。', action: '使用我的权益', kind: 'services' };
  if (order) {
    const states = { review: ['资质审核中','预报名已收到，待审核。本期暂不收费或开通会籍。','查看申请进度'], pending: ['订单待付款','订单已保存，付款暂未开放。你可以查看费用和审核结果。','查看订单进度'], rejected: ['申请未通过','查看审核说明，核对资料后再申请。','查看原因与下一步'] };
    const state=states[order.status]; return { title: state[0], note: state[1], action: state[2], kind:'order', id:order.id };
  }
  return membership ? { title:'会籍已到期',note:'原申请与订单记录保留。续费办理尚未开放，可先查看说明或反馈问题。',action:'查看会籍说明',kind:'members' }
    : { title:'尚未入会',note:'先了解各类会籍的适用对象、年费和权益，再选择适合自己的方案。',action:'选择适合的会籍',kind:'members' };
}
module.exports = { memberJourney };
