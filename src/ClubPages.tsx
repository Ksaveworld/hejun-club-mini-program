import { useState } from 'react';
import type { ReactNode } from 'react';
import { ClubIcon } from './ClubIcon';
import type { ClubIconName } from './ClubIcon';
import { plans, services, stories } from './data';
import type { Service } from './types';
import type { Session } from './api';
import { api, errorText } from './api';
import { dateLabel, money } from './store';
import { Login } from './MemberPages';
import { isPresentation } from './presentation';

const serviceIcons: Record<string, ClubIconName> = {
  translation: 'Translate', lectures: 'Slide', knowledge: 'BookOpen',
  directory: 'BuildingTwo', insights: 'NewspaperFolding', visits: 'PeoplesTwo',
};
export const serviceHref = (id: string) => id === 'directory' ? '#/directory' : `#/services/${id}`;

function Heading({ title, children, serif = false }: { title: string; children?: ReactNode; serif?: boolean }) {
  return <div className={`club-heading ${serif ? 'club-heading-serif' : ''}`}><h1 id="page-title" tabIndex={-1}>{title}</h1>{children && <p>{children}</p>}</div>;
}

function SearchField({ label, placeholder, value, onChange }: { label: string; placeholder: string; value: string; onChange: (value: string) => void }) {
  return <label className="club-search"><ClubIcon name="Search" variant="轮廓" size={22} /><input type="search" aria-label={label} placeholder={placeholder} value={value} onChange={event => onChange(event.target.value)} /></label>;
}

function EmptyContent({ icon, title, children, action }: { icon: ClubIconName; title: string; children: ReactNode; action?: ReactNode }) {
  return <div className="club-empty" role="status"><span className="club-empty-icon"><ClubIcon name={icon} size={36} /></span><h2>{title}</h2><p>{children}</p>{action}</div>;
}

export function ClubHome() {
  return <div className="club-home">
    <div className="club-logo"><img src="/images/cabc-official-logo.png" alt="中国—东盟经贸中心" width="316" height="86" /><span>会员服务</span></div>
    <section className="club-brand-hero" aria-label="中国—东盟跨境企业家俱乐部"><img className="club-brand-art" src="/images/club-hero-embossed-v1.png" alt="" aria-hidden="true" fetchPriority="high" /><h1 id="page-title" tabIndex={-1}>中国—东盟<br />跨境企业家俱乐部</h1><p>跨境知识 · 企业服务 · 交流参访</p></section>
    <nav className="club-quick" aria-label="常用服务">
      {([
        ['knowledge', '跨境知识库', 'BookOpen'], ['directory', '企业名录', 'BuildingTwo'],
        ['lectures', '跨境大讲堂', 'Slide'], ['all', '全部服务', 'AllApplication'],
      ] as const).map(([id, label, icon]) => <a key={id} href={id === 'all' ? '#/services' : serviceHref(id)}><span className="club-icon-tile"><ClubIcon name={icon} size={32} /></span><span>{label}</span></a>)}
    </nav>
    <section aria-labelledby="club-insights-title" className="club-home-section">
      <div className="club-section-title"><h2 id="club-insights-title">跨境观察</h2><a href="#/services/insights">全部<ClubIcon name="Right" variant="轮廓" size={16} /></a></div>
      <a className="club-editorial" href="#/services/insights"><span className="club-kicker">经贸动态 · 政策与实务</span><h3>跨境资讯待发布</h3><p>关注中国—东盟经贸动态，了解跨境经营中的政策与实务。</p><span className="club-editorial-status">正式资讯尚未上架<ClubIcon name="Right" variant="轮廓" size={16} /></span></a>
    </section>
    <section className="club-home-section" aria-labelledby="club-guides-title">
      <div className="club-section-title"><h2 id="club-guides-title">入会指南</h2></div>
      <a className="club-guide-feature" href="#/guides/getting-started"><div><h3>第一次加入，从这里开始</h3><p>了解会籍、申请方式与开通流程。</p></div><ClubIcon name="Right" variant="轮廓" size={20} /></a>
    </section>
    <a className="club-banner club-banner-gold" href="#/members"><span>会员指南与权益</span><ClubIcon name="Right" variant="轮廓" size={20} /></a>
  </div>;
}

function ServiceLink({ service, compact = false }: { service: Service; compact?: boolean }) {
  return <a className={`service-link ${compact ? 'service-link-compact' : ''}`} href={serviceHref(service.id)}><span className="club-icon-tile"><ClubIcon name={serviceIcons[service.id]} size={32} /></span><span>{service.title}</span>{!compact && <ClubIcon name="Right" variant="轮廓" size={18} />}</a>;
}

