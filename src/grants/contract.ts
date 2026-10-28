// UI port only. HTTP paths and server DTOs remain owned by GRANT-01/03.
export type GrantLevel = 'basic' | 'star';
export const levelLabel = (level: string) => level === 'basic' ? '基础会员' : level === 'star' ? '星级会员' : '未知等级';
export type LookupInput = { type: 'userId' | 'phone'; value: string };
export type LookupResult = { matches: Identity[]; blockers: string[] };
export type Identity = { userId: string; displayName: string; maskedContact: string; verified: boolean; evidence: string };
export type Entitlement = { source: 'paid' | 'grant'; level: string; startsAt: string; expiresAt: string };
export type Draft = { userId: string; level: GrantLevel; reason: string; approvalReference: string };
export type Preflight = { userId: string; ready: boolean; blockers: string[]; existing: Entitlement[]; level: GrantLevel; startsAt: string; expiresAt: string; confirmationToken: string; confirmationExpiresAt: string };
export type Grant = { grantId: string; userId: string; level: GrantLevel; startsAt: string; expiresAt: string; reason: string; approvalReference: string; actor: string; status: 'active' | 'revoked'; revokedAt?: string; revokeReason?: string };
export type IssueInput = Draft & { confirmationToken: string; idempotencyKey: string };
export type RevokeInput = { grantId: string; reason: string; idempotencyKey: string };
export type Pending = { kind: 'issue'; input: IssueInput } | { kind: 'revoke'; input: RevokeInput };
export interface GrantGateway {
  checkSession(): Promise<{ actorId: string; canGrant: boolean }>;
  lookup(input: LookupInput): Promise<LookupResult>;
  preflight(input: Draft): Promise<Preflight>;
  issue(input: IssueInput): Promise<{ grant: Grant; duplicate: boolean }>;
  list(input: { userId: string; cursor?: string }): Promise<{ items: Grant[]; nextCursor?: string }>;
  revoke(input: RevokeInput): Promise<{ grant: Grant; duplicate: boolean }>;
}
// Only use this for a server response guaranteed not to have committed.
// Network failures, invalid JSON and ambiguous responses MUST remain ordinary errors.
export class GrantRejection extends Error {
  constructor(message: string, public readonly code: string) { super(message); }
}
export interface GrantJournal { read(actorId: string): Pending | null; write(actorId: string, value: Pending | null): void }
export const sessionJournal: GrantJournal = {
  read(actorId) {
    const raw = sessionStorage.getItem('grant-ui-pending-v1:' + actorId);
    if (!raw) return null;
    const p = JSON.parse(raw) as Pending;
    if (!p || !['issue', 'revoke'].includes(p.kind) || typeof p.input?.idempotencyKey !== 'string') throw Error('待核对操作记录损坏，请保留本页并联系管理员核对。');
    if (p.kind === 'issue' && [p.input.userId, p.input.reason, p.input.approvalReference, p.input.confirmationToken].some(v => typeof v !== 'string' || !v)) throw Error('赠送恢复记录不完整。');
    if (p.kind === 'issue' && !['basic', 'star'].includes(p.input.level)) throw Error('旧版或损坏的待核对操作缺少等级，请先按原操作编号核对结果，勿新建赠送。');
    if (p.kind === 'revoke' && [p.input.grantId, p.input.reason].some(v => typeof v !== 'string' || !v)) throw Error('撤销恢复记录不完整。');
    return p;
  },
  write(actorId, value) {
    const key = 'grant-ui-pending-v1:' + actorId;
    if (value) sessionStorage.setItem(key, JSON.stringify(value)); else sessionStorage.removeItem(key);
  },
};
export function grantState(g: Grant, now = Date.now()) {
  if (g.status === 'revoked') return '已撤销';
  if (Date.parse(g.startsAt) > now) return '未开始';
  return Date.parse(g.expiresAt) <= now ? '已到期' : '有效';
}
export function shanghaiTime(value: string) {
  const time = Date.parse(value);
  return Number.isFinite(time) ? new Intl.DateTimeFormat('zh-CN', { timeZone: 'Asia/Shanghai', year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', second: '2-digit', hour12: false }).format(time) : '时间不可用';
}
