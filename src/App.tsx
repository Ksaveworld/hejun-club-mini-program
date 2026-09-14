import { useEffect, useRef, useState } from 'react';
import type { ReactNode } from 'react';
import { X, CircleHelp, PanelTop } from 'lucide-react';
import { plans, services } from './data';
import { api, errorText, rememberReferral } from './api';
import type { Session } from './api';
import { JoinMember, OrderPage, AccountPage, AdminPage, ContentPage } from './MemberPages';
import { ClubIcon } from './ClubIcon';
import { ClubHome, ClubServices, ClubMembers, ClubAccount, ClubSettings, ClubRewards, ClubDirectory, ClubServicePage, ClubGuide, ClubHelp } from './ClubPages';
import './admin.css';
import { isPresentation } from './presentation';
import { ClubPresentationPage } from './ClubPresentationPage';

function PreviewDialog({ open, close }: { open: boolean; close: () => void }) {
  const ref = useRef<HTMLDialogElement>(null);
  const closer = useRef(close);
  closer.current = close;
  useEffect(() => {
    const dialog = ref.current;
    if (!open || !dialog) return;
    const previousFocus = document.activeElement as HTMLElement | null;
    dialog.showModal();
    const cancel = (event: Event) => { event.preventDefault(); closer.current(); };
    dialog.addEventListener('cancel', cancel);
    const originalOverflow = document.body.style.overflow;
    document.body.style.overflow = 'hidden';
    return () => { dialog.close(); dialog.removeEventListener('cancel', cancel); document.body.style.overflow = originalOverflow; previousFocus?.focus(); };
  }, [open]);
  return <dialog ref={ref} className="dialog" aria-labelledby="dialog-title" onClick={event => { if (event.target === event.currentTarget) close(); }}>
    {open && <div className="dialog-inner"><button className="icon-button dialog-close" aria-label="关闭弹窗" onClick={close}><X size={22} /></button><h2 id="dialog-title">{isPresentation ? '演示说明' : '本机内测说明'}</h2>{isPresentation ? <><p>当前版本用于浏览俱乐部页面、会员权益和服务介绍，可以使用搜索、筛选与页面导航。</p><p>登录、注册、资料提交、订单保存和支付暂未开放。正式资讯、课程、知识资料及企业名录待运营提供。</p></> : <><p>可以注册登录、保存入会申请与订单、审核机构资质、查看推荐来源和已审核的交流文字。</p><p>微信登录、短信验证、微信支付尚未接通，当前不会收款或开通会员。请使用虚构联系资料与独立的内测密码。</p><p>资讯、课程、知识资料和企业名录尚待运营提供。真实奖励账本、提现及对外部署尚未完成。</p></>}<a className="button secondary" href="#/help" onClick={close}>查看常见问题</a></div>}
  </dialog>;
}

const tabTitles: Record<string, string> = { orders: '申请与订单', posts: '我的投稿', referral: '邀请推荐', rewards: '奖励与提现', settings: '个人资料与设置' };

