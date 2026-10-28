import { useEffect, useRef, useState } from 'react';
import { GrantRejection, levelLabel, type GrantLevel, type LookupInput, grantState, sessionJournal, shanghaiTime, type GrantGateway, type GrantJournal, type Identity, type Preflight, type Grant, type Pending } from './contract';
import './grants.css';

type Props = { actorId: string; gateway: GrantGateway; journal?: GrantJournal; mode: 'fixture' | 'connected' };
// Keying the whole workspace discards responses and identity data when the actor changes.
export function GrantPage(props: Props) { return <Workspace key={props.actorId} {...props} />; }
function Workspace({ actorId, gateway, journal = sessionJournal, mode }: Props) {
  const [lookupType, setLookupType] = useState<LookupInput['type']>('phone');
  const [level, setLevel] = useState<GrantLevel | ''>('');
  const [query, setQuery] = useState(''), [identity, setIdentity] = useState<Identity | null>(null);
  const [reason, setReason] = useState(''), [approval, setApproval] = useState(''), [checked, setChecked] = useState(false);
  const [pre, setPre] = useState<Preflight | null>(null), [confirmed, setConfirmed] = useState(false);
  const [rows, setRows] = useState<Grant[]>([]), [cursor, setCursor] = useState<string | undefined>(), [historyUser, setHistoryUser] = useState('');
  const [revokeTarget, setRevokeTarget] = useState<Grant | null>(null), [revokeReason, setRevokeReason] = useState('');
  const [pending, setPending] = useState<Pending | null>(null), [journalError, setJournalError] = useState('');
  const [busy, setBusy] = useState(false), [authorized, setAuthorized] = useState(false), [error, setError] = useState(''), [notice, setNotice] = useState('');
  const [result, setResult] = useState<Grant | null>(null), [now, setNow] = useState(Date.now());
  const lock = useRef(false), alive = useRef(true);
  const locked = busy || !!pending || !!journalError || !authorized;
  const validPre = pre?.ready === true && pre.blockers.length === 0 && pre.userId === identity?.userId && pre.level === level && pre.confirmationToken && Date.parse(pre.confirmationExpiresAt) > now && Date.parse(pre.expiresAt) > Date.parse(pre.startsAt);

  function invalidate() { setPre(null); setConfirmed(false); setResult(null); setNotice(''); }
  function resetTarget() { setIdentity(null); setLevel(''); setChecked(false); setRows([]); setHistoryUser(''); setCursor(undefined); setRevokeTarget(null); setRevokeReason(''); invalidate(); }
  async function verify() {
    try {
      const s = await gateway.checkSession();
      if (!alive.current) throw Error('页面已关闭');
      if (s.actorId !== actorId || !s.canGrant) throw new GrantRejection('登录身份已变化或没有赠送权限，请重新登录后核对。', 'FORBIDDEN');
      setAuthorized(true);
    } catch (e) {
      if (alive.current) { setAuthorized(false); resetTarget(); setQuery(''); setReason(''); setApproval(''); }
      throw e;
    }
  }
  async function run(action: () => Promise<void>) {
    if (lock.current) return;
    lock.current = true; setBusy(true); setError(''); setNotice('');
    try { await verify(); await action(); }
    catch (e) { if (alive.current) setError(e instanceof Error ? e.message : '操作未完成。'); }
    finally { lock.current = false; if (alive.current) setBusy(false); }
  }
  useEffect(() => {
    alive.current = true;
    try { setPending(journal.read(actorId)); } catch (e) { setJournalError(e instanceof Error ? e.message : '无法读取操作恢复记录。'); }
    void run(async () => {});
    const timer = window.setInterval(() => setNow(Date.now()), 1000);
    return () => { alive.current = false; window.clearInterval(timer); };
  }, []);
  useEffect(() => {
    const guard = (e: BeforeUnloadEvent) => { if (pending || busy) { e.preventDefault(); e.returnValue = ''; } };
    window.addEventListener('beforeunload', guard);
    return () => window.removeEventListener('beforeunload', guard);
  }, [pending, busy]);

  async function history(userId: string, next?: string) {
    const page = await gateway.list({ userId, cursor: next });
    if (!alive.current) return;
    if (!Array.isArray(page.items) || page.items.some(g => g.userId !== userId)) throw Error('记录与查询账号不一致，请重新核对。');
    setRows(old => next ? [...old, ...page.items.filter(g => !old.some(x => x.grantId === g.grantId))] : page.items);
    setHistoryUser(userId); setCursor(page.nextCursor);
  }
  function lookup() {
    resetTarget();
    void run(async () => {
      const value = query.trim();
      if (lookupType === 'phone' && (!/^\+?[0-9 ()-]+$/.test(value) || value.replace(/\D/g, '').length < 7 || value.replace(/\D/g, '').length > 15)) throw Error('请输入7～15位号码，可含国家或地区代码、空格或短横线。');
      const response = await gateway.lookup({ type: lookupType, value });
      if (!Array.isArray(response.matches) || !Array.isArray(response.blockers)) throw Error('查找结果不完整，请重新核对。');
      if (response.blockers.length) throw Error(response.blockers.join('；'));
      const matches = response.matches;
      if (!alive.current) return;
      if (matches.length !== 1) throw Error(matches.length ? '匹配到多个账号，不能自动选择；请核对账号绑定后重试。' : '没有找到已注册账号，请核对输入或改用用户编号。');
      const user = matches[0];
      if (!user.userId || (lookupType === 'userId' && user.userId !== value)) throw Error('返回账号与输入编号不一致，已阻止继续。');
      setIdentity(user); await history(user.userId);
    });
  }
  function preflight() {
    if (!level || identity?.verified !== true || !checked || !reason.trim() || !approval.trim()) return;
    invalidate();
    void run(async () => {
      const p = await gateway.preflight({ userId: identity.userId, level, reason: reason.trim(), approvalReference: approval.trim() });
      if (!alive.current) return;
      if (p.userId !== identity.userId || !Array.isArray(p.blockers) || !Array.isArray(p.existing)) throw Error('预检信息不完整，请重新核对。');
      setPre(p); setNow(Date.now());
    });
  }
  async function mutate(p: Pending, recovery: 'lookup' | 'retry' | null = null) {
    // Persist BEFORE dispatch. If storage fails, no business call is sent.
    try { journal.write(actorId, p); } catch { setJournalError('无法保存操作恢复记录，本次未发出请求。请修复浏览器存储后重新打开。'); return; }
    setPending(p);
    let reply;
    try {
      reply = recovery === 'lookup' && gateway.recover ? await gateway.recover(p) : p.kind === 'issue' ? await gateway.issue(p.input) : await gateway.revoke(p.input);
      if (!alive.current) return;
      if (!reply) { setError('尚未查到可确认的结果，不能据此认定操作失败。原编号已保留，可稍后再次核对；确需重试时只使用原编号。'); return; }
      const g = reply.grant;
      if (!g?.grantId || !['active', 'revoked'].includes(g.status) || Date.parse(g.expiresAt) <= Date.parse(g.startsAt) || !['basic', 'star'].includes(g.level) || !Number.isFinite(Date.parse(g.startsAt)) || !Number.isFinite(Date.parse(g.expiresAt)) || (p.kind === 'issue' ? g.userId !== p.input.userId || g.level !== p.input.level : g.grantId !== p.input.grantId || g.status !== 'revoked')) throw Error('返回结果无法确认。');
    } catch (e) {
      if (!alive.current) return;
      if (e instanceof GrantRejection && !recovery) {
        try { journal.write(actorId, null); setPending(null); setPre(null); setConfirmed(false); } catch { setJournalError('操作已被拒绝，但本机恢复记录未能清理，请重新打开后核对。'); }
        throw e;
      }
      setError('本次结果尚未确认。请先核对原操作结果，保持同一操作编号；不要重新赠送或更换账号。'); return;
    }
    try { journal.write(actorId, null); } catch { setJournalError('服务已返回结果，但恢复记录未能清理；请保留操作编号并重新核对。'); return; }
    setPending(null); setResult(reply.grant); setPre(null); setConfirmed(false); setRevokeTarget(null); setRevokeReason('');
    setNotice(`${mode === 'fixture' ? '模拟' : ''}${p.kind === 'issue' ? '赠送' : '撤销'}结果已确认${reply.duplicate ? '（原操作已完成，本次未重复执行）' : ''}。`);
    try { await history(reply.grant.userId); }
    catch { if (alive.current) setError('操作结果已确认，但历史记录刷新失败。请刷新记录，不要再次赠送。'); }
  }
  function issue() {
    if (!validPre || !confirmed || !identity || !pre || !level || locked) return;
    const p: Pending = { kind: 'issue', input: { userId: identity.userId, level, reason: reason.trim(), approvalReference: approval.trim(), confirmationToken: pre.confirmationToken, idempotencyKey: crypto.randomUUID() } };
    void run(() => mutate(p));
  }
  return <main className="grant-page">
    <header className="grant-heading"><div><p className="grant-eyebrow">会员管理 / 独立赠送</p><h1>赠送一年会籍</h1><p>一次核对一个账号，保留原付款与会籍记录。</p></div><span className="grant-badge">单人办理</span></header>
    {mode === 'fixture' && <aside className="grant-demo" role="note"><strong>本地模拟联调 · 仅虚构账号</strong><span>本页不连接业务接口，不会开通真实会籍。刷新保留当前标签页模拟记录；请勿输入真实资料。</span></aside>}
    <div aria-live="polite">{error && <p role="alert" className="grant-error">{error}</p>}{notice && <p role="status" className="grant-success">{notice}</p>}{journalError && <p role="alert" className="grant-error">{journalError}</p>}</div>
    {!authorized && <section className="grant-card"><p>需要核验当前管理员权限，核验通过前不能操作。</p><button disabled={busy} onClick={() => void run(async () => {})}>重新核验登录</button></section>}
    {pending && !authorized && <p className="grant-warning grant-card">存在待核对操作，请先恢复原管理员登录。</p>}
    {pending && authorized && <section className="grant-card grant-warning"><h2>待核对的{pending.kind === 'issue' ? '赠送' : '撤销'}操作</h2><p>操作编号：<code>{pending.input.idempotencyKey}</code></p><p>对象：{pending.kind === 'issue' ? pending.input.userId : pending.input.grantId}</p>{pending.kind === 'issue' && <p>原操作等级：{levelLabel(pending.input.level)}</p>}{gateway.recover && <button disabled={busy || !authorized || !!journalError} onClick={() => void run(() => mutate(pending, 'lookup'))}>核对原操作结果</button>}<button disabled={busy || !authorized || !!journalError} onClick={() => void run(() => mutate(pending, 'retry'))}>核对并重试原操作</button></section>}
    {result && <section className="grant-card grant-result" aria-label="操作结果"><h2>{mode === 'fixture' ? '模拟' : ''}操作结果</h2><p>记录编号：{result.grantId}</p><p>用户编号：{result.userId} · {levelLabel(result.level)} · {grantState(result, now)}</p><p>生效：{shanghaiTime(result.startsAt)}　到期：{shanghaiTime(result.expiresAt)}（北京时间）</p></section>}
    <div className="grant-columns"><section className="grant-card"><h2><span className="grant-step" aria-hidden="true">1</span>核对受赠账号</h2>
      <form onSubmit={e => { e.preventDefault(); if (!locked && query.trim()) lookup(); }}><label>查找方式<select aria-label="查找方式" value={lookupType} disabled={locked} onChange={e => { setLookupType(e.target.value as LookupInput['type']); setQuery(''); resetTarget(); }}><option value="phone">手机号</option><option value="userId">用户编号</option></select></label><label>{lookupType === 'phone' ? '手机号' : '已注册用户编号'}<input autoComplete="off" inputMode={lookupType === 'phone' ? 'tel' : 'text'} value={query} maxLength={lookupType === 'phone' ? 30 : 100} disabled={locked} placeholder={lookupType === 'phone' ? '输入手机号，可含国家或地区代码' : '输入完整用户编号'} onChange={e => { setQuery(e.target.value); resetTarget(); }} /></label><button disabled={locked || !query.trim()}>{busy ? '正在核验…' : '查找账号'}</button></form>
      <p className="grant-muted">手机号仅用于查找。匹配账号仍须核对；多匹配或身份依据不足时不能赠送。</p>
      {identity && <div className="grant-identity"><h3>{identity.displayName}</h3><p>用户编号：{identity.userId}</p><p>联系方式：{identity.maskedContact || '未提供'}</p><p>{identity.evidence}</p><strong>{identity.verified === true ? '身份依据已核验' : '身份依据不足，不能赠送'}</strong><label className="grant-check"><input type="checkbox" checked={checked} disabled={locked || identity.verified !== true} onChange={e => { setChecked(e.target.checked); invalidate(); }} />我已核对该账号与获批受赠对象一致</label></div>}
    </section><section className="grant-card"><h2><span className="grant-step" aria-hidden="true">2</span>赠送预检</h2>
      <label>赠送等级<select aria-label="赠送等级" value={level} disabled={locked} onChange={e => { setLevel(e.target.value as GrantLevel | ''); invalidate(); }}><option value="">请选择获批的等级</option><option value="basic">基础会员</option><option value="star">星级会员</option></select></label>
      <label>赠送原因<textarea aria-label="赠送原因" value={reason} maxLength={500} disabled={locked} onChange={e => { setReason(e.target.value); invalidate(); }} placeholder="填写本次赠送原因" /></label>
      <label>批准依据<input value={approval} maxLength={200} disabled={locked} onChange={e => { setApproval(e.target.value); invalidate(); }} placeholder="填写批准记录编号，不填写私人手机号" /></label>
      <div className="grant-policy"><strong>{level ? levelLabel(level) : '请选择赠送等级'} · 一年</strong><p>从确认成功时起算，按北京时间满一日历年。已有会籍重叠时暂停办理，不自动覆盖或顺延。</p></div>
      <button disabled={locked || !level || identity?.verified !== true || !checked || !reason.trim() || !approval.trim()} onClick={preflight}>检查赠送条件</button>
    </section></div>
    {pre && <section className="grant-card"><h2><span className="grant-step" aria-hidden="true">3</span>确认赠送</h2>
      <h3>原会籍来源</h3>{pre.existing.length ? <ul>{pre.existing.map((e, i) => <li key={i}>{e.source === 'paid' ? '付费' : '赠送'} · {levelLabel(e.level)} · {shanghaiTime(e.startsAt)} 至 {shanghaiTime(e.expiresAt)}</li>)}</ul> : <p>预检未发现现有有效或未来重叠会籍。</p>}
      {pre.blockers.length > 0 && <div role="alert" className="grant-error"><strong>暂不能赠送</strong><ul>{pre.blockers.map((b, i) => <li key={i}>{b}</li>)}</ul></div>}
      {pre.ready && <><p>受赠账号：{identity?.displayName}（{pre.userId}）</p><p>本次赠送：{levelLabel(pre.level)} · 一年</p><p>预计生效：{shanghaiTime(pre.startsAt)}<br />预计到期：{shanghaiTime(pre.expiresAt)}（北京时间；实际时间以确认结果为准）</p><p>预检有效至：{shanghaiTime(pre.confirmationExpiresAt)}</p>{!validPre && <p role="alert" className="grant-error">预检已过期或信息不完整，请重新检查赠送条件。</p>}<label className="grant-check"><input type="checkbox" checked={confirmed} disabled={locked || !validPre} onChange={e => setConfirmed(e.target.checked)} />确认本次赠送一年{levelLabel(pre.level)}，不修改付款订单</label><button className="grant-primary" disabled={locked || !validPre || !confirmed || pre.blockers.length > 0} onClick={issue}>确认赠送</button></>}
    </section>}
    <section className="grant-card"><div className="grant-section-heading"><h2>赠送历史</h2><button disabled={busy || !authorized || !(historyUser || identity?.userId)} onClick={() => void run(() => history(historyUser || identity!.userId))}>刷新记录</button></div>
      {!rows.length ? <p className="grant-muted">{historyUser ? '该账号暂无赠送记录。' : '查找账号后查看其赠送记录。'}</p> : <div className="grant-table-scroll"><table><caption>用户 {historyUser} 的赠送记录（北京时间）</caption><thead><tr><th>会籍与状态</th><th>有效期</th><th>原因与批准依据</th><th>操作记录</th><th>操作</th></tr></thead><tbody>{rows.map(g => <tr key={g.grantId}><td>{levelLabel(g.level)}<br /><span className="grant-state">{grantState(g, now)}</span></td><td>{shanghaiTime(g.startsAt)}<br />至 {shanghaiTime(g.expiresAt)}</td><td>{g.reason}<br /><small>{g.approvalReference}</small></td><td><small>{g.grantId}<br />办理人：{g.actor}{g.revokedAt && <><br />撤销：{shanghaiTime(g.revokedAt)}<br />{g.revokeReason}</>}</small></td><td><button disabled={locked || g.status === 'revoked'} onClick={() => { setRevokeTarget(g); setRevokeReason(''); }}>撤销</button></td></tr>)}</tbody></table></div>}
      {cursor && <button disabled={busy || !authorized} onClick={() => void run(() => history(historyUser, cursor))}>加载更多记录</button>}
    </section>
    {revokeTarget && <section className="grant-card grant-warning" aria-label="撤销确认"><h2>确认撤销这条赠送</h2><p>用户：{revokeTarget.userId}　等级：{levelLabel(revokeTarget.level)}　记录：{revokeTarget.grantId}</p><p>仅撤销这一条赠送，保留其他合法付费或赠送权益及历史。</p><label>撤销原因<textarea aria-label="撤销原因" maxLength={500} value={revokeReason} disabled={locked} onChange={e => setRevokeReason(e.target.value)} /></label><div className="grant-actions"><button disabled={locked || !revokeReason.trim()} onClick={() => { const p: Pending = { kind: 'revoke', input: { grantId: revokeTarget.grantId, userId: revokeTarget.userId, reason: revokeReason.trim(), idempotencyKey: crypto.randomUUID() } }; void run(() => mutate(p)); }}>确认撤销</button><button disabled={busy || !!pending} onClick={() => setRevokeTarget(null)}>取消撤销</button></div></section>}
    <footer className="grant-muted">赠送记录独立保存，不生成付款记录或推荐奖励。手机及报告全文以服务端实际权益为准。</footer>
  </main>;
}
