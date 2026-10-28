import { useEffect, useRef, useState } from 'react';
import {api} from './api';
import { ArrowLeft, ArrowRight, ClipboardList, CalendarDays, Globe2 } from 'lucide-react';
import './home-activities.css';

const existingActivities = [
  { id: 'salon', label: '中国—东盟 · AI 大咖沙龙', tag: '会后调研', title: '您的反馈，下一场的起点', description: '分享参会感受，告诉我们您的合作与出海需求。', action: '填写参会反馈问卷', href: '#/surveys/salon', icon: ClipboardList },
  { id: 'matchmaking', label: '供需对接', tag: '长期征集', title: '让 AI 找到你的业务', description: '发布技术供给，或说出企业需求。', action: '填写供需问卷', href: '#/surveys', icon: ClipboardList },
  { id: 'expo', label: '东博会 · 南宁', tag: '9.17—9.21', title: '相聚东博会', description: '查看重点投资贸易促进活动安排。', action: '查看活动安排表', href: '#/activities/61ad4bed-7c35-4059-8ee9-799086c86b83', icon: CalendarDays },
  { id: 'singapore', label: '新加坡 · AI 分论坛', tag: '11月路演', title: '下一站，新加坡', description: '登记路演意向，连接跨境合作机会。', action: '填写路演意向', href: '#/surveys/singapore', icon: Globe2 },
] as const;

export function HomeActivities() {
  const [intakeOpen,setIntakeOpen]=useState(false);
  useEffect(()=>{let live=true;api<{mode:string}>('/enterprise-intake').then(r=>{if(live)setIntakeOpen(r.mode==='hybrid');}).catch(()=>{});return()=>{live=false;};},[]);
  const activities = intakeOpen ? [{id:'enterprise',label:'企业出海 · 资料收集',tag:'需求登记',title:'企业出海需求登记',description:'在线填写关键需求，上传完整材料，方便统计和服务对接。',action:'填写企业出海需求',href:'#/enterprise-intake',icon:ClipboardList},...existingActivities] : existingActivities;
  const track = useRef<HTMLDivElement>(null);
  const [active, setActive] = useState(0);
  function move(index: number) {
    const element = track.current?.children[index] as HTMLElement | undefined;
    if (!element || !track.current) return;
    track.current.scrollTo({ left: element.offsetLeft - (track.current.children[0] as HTMLElement).offsetLeft, behavior: window.matchMedia('(prefers-reduced-motion: reduce)').matches ? 'instant' : 'smooth' });
  }
  function updatePosition() {
    const container = track.current;
    if (!container) return;
    const first = (container.children[0] as HTMLElement).offsetLeft;
    let closest = 0, distance = Infinity;
    Array.from(container.children).forEach((child, index) => {
      const delta = Math.abs((child as HTMLElement).offsetLeft - first - container.scrollLeft);
      if (delta < distance) { closest = index; distance = delta; }
    });
    setActive(closest);
  }
  return <section className="home-activities" aria-labelledby="home-activities-title" aria-roledescription="轮播">
    <div className="home-activities-heading"><h2 id="home-activities-title">活动</h2><a href="#/activities">全部活动 <ArrowRight size={14} /></a></div>
    <div className="home-activities-track" ref={track} onScroll={updatePosition}>
      {activities.map((item, index) => <a className={`home-activity home-activity-${item.id}`} href={item.href} key={item.id} aria-label={`${item.action}，第${index + 1}项，共${activities.length}项`}>
        <div className="home-activity-meta"><span>{item.label}</span><span className="home-activity-tag">{item.tag}</span></div>
        <item.icon className="home-activity-art" size={104} strokeWidth={.8} aria-hidden="true" />
        <h3>{item.title}</h3><p>{item.description}</p>
        <span className="home-activity-action">{item.action}<ArrowRight size={17} /></span>
      </a>)}
    </div>
    <div className="home-activities-controls">
      <span className="home-activities-hint">左右滑动，发现更多</span>
      <div className="home-activities-dots" aria-label="选择活动">{activities.map((item, index) => <button key={item.id} aria-label={`显示${item.action}`} aria-current={index === active ? 'true' : undefined} onClick={() => move(index)}><span /></button>)}</div>
      <div className="home-activities-arrows"><button aria-label="上一项活动" disabled={active === 0} onClick={() => move(active - 1)}><ArrowLeft size={16} /></button><button aria-label="下一项活动" disabled={active === activities.length - 1} onClick={() => move(active + 1)}><ArrowRight size={16} /></button></div>
    </div>
  </section>;
}
