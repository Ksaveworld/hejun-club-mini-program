// Frozen FEEDBACK-001 presentation copy. Only /plans supplies current prices.
const membershipPlans = [
  {
    id: 'basic', name: '基础会员', english: 'ESSENTIAL',
    audience: '希望持续了解市场、想先展示产品的企业家与从业者。',
    benefits: ['加入会员社群，基础资源对接', '录入企业产品，获取展示机会', '跨境资讯报告，了解行业动态', '可申请一次线下活动参与机会'],
    closing: '先入圈，建立初步连接。', rule: '付款成功后开通，无需资质预审。'
  },
  {
    id: 'star', name: '星级会员', english: 'PREMIER',
    audience: '希望深度参与市场机会、精准对接匹配资源的企业家。',
    benefits: ['享受基础会员全部权益', '私享系列专题课程活动', '专属闭门活动业务对接会', '优先深度交流及出海考察', '精准匹配，引荐资源机会', '政策资本产业资源专业服务优惠'],
    closing: '深度融入，精准拿结果。', rule: '付款成功后开通，无需资质预审。'
  },
  {
    id: 'organization', name: '机构会员', english: 'PARTNER',
    audience: '商协会、服务机构、产业园区等组织型会员。',
    benefits: ['享受星级会员全部权益', '可为团队多人开通会员资格', '定制闭门交流会（按需求设计发布）', '优先获得俱乐部活动冠名、联合出品等品牌露出机会', '与俱乐部共建行业专题、发布联合报告', '专属服务团队全程跟进'],
    closing: '以机构身份，撬动整个圈层资源。', rule: '本期仅预申请，暂不收费或开通会籍。',
    serviceNote: '机构服务及团队成员资格由运营沟通核验，提交申请不自动开通。'
  }
];

function membershipPlan(id) { return membershipPlans.find(plan => plan.id === id) || null; }
function validPrice(plan) { return !!plan && Number.isSafeInteger(plan.amountCents) && plan.amountCents > 0; }
function pricedMembershipPlans(products) {
  return membershipPlans.map(copy => {
    const product = (Array.isArray(products) ? products : []).find(plan => plan.id === copy.id);
    const priceReady = validPrice(product);
    return Object.assign({}, copy, { priceReady, priceLabel: priceReady ? String(product.amountCents / 100) : '', isOrganization: copy.id === 'organization' });
  });
}

function orderMembership(order = {}) {
  // A present but unknown live ID must stay unknown, even if an older snapshot disagrees.
  const planId = order.planId || order.planSnapshot?.planId || order.planSnapshot?.id || order.snapshot?.planId || '';
  const plan = membershipPlan(planId);
  const isOrganization = plan?.id === 'organization';
  const organizationType = order.form?.organizationType;
  return { planId, planName: plan ? plan.name : '会员档位待核对', isOrganization,
    applicationTypeLabel: isOrganization ? (['机构会员', '专业会员'].includes(organizationType) ? organizationType : '机构/专业类型待核对') : '' };
}

const memberNextStep = {
  title: '会员已开通',
  introduction: '会员已开通。后续需补充企业及产品介绍，具体模板和填写要求由运营提供，便于安排产品名录录入。',
  assessment: '如当前需要企业服务，可先填写企业需求问卷；该问卷仅用于内部评估和联系，不是产品入库申请，也不会公开展示。'
};
function orderAftercare(order = {}) {
  const aftercare = order.aftercare;
  const hasAftercare = aftercare?.status === 'completed';
  const membershipTerminated = hasAftercare && aftercare.membershipDisposition === 'terminate';
  return {
    hasAftercare, membershipTerminated,
    hasMemberNextStep: order.status === 'paid' && !membershipTerminated,
    refundAmountLabel: hasAftercare && Number.isSafeInteger(aftercare.refundAmountCents) ? (aftercare.refundAmountCents / 100).toFixed(2) : '',
    aftercareMessage: !hasAftercare ? '' : membershipTerminated
      ? '退款已记录，该订单对应的会员资格已终止。报告全文按当前有效会员权限开放。'
      : '退款已记录，按核准结果保留该订单对应的会员资格，原有效期不变。'
  };
}
module.exports = { membershipPlans, membershipPlan, validPrice, pricedMembershipPlans, orderMembership, orderAftercare, memberNextStep };