export function ClubServices({ query, setQuery }: { query: string; setQuery: (value: string) => void }) {
  const matches = services.filter(service => `${service.title}${service.category}${service.summary}`.includes(query.trim()));
  return <><Heading title="跨境服务" /><SearchField label="搜索会员服务" placeholder="搜索服务、内容" value={query} onChange={setQuery} />
    {query.trim() ? <><p className="club-list-label">找到 {matches.length} 项服务</p><div className="club-service-results club-service-group">{matches.map(service => <ServiceLink key={service.id} service={service} />)}</div>{!matches.length && <EmptyContent icon="Search" title="没有找到相关服务" action={<button className="text-button" onClick={() => setQuery('')}>清空搜索</button>}>试试“翻译”“知识”或“交流”。</EmptyContent>}</> : <>
      <section className="club-service-section"><h2 className="club-list-label">知识与资讯</h2><div className="club-service-group">{['lectures', 'knowledge', 'insights'].map(id => <ServiceLink key={id} service={services.find(service => service.id === id)!} />)}</div></section>
      <section className="club-service-section"><h2 className="club-list-label">专业与交流</h2><div className="club-service-grid">{['translation', 'directory', 'visits'].map(id => <ServiceLink key={id} service={services.find(service => service.id === id)!} compact />)}</div></section>
    </>}
    <a className="club-banner club-banner-green" href="#/members"><span>查看会员权益与使用说明</span><ClubIcon name="Right" variant="轮廓" size={20} /></a>
  </>;
}

export function ClubMembers() {
  return <><Heading title="成为俱乐部会员" serif>三档会籍，按你的业务需求选择。</Heading><div className="club-plans">
    {plans.map(plan => <a href={`#/join/${plan.id}`} className={`club-plan club-plan-${plan.id}`} key={plan.id} aria-label={`${plan.name}，每年 ${money(plan.price)} 元，${plan.actionLabel}`}>
      <div className="club-plan-title"><h2>{plan.name}</h2><span className="club-plan-price">¥{money(plan.price)}<small> / 年</small></span></div>
      <p>{plan.benefits.join(' · ')}</p><span className="club-plan-action">{plan.id === 'organization' ? '先审核资质，通过后付款开通' : '付款成功后开通'}<ClubIcon name="Right" variant="轮廓" size={16} /></span>
    </a>)}
  </div><p className="club-footnote">具体服务方式、活动安排与使用条件，请查看各项权益说明。当前支付尚未开放。</p><div className="club-menu"><a href="#/guides/choose-membership">如何选择适合自己的会员<ClubIcon name="Right" variant="轮廓" size={20} /></a><a href="#/help">入会常见问题<ClubIcon name="Right" variant="轮廓" size={20} /></a></div></>;
}

export function ClubAccount({ session }: { session: Session }) {
  const status = session.membership?.active ? plans.find(plan => plan.id === session.membership?.planId)?.name : session.membership ? '会员已到期' : '尚未开通会员';
  return <><a className="club-profile" href="#/account?tab=settings"><span className="club-avatar"><ClubIcon name="People" size={32} /></span><div><h1 id="page-title" tabIndex={-1}>{session.user ? session.user.username : isPresentation ? '访客浏览' : '登录会员账号'}</h1><p>{session.user ? '账号资料与设置' : isPresentation ? '了解会员权益与服务' : '登录后查看申请与会员服务'}</p></div><ClubIcon name="Right" variant="轮廓" size={20} /></a>
    <a className="club-pass" href="#/members"><img className="club-pass-art" src="/images/club-membership-guilloche-v1.png" alt="" aria-hidden="true" fetchPriority="high" /><h2>俱乐部会籍</h2><strong>{status}</strong><p>{session.membership ? `有效期至 ${dateLabel(session.membership.expiresAt)}` : '查看会员权益与入会方式'}<ClubIcon name="Right" variant="轮廓" size={16} /></p></a>
    <div className="club-menu"><a href="#/account?tab=orders">申请与订单<ClubIcon name="Right" variant="轮廓" size={20} /></a><a href="#/account?tab=posts">我的投稿<ClubIcon name="Right" variant="轮廓" size={20} /></a></div>
    <div className="club-menu"><a href="#/account?tab=referral">邀请推荐<ClubIcon name="Right" variant="轮廓" size={20} /></a><a href="#/account?tab=rewards">奖励与提现<ClubIcon name="Right" variant="轮廓" size={20} /></a></div>
    <div className="club-menu"><a href="#/help">帮助与反馈<ClubIcon name="Right" variant="轮廓" size={20} /></a><a href="#/account?tab=settings">个人资料与设置<ClubIcon name="Right" variant="轮廓" size={20} /></a></div>
  </>;
}