export default function App() {
  const [route, setRoute] = useState(window.location.hash.slice(1) || '/');
  const [session, setSession] = useState<Session | null>(isPresentation ? { user: null, membership: null, paymentReady: false, defaultReferralConfigured: false } : null);
  const [error, setError] = useState('');
  const [guideOpen, setGuideOpen] = useState(false);
  const [serviceQuery, setServiceQuery] = useState('');
  const returnRoutes = useRef(new Map<string, string>());
  async function refresh() {
    if (isPresentation) return;
    setError('');
    try { setSession(await api<Session>('/me')); } catch (err) { setError(errorText(err)); throw err; }
  }
  useEffect(() => {
    if (!isPresentation) rememberReferral();
    void refresh().catch(() => {});
    const sync = (event: HashChangeEvent) => {
      const from = new URL(event.oldURL).hash.slice(1) || '/';
      const to = new URL(event.newURL).hash.slice(1) || '/';
      const fromPath = from.split('?')[0], toPath = to.split('?')[0];
      // Remember a page's actual entry point without making child pages its parent.
      if ((toPath.startsWith('/services/') || toPath === '/directory') && ['/', '/services'].includes(fromPath)
        || toPath === '/members' && (['/', '/services', '/account', '/help'].includes(fromPath) || fromPath.startsWith('/services/') || fromPath.startsWith('/guides/'))
        || toPath === '/help' && ['/', '/services', '/account', '/members'].includes(fromPath)
        || toPath.startsWith('/guides/') && ['/', '/members', '/directory', '/help'].includes(fromPath)
        || toPath === '/content' && ['/account', '/services/visits'].includes(fromPath)) {
        if (returnRoutes.current.get(fromPath)?.split('?')[0] !== toPath) returnRoutes.current.set(toPath, from);
      }
      if (!isPresentation) rememberReferral();
      setRoute(window.location.hash.slice(1) || '/'); window.scrollTo(0, 0);
      requestAnimationFrame(() => document.getElementById('page-title')?.focus({ preventScroll: true }));
    };
    window.addEventListener('hashchange', sync);
    return () => window.removeEventListener('hashchange', sync);
  }, []);
  const path = route.split('?')[0];
  const accountTab = new URLSearchParams(route.split('?')[1]).get('tab');
  const plan = plans.find(item => item.id === path.split('/')[2]);
  const service = services.find(item => item.id === path.split('/')[2]);
  const admin = path === '/admin' && !isPresentation;
  const showNavigation = path === '/' || path === '/services' || (path === '/account' && !accountTab);
  const pageTitle = path === '/' ? '首页' : path === '/services' ? '服务大厅' : path === '/account' ? (accountTab ? tabTitles[accountTab] || '申请与订单' : '我的') : path === '/members' ? '会员权益' : path === '/directory' ? '企业名录' : path.startsWith('/join/') ? '申请入会' : path.startsWith('/checkout/') || path.startsWith('/result/') ? '订单详情' : path.startsWith('/guides/') ? '会员指南' : path === '/help' ? '帮助与反馈' : path === '/content' ? '会员交流' : service?.title || '会员服务';
  const back = path === '/account' ? ['#/account', '返回我的'] : path.startsWith('/join/') ? ['#/members', '返回会员权益'] : path.startsWith('/checkout/') || path.startsWith('/result/') ? ['#/account?tab=orders', '返回我的订单'] : path.startsWith('/services/') || path === '/directory' || path === '/content' ? ['#/services', '返回服务大厅'] : ['#/', '返回首页'];
  const returnRoute = returnRoutes.current.get(path);
  if (returnRoute) {
    back[0] = `#${returnRoute}`;
    const returnPath = returnRoute.split('?')[0];
    const labels: Record<string, string> = { '/': '首页', '/account': '我的', '/services': '服务大厅', '/members': '会员权益', '/directory': '企业名录', '/help': '帮助与反馈' };
    back[1] = `返回${labels[returnPath] || services.find(item => `/services/${item.id}` === returnPath)?.title || (returnPath.startsWith('/guides/') ? '会员指南' : '上一页')}`;
  }
  let page: ReactNode;
  if (!session) page = <div className="empty-state"><h1 id="page-title">{error ? '数据服务暂时未连接' : '正在读取会员服务…'}</h1>{error && <><p role="alert">{error}</p><button className="button secondary" onClick={() => void refresh().catch(() => {})}>重新连接</button></>}</div>;
  else if (isPresentation && (path.startsWith('/join/') || path.startsWith('/checkout/') || path.startsWith('/result/') || (path === '/account' && accountTab) || path === '/admin' || path === '/content')) page = <ClubPresentationPage title={path === '/admin' ? '运营工作台' : pageTitle} plan={path.startsWith('/join/') ? plan : undefined} content={path === '/content'} />;
  else if (path === '/') page = <ClubHome />;
  else if (path === '/members') page = <ClubMembers />;
  else if (path.startsWith('/join/') && plan) page = <JoinMember key={route + (session.user?.id || 'guest')} plan={plan} session={session} refresh={refresh} />;
  else if (path.startsWith('/checkout/') || path.startsWith('/result/')) page = <OrderPage key={path} id={path.split('/')[2]} refresh={refresh} />;
  else if (path === '/account' && !accountTab) page = <ClubAccount session={session} />;
  else if (path === '/account' && accountTab === 'settings') page = <ClubSettings session={session} refresh={refresh} />;
  else if (path === '/account' && accountTab === 'rewards') page = <ClubRewards session={session} refresh={refresh} />;
  else if (path === '/account') page = <AccountPage key={route + (session.user?.id || 'guest')} session={session} refresh={refresh} />;
  else if (admin) page = <AdminPage key={session.user?.id || 'guest'} session={session} refresh={refresh} />;
  else if (path === '/services') page = <ClubServices query={serviceQuery} setQuery={setServiceQuery} />;
  else if (path === '/directory' || path === '/services/directory') page = <ClubDirectory />;
  else if (path.startsWith('/services/') && service) page = <ClubServicePage key={path} service={service} />;
  else if (path.startsWith('/guides/')) page = <ClubGuide id={path.split('/')[2]} />;
  else if (path === '/help') page = <ClubHelp />;
  else if (path === '/content') page = <ContentPage />;
  else page = <div className="empty-state"><h1 id="page-title">暂时找不到这个页面</h1><a className="button primary" href="#/">返回首页</a></div>;
  return <div className={admin ? 'admin-shell' : `member-shell club-shell ${showNavigation ? 'club-has-nav' : 'club-subpage'} ${path === '/directory' ? 'club-directory-page' : ''}`}>
    <div className="preview-bar"><span>{isPresentation ? '界面演示 · 申请与支付未开放' : '本机内测 · 支付尚未开放'}</span><button onClick={() => setGuideOpen(true)}>{isPresentation ? '演示说明' : '内测说明'}<CircleHelp size={13} /></button></div>
    {admin ? <header className="site-header"><a href="#/" className="brand brand-cabc" aria-label="中国东盟跨境企业家俱乐部首页"><img src="/images/cabc-official-logo.png" alt="中国—东盟经贸中心" width="316" height="86" /><span>跨境企业家俱乐部</span></a><nav className="desktop-nav" aria-label="主导航"><a href="#/">首页</a><a href="#/members">会员权益</a><a href="#/services">服务大厅</a><a href="#/account">我的</a></nav><a href="#/admin" className="admin-entry active"><PanelTop size={16} />运营工作台</a></header>
      : <header className="club-topbar">{!showNavigation && <a href={back[0]} aria-label={back[1]}><ClubIcon name="Left" size={21} /></a>}<span>{pageTitle}</span></header>}
    <main className={`main-content ${admin ? 'admin-main' : ''} ${path === '/' ? 'home-main' : ''}`} key={admin ? 'admin' : 'public'}>{page}</main>
    {showNavigation && <nav className="mobile-nav" aria-label="手机导航">{([
      ['/', '首页', 'Home'], ['/services', '服务', 'AllApplication'], ['/account', '我的', 'People'],
    ] as const).map(([href, label, icon]) => <a key={href} href={`#${href}`} className={path === href ? 'active' : ''} aria-current={path === href ? 'page' : undefined}><ClubIcon name={icon} variant={path === href ? '选中' : '轮廓'} size={24} /><span>{label}</span></a>)}</nav>}
    <PreviewDialog open={guideOpen} close={() => setGuideOpen(false)} />
  </div>;
}
