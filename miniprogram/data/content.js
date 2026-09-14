// Presentation text is shared in meaning with src/data.ts; business prices come from the API.
const testNotice = '本机业务内测，请使用虚构资料。申请和订单可保存，微信支付未接通，不会收款或开通会员。';

const plans = [
  {
    id: 'basic', name: '基础会员', english: 'ESSENTIAL', priceLabel: '365',
    summary: '从日常资讯与知识工具开始，了解跨境经营。',
    audience: '希望持续了解跨境市场的企业家与从业者',
    benefits: ['翻译服务', '跨境大讲堂', '跨境知识库', '产品与服务名录', '行业资讯'],
    rule: '付款成功后开通，无需资质预审。'
  },
  {
    id: 'star', name: '星级会员', english: 'PREMIER', priceLabel: '3,650',
    summary: '在基础权益之上，深入交流、学习与参访。',
    audience: '有跨境业务拓展与交流需求的企业家',
    benefits: ['包含基础会员权益', '线下交流活动', '课程回放', '游学与参访', '相关服务折扣'],
    rule: '付款成功后开通，无需资质预审。'
  },
  {
    id: 'organization', name: '机构及专业会员', english: 'PARTNER', priceLabel: '36,500',
    summary: '展示专业服务，参与俱乐部的资源交流与品牌活动。',
    audience: '商协会、产业园区及跨境专业服务机构',
    benefits: ['包含星级会员全部权益', '机构与专业服务名录', '路演与项目展示', '品牌展示与传播', '资源交流与合作对接'],
    rule: '先审核资质，再付款；付款成功后开通。'
  }
];

const services = [
  {
    id: 'translation', title: '翻译服务', category: '沟通工具', summary: '为跨语言沟通提供辅助。',
    detail: '会员资料列有翻译权益。支持的语言、使用次数与服务方式，需随正式服务入口一并确认。',
    availability: '待提供正式入口及使用说明'
  },
  {
    id: 'lectures', title: '跨境大讲堂', category: '学习交流', summary: '围绕跨境经营开展主题分享。',
    detail: '通过大讲堂了解跨境经营话题。具体讲师、主题与开课时间，以运营发布的正式安排为准。',
    availability: '待提供课程内容及观看入口'
  },
  {
    id: 'knowledge', title: '跨境知识库', category: '知识资料', summary: '集中查阅跨境业务相关资料。',
    detail: '会员可按正式开放范围查阅知识资料。首批内容、分类与不同等级的访问范围，待运营配置。',
    availability: '待提供首批资料及访问入口'
  },
  {
    id: 'directory', title: '产品与服务名录', category: '资源发现', summary: '了解企业产品与专业服务。',
    detail: '名录用于展示审核通过的企业、产品或专业服务信息。当前尚未录入正式名录，展示字段与收录流程待确认。',
    availability: '待提供正式名录及收录规则'
  },
  {
    id: 'insights', title: '行业资讯', category: '市场观察', summary: '关注跨境市场与行业动态。',
    detail: '由运营整理并发布跨境资讯。正式内容应附来源与发布时间，当前页面的会员指南仅用于介绍产品流程。',
    availability: '待提供首批正式资讯'
  },
  {
    id: 'visits', title: '交流与参访', category: '星级权益', summary: '通过线下交流与参访拓展业务视野。',
    detail: '星级会员资料列有线下交流、游学参访等权益。活动时间、名额、额外费用与参与条件，以每次正式活动说明为准。',
    availability: '待提供活动安排及服务说明'
  }
];

module.exports = { testNotice, plans, services };