export function ClubSettings({ session, refresh }: { session: Session; refresh: () => Promise<void> }) {
  const [error, setError] = useState(''), [busy, setBusy] = useState(false);
  if (!session.user) return <Login refresh={refresh} />;
  async function logout() { const originalRoute = window.location.hash; setBusy(true); setError(''); try { await api('/auth/logout', {}); await refresh(); if (window.location.hash === originalRoute) window.location.hash = '/account'; } catch (err) { setError(errorText(err)); } finally { setBusy(false); } }
  return <><Heading title="个人资料与设置" /><section className="club-sheet"><dl className="club-details"><div><dt>账号</dt><dd>{session.user.username}</dd></div><div><dt>身份</dt><dd>{session.user.role === 'admin' ? '本机管理员' : '内测账号'}</dd></div><div><dt>手机验证</dt><dd>{session.user.phoneVerified ? '已验证' : '尚未接入'}</dd></div></dl><p className="club-footnote">姓名及联系资料可在已保存的入会申请中查看。账号资料修改尚未开放。</p></section><div className="club-menu"><a href="#/account?tab=orders">查看我的申请资料<ClubIcon name="Right" variant="轮廓" size={20} /></a><a href="#/admin">运营工作台<ClubIcon name="Right" variant="轮廓" size={20} /></a></div>{error && <p role="alert" className="field-error">{error}</p>}<button className="button secondary full club-logout" disabled={busy} onClick={() => void logout()}>{busy ? '正在退出…' : '退出登录'}</button></>;
}

export function ClubRewards({ session, refresh }: { session: Session; refresh: () => Promise<void> }) {
  if (!session.user) return <Login refresh={refresh} />;
  return <><Heading title="奖励与提现" /><EmptyContent icon="Gift" title="奖励结算尚未开放">当前没有可查询的奖励账本与提现记录。</EmptyContent><section className="club-sheet club-prose"><h2>推荐与奖励</h2><p>推荐关系可以在“邀请推荐”中查看。奖励按实际付款金额计算，部分升级与退款结算细节待确认。</p><p>提现采用审核后由财务人工打款的方式；申请入口尚未开放。</p><a href="#/account?tab=referral" className="button secondary">查看我的推荐信息<ClubIcon name="Right" size={18} /></a></section></>;
}

const catalogCopy: Record<string, { empty: string; tabs: string[] }> = {
  knowledge: { empty: '知识资料待上架', tabs: ['全部', '政策法规', '经营实务'] },
  insights: { empty: '跨境资讯待发布', tabs: ['全部', '经贸动态', '政策与实务'] },
  lectures: { empty: '课程内容待上架', tabs: ['全部', '主题分享', '课程回放'] },
  visits: { empty: '交流活动待发布', tabs: ['全部', '线下交流', '游学参访'] },
};

export function ClubServicePage({ service }: { service: Service }) {
  const [query, setQuery] = useState(''), [category, setCategory] = useState('全部');
  const catalog = catalogCopy[service.id];
  if (service.id === 'translation') return <><Heading title="翻译服务">跨语言沟通，从清楚表达开始。</Heading><section className="club-translation-intro"><span className="club-icon-tile"><ClubIcon name="Translate" size={38} /></span><h2>会员翻译权益</h2><p>为跨语言沟通提供辅助</p></section><section className="club-sheet club-prose"><h2>使用说明</h2><p>{service.detail}</p><p className="club-inline-state">正式翻译入口尚未接入</p></section><a className="club-banner club-banner-green" href="#/members">查看适用会员权益<ClubIcon name="Right" variant="轮廓" size={20} /></a></>;
  return <><Heading title={service.title}>{service.summary}</Heading><SearchField label={`搜索${service.title}`} placeholder={`搜索${service.id === 'lectures' ? '课程、主题' : service.id === 'visits' ? '活动、地区' : '标题、关键词'}`} value={query} onChange={setQuery} /><div className="club-filter-tabs" role="group" aria-label="内容分类">{catalog.tabs.map(tab => <button key={tab} aria-pressed={category === tab} onClick={() => setCategory(tab)}>{tab}</button>)}</div>
    <EmptyContent icon={serviceIcons[service.id]} title={query.trim() ? '没有找到相关内容' : catalog.empty} action={(query.trim() || category !== '全部') && <button className="text-button" onClick={() => { setQuery(''); setCategory('全部'); }}>重置筛选</button>}>{query.trim() ? `当前暂无与“${query.trim()}”匹配的已上架内容。` : '正式内容上架后将在这里展示。'}</EmptyContent>
    <details className="club-service-note"><summary>查看权益与开放说明<ClubIcon name="Right" variant="轮廓" size={18} /></summary><p>{service.detail}</p><a href="#/members">查看会员权益</a></details>{service.id === 'visits' && <a href="#/content" className="club-banner club-banner-gold">已审核的会员交流文字<ClubIcon name="Right" variant="轮廓" size={20} /></a>}
  </>;
}

