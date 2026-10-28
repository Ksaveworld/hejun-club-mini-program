import { useState } from 'react';
import { ArrowLeft, ArrowUpRight, Building2, Compass, ShieldCheck, Landmark, MapPin, Truck, GraduationCap } from 'lucide-react';
import categories from '../miniprogram/data/service-directory.json';
import './directory.css';

const icons = [Compass, ShieldCheck, Landmark, MapPin, Truck, GraduationCap];
const prompts = ['明确方向，判断市场机会', '守住合规底线，管理跨境风险', '规划财税架构，连接资本资源', '从商务对接走向项目落地', '优化供应链，打通跨境流通', '补齐知识与国际化能力'];
export function ClubDirectory({ id }: { id?: string }) {
  const [tab, setTab] = useState('services'), [query, setQuery] = useState('');
  const category = categories.find(item => item.id === id);
  if (id && !category) return <section><h1>未找到这类服务</h1><a href="#/directory">返回服务名录</a></section>;
  if (category) return <article className="directory-detail">
    <a className="back-link" href="#/directory"><ArrowLeft size={16}/>返回专业服务</a>
    <header className="directory-hero"><span className="directory-eyebrow">专业服务 / 0{category.id}</span><h1 id="page-title">{category.title}</h1><p>{category.summary}</p><span className="directory-count">{category.details.length}项服务模块</span></header>
    <nav className="directory-jumps" aria-label="本类服务模块">{category.details.map(item => <button key={item.id} onClick={() => document.getElementById('module-' + item.id)?.scrollIntoView({ behavior: 'smooth', block: 'start' })}>{item.id.padStart(2, '0')} {item.title}</button>)}</nav>
    {category.details.map(item => <section className="directory-module" id={'module-' + item.id} key={item.id}><span className="directory-eyebrow">模块 {item.id.padStart(2, '0')}</span><h2>{item.title}</h2><h3>服务说明</h3><p>{item.description}</p><div className="directory-value"><h3>解决问题与价值</h3><p>{item.value}</p></div></section>)}
    <footer className="directory-footer"><p>具体服务范围、承接方式及费用，以实际对接约定为准。</p><a className="button secondary" href="#/help">了解联系与服务办理 <ArrowUpRight size={16}/></a></footer>
  </article>;
  const filtered = categories.filter(c => (c.title + c.modules.join('')).includes(query.trim()));
  return <div className="directory-catalog">
    <header className="directory-intro"><span className="directory-eyebrow">连接企业 · 发现专业能力</span><h1 id="page-title">企业与服务名录</h1><p>从业务需求出发，找到跨境经营所需的支持。</p></header>
    <div className="directory-tabs" role="tablist" aria-label="名录类型"><button role="tab" aria-selected={tab === 'services'} onClick={() => setTab('services')}>专业服务</button><button role="tab" aria-selected={tab === 'companies'} onClick={() => setTab('companies')}>会员企业</button></div>
    {tab === 'services' ? <section role="tabpanel" aria-label="专业服务"><label className="directory-search"><span className="sr-only">搜索专业服务</span><input type="search" value={query} onChange={e => setQuery(e.target.value)} placeholder="搜索服务，如法律、物流、培训"/></label><div className="directory-section-title"><h2>六大服务体系</h2><span>按需要选择服务方向</span></div>
      <div className="directory-grid">{filtered.map(c => { const Icon = icons[Number(c.id) - 1]; return <a className="directory-category" href={'#/directory/' + c.id} key={c.id}><div className="directory-card-top"><span className="directory-icon"><Icon size={25} strokeWidth={1.6}/></span><span className="directory-number">0{c.id}</span></div><h3>{c.title}</h3><p>{prompts[Number(c.id) - 1]}</p><div className="directory-tags">{c.modules.slice(0, 2).map(name => <span key={name}>{name}</span>)}</div><div className="directory-card-bottom"><span>{c.modules.length}项服务 · 查看介绍</span><ArrowUpRight size={19}/></div></a>; })}</div>
      {!filtered.length && <p role="status">没有找到相关服务，请换个关键词。</p>}
    </section> : <section className="directory-company-empty" role="tabpanel" aria-label="会员企业"><Building2 size={38} strokeWidth={1.3}/><h2>会员企业资料整理中</h2><p>后续将在这里展示企业介绍与专业能力。现在可以先浏览六大专业服务体系。</p><button className="button secondary" onClick={() => setTab('services')}>浏览专业服务</button></section>}
  </div>;
}
