// Imported ONLY by the standalone preview entry. Never import in the production shell.
import { GrantRejection, type Grant, type GrantGateway, type IssueInput, type RevokeInput, type Draft, type Preflight, type LookupInput } from './contract';
const storageKey = 'grant-preview-fixtures-v1';
const initial = (): Grant[] => [{ grantId: 'demo-history-01', userId: 'DEMO-001', level: 'star', startsAt: '2024-01-01T00:00:00.000Z', expiresAt: '2025-01-01T00:00:00.000Z', reason: '历史赠送示例', approvalReference: 'SYNTHETIC-HISTORY', actor: 'demo-admin', status: 'active' }];
type Saved = { rows: Grant[]; issues: Record<string, { input: IssueInput; grant: Grant }>; revokes: Record<string, { input: RevokeInput; grant: Grant }>; tokens: Record<string, { input: Draft; expires: number }> };
export function createFixture() {
  const raw = sessionStorage.getItem(storageKey);
  const data: Saved = raw ? JSON.parse(raw) : { rows: initial(), issues: {}, revokes: {}, tokens: {} };
  const control = { actorId: 'demo-admin', canGrant: true, issueReplyLost: false, revokeReplyLost: false, failHistory: false, expirePreflight: false, delay: 20, issueCalls: [] as IssueInput[], revokeCalls: [] as RevokeInput[], rejectNextIssue: false, lookupCalls: [] as LookupInput[] };
  const save = () => sessionStorage.setItem(storageKey, JSON.stringify(data));
  const wait = () => new Promise(resolve => setTimeout(resolve, control.delay));
  function anniversary(start: Date) {
    const local = new Date(start.getTime() + 8 * 3600000), y = local.getUTCFullYear() + 1, m = local.getUTCMonth();
    const day = Math.min(local.getUTCDate(), new Date(Date.UTC(y, m + 1, 0)).getUTCDate());
    return new Date(Date.UTC(y, m, day, local.getUTCHours(), local.getUTCMinutes(), local.getUTCSeconds(), local.getUTCMilliseconds()) - 8 * 3600000).toISOString();
  }
  const validIds = ['DEMO-001', 'DEMO-002', 'DEMO-003'];
  function authorize() { if (!control.canGrant || control.actorId !== 'demo-admin') throw new GrantRejection('模拟管理员权限已失效。', 'FORBIDDEN'); }
  function overlap(id: string) { return id === 'DEMO-002' || data.rows.some(g => g.userId === id && g.status === 'active' && Date.parse(g.expiresAt) > Date.now()); }
  const api: GrantGateway = {
    async checkSession() { await wait(); return { actorId: control.actorId, canGrant: control.canGrant }; },
    async lookup(input) {
      control.lookupCalls.push(structuredClone(input)); await wait(); authorize();
      // +999 is a deliberately fictitious country code, never a real customer number.
      const normalized = input.value.replace(/[ ()-]/g, '');
      if (input.type === 'phone' && normalized === '+9990000004') return { matches: [], blockers: ['当前没有可核验的手机号绑定来源，请改用已核对的用户编号或补充绑定证据。'] };
      const phones: Record<string, string> = { '+9990000001': 'DEMO-001', '+9990000002': 'DEMO-002', '+9990000003': 'DEMO-003', '+9990000099': 'DEMO-MULTI' };
      const userId = input.type === 'phone' ? phones[normalized] : input.value;
      const item = { userId, displayName: '虚构会员甲', maskedContact: '模拟号码 +999****001', verified: userId !== 'DEMO-003', evidence: userId === 'DEMO-003' ? '仅自行填写的号码，尚无可靠绑定核验依据。' : '虚构夹具已核验，仅用于页面测试。' };
      if (userId === 'DEMO-MULTI') return { matches: [item, { ...item, userId: 'DEMO-OTHER', displayName: '同号虚构会员' }], blockers: [] };
      return { matches: validIds.includes(userId) ? [item] : [], blockers: [] };
    },
    async preflight(input) {
      await wait(); authorize();
      if (!['basic', 'star'].includes(input.level)) throw new GrantRejection('请选择获批的等级。', 'INVALID_LEVEL');
      const blocked = overlap(input.userId), startsAt = new Date().toISOString(), expiresAt = anniversary(new Date(startsAt));
      const token = crypto.randomUUID(), expires = Date.now() + (control.expirePreflight ? -1000 : 120000);
      data.tokens[token] = { input: structuredClone(input), expires }; save();
      const pre: Preflight = { userId: input.userId, ready: !blocked && input.userId === 'DEMO-001', blockers: blocked ? ['已有有效或未来重叠会籍，暂停本条赠送；原权益保持不变。'] : [], existing: blocked ? [{ source: 'paid', level: 'basic', startsAt, expiresAt }] : [], level: input.level, startsAt, expiresAt, confirmationToken: token, confirmationExpiresAt: new Date(expires).toISOString() };
      return pre;
    },
    async issue(input) {
      control.issueCalls.push(structuredClone(input)); await wait(); authorize();
      const old = data.issues[input.idempotencyKey];
      if (old) {
        if (JSON.stringify(old.input) !== JSON.stringify(input)) throw new GrantRejection('操作编号已用于不同内容。', 'IDEMPOTENCY_CONFLICT');
        return { grant: structuredClone(old.grant), duplicate: true };
      }
      if (control.rejectNextIssue) { control.rejectNextIssue = false; throw new GrantRejection('原权益已变化，请重新预检。', 'PREFLIGHT_CHANGED'); }
      const token = data.tokens[input.confirmationToken];
      if (!token || token.expires <= Date.now() || JSON.stringify(token.input) !== JSON.stringify({ userId: input.userId, level: input.level, reason: input.reason, approvalReference: input.approvalReference })) throw new GrantRejection('预检已过期或发生变化。', 'PREFLIGHT_CHANGED');
      if (input.userId !== 'DEMO-001' || overlap(input.userId)) throw new GrantRejection('账号不符合赠送条件。', 'PREFLIGHT_BLOCKED');
      const startsAt = new Date().toISOString();
      const grant: Grant = { grantId: 'demo-grant-' + crypto.randomUUID(), userId: input.userId, level: input.level, startsAt, expiresAt: anniversary(new Date(startsAt)), reason: input.reason, approvalReference: input.approvalReference, actor: control.actorId, status: 'active' };
      data.rows.unshift(grant); data.issues[input.idempotencyKey] = { input: structuredClone(input), grant: structuredClone(grant) }; save();
      if (control.issueReplyLost) { control.issueReplyLost = false; throw Error('Synthetic response lost AFTER commit'); }
      return { grant: structuredClone(grant), duplicate: false };
    },
    async list({ userId, cursor }) {
      await wait(); authorize(); if (control.failHistory) throw Error('模拟历史记录读取失败。');
      const all = data.rows.filter(g => g.userId === userId), offset = Number(cursor || 0), items = structuredClone(all.slice(offset, offset + 2));
      return { items, nextCursor: offset + 2 < all.length ? String(offset + 2) : undefined };
    },
    async revoke(input) {
      control.revokeCalls.push(structuredClone(input)); await wait(); authorize();
      const old = data.revokes[input.idempotencyKey];
      if (old) {
        if (JSON.stringify(old.input) !== JSON.stringify(input)) throw new GrantRejection('操作编号冲突。', 'IDEMPOTENCY_CONFLICT');
        return { grant: structuredClone(old.grant), duplicate: true };
      }
      const row = data.rows.find(g => g.grantId === input.grantId);
      if (!row) throw new GrantRejection('赠送记录不存在。', 'NOT_FOUND');
      const duplicate = row.status === 'revoked';
      if (!duplicate) { row.status = 'revoked'; row.revokedAt = new Date().toISOString(); row.revokeReason = input.reason; }
      data.revokes[input.idempotencyKey] = { input: structuredClone(input), grant: structuredClone(row) }; save();
      if (control.revokeReplyLost) { control.revokeReplyLost = false; throw Error('Synthetic revoke response lost AFTER commit'); }
      return { grant: structuredClone(row), duplicate };
    },
  };
  return { api, control, data };
}
