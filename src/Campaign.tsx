import { useEffect, useRef, useState } from 'react';
import { ArrowUpRight, X } from 'lucide-react';
import { api } from './api';
import './campaign.css';
type Event = { id: string; active: boolean; title: string; timeLabel: string; venue: string; endsAt: string };
export function Campaign({ auto = false }: { auto?: boolean }) {
  const [event, setEvent] = useState<Event | null>(null), [open, setOpen] = useState(false);
  const dialog = useRef<HTMLDialogElement>(null);
  useEffect(() => {
    let alive = true;
    void api<{ campaign: Event }>('/campaign').then(({ campaign }) => {
      if (!alive || !campaign.active) return;
      setEvent(campaign);
      if (auto) { let seen = false; try { seen = !!localStorage.getItem(campaign.id); } catch { /* storage may be disabled */ }
        if (!seen) setOpen(true);
      }
    }).catch(() => { /* The core home page remains usable if campaign loading fails. */ });
    return () => { alive = false; };
  }, [auto]);
  useEffect(() => {
    if (!event) return;
    const remaining = Date.parse(event.endsAt) - Date.now();
    const timer = setTimeout(() => { setOpen(false); setEvent(null); }, Math.max(0, Math.min(remaining, 2147483647)));
    return () => clearTimeout(timer);
  }, [event]);
  useEffect(() => { const d = dialog.current; if (!d) return; if (open && !d.open) d.showModal(); if (!open && d.open) d.close(); }, [open, event]);
  function close() { if (event) try { localStorage.setItem(event.id, 'dismissed'); } catch { /* close still works */ } setOpen(false); }
  if (!event) return null;
  return <>{!auto && <button className="campaign-entry" onClick={() => setOpen(true)}><span>限时活动 · {event.timeLabel}<strong>AI供需对接 · 填写征集表</strong></span><ArrowUpRight size={21}/></button>}
    <dialog ref={dialog} className="campaign-dialog" aria-labelledby="campaign-title" onCancel={close} onClick={e => { if (e.target === e.currentTarget) close(); }}>
      <div className="campaign-inner"><button className="campaign-close" aria-label="关闭活动邀请" onClick={close}><X size={21}/></button><span className="campaign-kicker">CAEXPO 2026 · 限时活动</span><p className="campaign-date">09 / 17</p><h2 id="campaign-title">中国—东盟<br/>人工智能供需对接会</h2><p className="campaign-lead">让应用场景找到解决方案<br/>让专业能力连接真实需求</p><p className="campaign-meta">{event.timeLabel}<br/>{event.venue}</p><div className="campaign-actions"><a href="#/surveys/supply" onClick={close}>我提供AI产品 / 方案 <ArrowUpRight size={16}/></a><a href="#/surveys/demand" onClick={close}>我有AI应用需求 <ArrowUpRight size={16}/></a></div><button className="campaign-later" onClick={close}>稍后再看</button><p className="campaign-note">关闭后可从「活动」再次进入，无需购买会员。</p></div>
    </dialog>
  </>;
}