export function ClubDirectory() {
  const [query, setQuery] = useState(''), [industry, setIndustry] = useState('all'), [region, setRegion] = useState('all');
  const filtered = query.trim() || industry !== 'all' || region !== 'all';
  return <><Heading title="发现跨境企业与专业服务" /><SearchField label="搜索企业、产品或服务" placeholder="搜索企业、产品或服务" value={query} onChange={setQuery} /><div className="club-directory-filters"><label><span className="sr-only">行业</span><select value={industry} onChange={event => setIndustry(event.target.value)}><option value="all">全部行业</option><option value="trade">贸易与供应链</option><option value="professional">专业服务</option><option value="industry">产业与制造</option></select></label><label><span className="sr-only">地区</span><select value={region} onChange={event => setRegion(event.target.value)}><option value="all">全部地区</option><option value="china">中国</option><option value="asean">东盟</option></select></label></div>
    <EmptyContent icon="BuildingTwo" title={filtered ? '没有找到相关企业' : '企业名录待上架'} action={filtered && <button className="text-button" onClick={() => { setQuery(''); setIndustry('all'); setRegion('all'); }}>重置筛选</button>}>当前尚未录入正式企业、产品及专业服务资料。</EmptyContent><div className="club-directory-note"><h2>让更多人了解你的专业服务</h2><p>了解机构与专业会员的名录展示权益及申请方式。</p><a href="#/guides/directory-application">查看名录展示说明<ClubIcon name="Right" variant="轮廓" size={18} /></a></div>
  </>;
}

export function ClubGuide({ id }: { id: string }) {
  const story = stories.find(item => item.id === id);
  if (!story) return <Heading title="暂时找不到这篇指南" />;
  return <article className="club-article"><span className="club-kicker">{story.tag}</span><Heading title={story.title} /><p className="club-article-lead">{story.summary}</p>{story.paragraphs.map((paragraph, index) => <p key={index}>{paragraph}</p>)}<a className="button primary full" href="#/members">查看会员权益<ClubIcon name="Right" size={18} /></a></article>;
}

export function ClubHelp() {
  const questions = [
    ['入会需要经过审核吗？', '基础会员和星级会员付款成功后开通，无需资质预审。机构及专业会员先审核资质，通过后付款；审核通过本身不会开通会员。'],
    ['会籍有效期如何计算？', '从核验付款成功时起算一年。提交申请及资质审核期间不计入会籍有效期。'],
    ['为什么当前不能付款？', isPresentation ? '当前为界面演示，申请提交、订单保存与支付均未开放，不会收款或开通会员。' : '当前为本机内测，微信支付尚未接通。申请和订单可以保存，当前不会收款或开通会员。'],
    ['推荐来源怎么记录？', isPresentation ? '正式开放后，有效邀请链接会承接推荐来源，已有有效来源不会被覆盖。当前演示版不保存推荐关系。' : '从有效邀请链接进入时会自动承接推荐来源，已有有效来源不会被覆盖。默认来源以后台实际配置为准。'],
    ['在哪里查看审核结果？', isPresentation ? '正式开放申请后，可在“我的 → 申请与订单”查看审核结果。当前演示版不接收申请，也不生成审核记录。' : '打开“我的 → 申请与订单”，进入对应订单并刷新状态，即可查看审核结果及说明。'],
  ];
  return <><Heading title="帮助与反馈" />{questions.map(([question, answer]) => <details className="club-faq" key={question}><summary>{question}<ClubIcon name="Right" variant="轮廓" size={18} /></summary><p>{answer}</p></details>)}<section className="club-feedback"><h2>联系俱乐部</h2><p>官方客服联系方式及在线反馈入口待提供。</p></section><a className="text-button" href="#/guides/getting-started">阅读完整入会指南<ClubIcon name="Right" size={18} /></a></>;
}
