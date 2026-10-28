// Customer-confirmed source: 中国—东盟跨境企业家俱乐部 · 专属服务联系人（经贸中心已确认）.docx.
// Server-only source. Public projections must explicitly omit phone numbers.
const contacts = Object.freeze([
  { role: '企业出海顾问', name: '罗轶青', phone: '13801870762' },
  { role: '园区咨询顾问', name: '陈卓', phone: '13558119874' },
  { role: '跨境金融顾问', name: '白金玲', phone: '15502170129' },
  { role: '会员账号咨询', name: '叶文婷', phone: '13517811011' }
].map(Object.freeze));

export function exclusiveContactsForMembership(membership, now = Date.now()) {
  const starts = Date.parse(membership?.startsAt), expires = Date.parse(membership?.expiresAt);
  if (membership?.planId !== 'star' || membership.active !== true || !Number.isFinite(starts)
      || !Number.isFinite(expires) || starts > now || expires <= now) {
    const error = new Error('专属服务联系人仅向有效星级会员开放。');
    error.status = 403;
    throw error;
  }
  return { title: '专属服务联系人', serviceTime: '工作日 9:00—18:00',
    notice: '请根据具体需求联系对应顾问。如遇紧急情况，可微信留言，工作人员会尽快回复。',
    expiresAt: membership.expiresAt, contacts: contacts.map(contact => ({ ...contact })) };
}

export function publicServicePeople() {
  return {title:"专属服务人员",contacts:contacts.map(({name,role})=>({name,role}))};
}
