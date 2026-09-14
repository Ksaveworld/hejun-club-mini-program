import { ClubIcon } from './ClubIcon';
import type { Plan } from './types';
import { money } from './store';

export function ClubPresentationPage({ title, plan, content = false }: { title: string; plan?: Plan; content?: boolean }) {
  return <>
    <div className="club-heading"><h1 id="page-title" tabIndex={-1}>{title}</h1><p>{content ? '交流内容待正式上架。' : '当前为界面演示，此项服务暂未开放。'}</p></div>
    {plan && <aside className={`join-summary ${plan.id}`}><span className="eyebrow">你选择的会籍</span><h2>{plan.name}</h2><div className="price"><small>¥</small>{money(plan.price)}<span> / 年</span></div><p>{plan.benefits.join(' · ')}</p></aside>}
    <section className="club-sheet club-prose"><h2>{content ? '会员交流' : plan ? '申请开放说明' : '服务开放说明'}</h2><p>{content ? '这里将展示审核通过的会员交流文字，目前没有已发布内容。' : '这个版本用于浏览页面和了解会员权益，暂不提供登录、资料提交或订单保存，也不会收款。'}</p></section>
    <a className="club-banner club-banner-green" href="#/members">查看会员权益<ClubIcon name="Right" variant="轮廓" size={20} /></a>
    <a className="text-button" href="#/services">浏览会员服务<ClubIcon name="Right" size={18} /></a>
  </>;
}
