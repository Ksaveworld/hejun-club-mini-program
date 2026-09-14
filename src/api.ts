import { isWebTrial } from './web-env';
import type { JoinForm, PlanId } from './types';
import { isPresentation } from './presentation';
export interface User {
  id: string; username: string; role: 'member' | 'admin'; referralCode: string;
  sourceCode: string | null; referralSource: 'explicit' | 'default' | null;
  referralLockedAt: string | null; phoneVerified: boolean;
}
export interface Membership { planId: PlanId; orderId: string; startsAt: string; expiresAt: string; active: boolean }
export interface Session { user: User | null; membership: Membership | null; paymentReady: boolean; defaultReferralConfigured: boolean }
export interface Order {
  id: string; userId: string; planId: PlanId; amountCents: number; actualPaidCents: number | null;
  currency: string; status: 'review' | 'pending' | 'paid' | 'cancelled' | 'rejected';
  form: JoinForm; createdAt: string; paidAt: string | null; expiresAt: string | null;
  reviewNote: string | null; reviewedAt: string | null; sourceCode: string | null;
  referralSource: string | null;
}
export interface Post { id: string; userId: string; title: string; body: string; status: 'pending' | 'published' | 'rejected'; reason: string | null; createdAt: string }
export const statusLabels = { review:'待资质审核', pending:'待付款', paid:'已付款', cancelled:'已取消', rejected:'审核未通过' };
export const postLabels = { pending:'待审核', published:'已通过', rejected:'已驳回' };
let webActor: string | null = null;
export function setWebActor(id: string | null) { webActor=id; }
export async function api<T>(path: string, body?: unknown, key?: string): Promise<T> {
  if (isPresentation) throw new Error('当前为界面演示，登录、资料提交与订单保存暂未开放。');
  let response: Response;
  try {
    response = await fetch(`${isWebTrial ? '/hejun-club/api' : '/api'}${path}`, { method: body === undefined ? 'GET' : 'POST',
      credentials:'same-origin', headers:{ 'Content-Type':'application/json','X-Club-Request':'1', ...(key ? { 'Idempotency-Key':key } : {}), ...(isWebTrial && webActor ? {'X-Club-Actor':webActor} : {}) },
      body:body === undefined ? undefined : JSON.stringify(body) });
  } catch { throw new Error('暂时连接不上数据服务，请确认本地服务已启动后重试。'); }
  let data;
  try { data = await response.json(); } catch { throw new Error('数据服务未启动或返回异常，请稍后重试。'); }
  if (!response.ok) throw Object.assign(new Error(data.error || '操作未完成，请稍后重试。'), { status: response.status });
  return data;
}
export const errorText = (error: unknown) => error instanceof Error ? error.message : '操作未完成，请重试';
const referralKey = 'club-first-referral';
// This browser hint is not trusted: the server validates ownership and first-source rules.
export function rememberReferral() {
  const code = new URLSearchParams(window.location.search).get('ref') || new URLSearchParams(window.location.hash.split('?')[1]).get('ref');
  if (code && /^[a-zA-Z0-9]{6}$/.test(code)) {
    try { if (!sessionStorage.getItem(referralKey)) sessionStorage.setItem(referralKey,code.toUpperCase()); } catch { /* Form remains available. */ }
  }
}
export function referralHint() { try { return sessionStorage.getItem(referralKey) || ''; } catch { return ''; } }
export function clearReferralHint() { try { sessionStorage.removeItem(referralKey); } catch { /* Optional browser hint. */ } }
