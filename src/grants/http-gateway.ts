import {GrantRejection, type Grant, type GrantGateway, type Pending, type Draft, type Entitlement} from './contract.ts';

type Session = {actorId: string; canGrant: boolean};
type Options = {actorId: string; checkSession: () => Promise<Session>; fetchImpl?: typeof fetch; basePath?: string; timeoutMs?: number};
type RecordValue = Record<string, unknown>;
const blockers: Record<string, string> = {
  USER_UNAVAILABLE:'未找到可用的已注册消费账号。',OPERATIONAL_ACCOUNT:'运营账号不能作为受赠账号。',
  IDENTITY_UNVERIFIED:'账号身份依据不足，请先完成可靠核验。',IDENTITY_CHANGED:'账号绑定已变化，请重新核对。',
  IDENTITY_AMBIGUOUS:'匹配到多个账号，不能自动选择。',PHONE_NOT_FOUND:'未找到已核验的手机号绑定。',
  PHONE_VERIFICATION_UNAVAILABLE:'当前没有可信手机号绑定来源，请使用已核对的用户编号。',
  PHONE_AMBIGUOUS:'手机号对应多个账号，请先核对绑定。',APPROVAL_REQUIRED:'缺少与本账号及所选等级对应的有效批准依据。',
  EXISTING_ENTITLEMENT:'存在有效或未来重叠会籍，本次不能赠送。',BUSINESS_DECISIONS_UNCONFIRMED:'赠送策略尚未就绪。',
  ENTITLEMENT_DATA_INVALID:'原权益数据需核查，已阻止本次赠送。'
};
const rejections: Record<string, string> = {
  INVALID_REQUEST:'输入格式不正确，请核对后重试。',INVALID_LEVEL:'请选择已批准的赠送等级。',
  AUTH_REQUIRED:'后台登录已失效，请重新登录。',FORBIDDEN:'当前账号没有赠送管理权限。',
  ACCOUNT_DISABLED:'当前账号不可用。',AUTH_AMBIGUOUS:'登录身份不明确，请重新登录。',
  ORIGIN_REJECTED:'请求来源不正确，请从正式管理后台重新进入。',CSRF_REJECTED:'请求校验失败，请刷新后重试。',
  ACTOR_CHANGED:'管理员身份已变化，请重新登录后核对。',OPERATIONAL_ACCOUNT:blockers.OPERATIONAL_ACCOUNT,
  NOT_FOUND:'请求对象不可用。',USER_UNAVAILABLE:blockers.USER_UNAVAILABLE,
  PREFLIGHT_BLOCKED:'预检未通过，请重新核对账号、等级和批准依据。',PREFLIGHT_CHANGED:'核对信息已变化，请重新预检。',
  CONFIRMATION_INVALID:'确认凭据无效，请重新预检。',CONFIRMATION_EXPIRED:'确认凭据已过期，请重新预检。',
  IDEMPOTENCY_CONFLICT:'原操作编号与本次内容不一致，请保留编号并核查原记录。',
  BUSINESS_DECISIONS_UNCONFIRMED:blockers.BUSINESS_DECISIONS_UNCONFIRMED,
  PAYLOAD_TOO_LARGE:'提交内容过长。',UNSUPPORTED_MEDIA_TYPE:'提交格式不正确，请刷新页面。'
};
function malformed(): never {throw Error('服务返回结果不完整，操作结果仍需核对。');}
function record(value: unknown): RecordValue {if(!value||typeof value!=='object'||Array.isArray(value))return malformed();return value as RecordValue;}
function text(value: unknown): string {if(typeof value!=='string'||!value)return malformed();return value;}
function time(value: unknown): string {const v=text(value);if(!Number.isFinite(Date.parse(v)))return malformed();return v;}
function blockList(value: unknown): string[] {
  if(!Array.isArray(value))return malformed();
  return value.map(item=>{const code=text(record(item).code);return blockers[code]??'账号或赠送条件尚未满足，请核对后重试。';});
}
function grant(value: unknown): Grant {
  const g=record(value),level=g.level,status=g.status,startsAt=time(g.startsAt),expiresAt=time(g.expiresAt);
  if(!['basic','star'].includes(String(level))||!['scheduled','active','expired','revoked'].includes(String(status))||Date.parse(expiresAt)<=Date.parse(startsAt))return malformed();
  return {grantId:text(g.grantId),userId:text(g.userId),level:level as Grant['level'],startsAt,expiresAt,
    reason:text(g.reason),approvalReference:text(g.approvalReference),actor:text(g.actorId),status:status==='revoked'?'revoked':'active',
    ...(g.revokedAt!=null?{revokedAt:time(g.revokedAt)}:{}),...(typeof g.revokeReason==='string'?{revokeReason:g.revokeReason}:{})};
}

export function createGrantHttpGateway({actorId,checkSession,fetchImpl=fetch,basePath='/api/admin/membership-grants',timeoutMs=15000}: Options): GrantGateway {
  if(!actorId||!basePath.startsWith('/')||basePath.startsWith('//')||/[?#]/.test(basePath)||!Number.isFinite(timeoutMs)||timeoutMs<=0)throw Error('赠送后台适配配置无效。');
  async function session(): Promise<Session> {
    let timer: ReturnType<typeof setTimeout> | undefined;
    let value: Session;
    try {
      value=await Promise.race([checkSession(),new Promise<never>((_resolve,reject)=>{timer=setTimeout(()=>reject(Error('session timeout')),timeoutMs);})]);
    } catch {throw Error('后台会话暂时无法核验，请稍后重试；原待核对操作仍需保留。');}
    finally {if(timer!==undefined)clearTimeout(timer);}
    if(value?.actorId!==actorId||value?.canGrant!==true)throw new GrantRejection('管理员身份已变化或权限已失效，请重新登录。','FORBIDDEN');
    return value;
  }
  async function request(path: string, input?: unknown): Promise<RecordValue> {
    await session();
    const controller=new AbortController(),timer=setTimeout(()=>controller.abort(),timeoutMs);
    try {
      const response=await fetchImpl(basePath+path,{method:input===undefined?'GET':'POST',credentials:'same-origin',cache:'no-store',signal:controller.signal,
        headers:input===undefined?{}:{'content-type':'application/json','x-club-request':'1','x-club-actor':actorId},
        ...(input===undefined?{}:{body:JSON.stringify(input)})});
      if(!response.headers.get('content-type')?.toLowerCase().startsWith('application/json'))return malformed();
      let payload: unknown;try{payload=await response.json();}catch{return malformed();}
      const value=record(payload);
      if(!response.ok){
        const code=typeof value.code==='string'?value.code:'';
        if([400,401,403,404,409,413,415].includes(response.status)&&Object.hasOwn(rejections,code))throw new GrantRejection(rejections[code],code);
        throw Error('服务暂时无法确认结果，请保留原操作编号并稍后核对。');
      }
      // Do not display a stale response after logout/account switching.
      try {await session();} catch {throw Error('响应返回时管理员身份已变化，操作结果仍需核对。');}
      return value;
    } catch(error) {
      if(error instanceof GrantRejection)throw error;
      throw Error('操作结果尚未确认，请保留原操作编号并核对结果。');
    } finally {clearTimeout(timer);}
  }
  async function listed(userId: string,cursor?: string) {
    const query=new URLSearchParams({userId});if(cursor)query.set('cursor',cursor);
    const response=await request('?'+query.toString());if(!Array.isArray(response.items))return malformed();
    const items=response.items.map(grant);if(items.some(g=>g.userId!==userId))return malformed();
    const nextCursor=response.nextCursor==null?undefined:text(response.nextCursor);
    return {items,nextCursor};
  }
  async function issued(input: Draft & {confirmationToken:string;idempotencyKey:string}) {
    const response=await request('',input),g=grant(response);
    if(g.userId!==input.userId||g.level!==input.level||typeof response.duplicate!=='boolean')return malformed();
    return {grant:g,duplicate:response.duplicate};
  }
  return {
    checkSession:session,
    async lookup(input) {
      const response=await request('/lookup',input),problems=blockList(response.blockers);
      if(typeof response.verified!=='boolean')return malformed();
      if(response.verified!==true||problems.length)return {matches:[],blockers:problems.length?problems:[blockers.IDENTITY_UNVERIFIED]};
      const userId=text(response.userId),identity=record(response.identitySummary);
      if(identity.userId!==userId||identity.verified!==true||(input.type==='userId'&&userId!==input.value.trim()))return malformed();
      return {matches:[{userId,displayName:userId,maskedContact:typeof identity.phoneMasked==='string'?identity.phoneMasked:'',verified:true,
        evidence:identity.evidenceType==='verified-person-wechat-binding'?'已核验人员与微信消费账号绑定。':'服务端已核验账号身份依据。'}],blockers:[]};
    },
    async preflight(input) {
      const response=await request('/preflight',input),proposal=record(response.proposal),identity=record(response.identitySummary),problems=blockList(response.blockers);
      if(typeof response.ready!=='boolean'||identity.userId!==input.userId||proposal.level!==input.level||!Array.isArray(response.existingEntitlements))return malformed();
      const existing=response.existingEntitlements.map((item): Entitlement=>{const e=record(item);if(e.source!=='paid'&&e.source!=='grant')return malformed();return {source:e.source,level:text(e.planId),startsAt:time(e.startsAt),expiresAt:time(e.expiresAt)};});
      const ready=response.ready===true&&problems.length===0,startsAt=time(proposal.startsAt),expiresAt=time(proposal.expiresAt);
      if(ready&&(identity.verified!==true||Date.parse(expiresAt)<=Date.parse(startsAt)))return malformed();
      return {userId:input.userId,ready,blockers:problems,existing,level:input.level,startsAt,expiresAt,
        confirmationToken:ready?text(response.confirmationToken):'',confirmationExpiresAt:ready?time(response.expiresAt):''};
    },
    issue:issued,
    list:({userId,cursor})=>listed(userId,cursor),
    async revoke(input) {
      const response=await request('/'+encodeURIComponent(input.grantId)+'/revoke',{reason:input.reason}),g=grant(response);
      if(g.grantId!==input.grantId||g.status!=='revoked'||typeof response.duplicate!=='boolean')return malformed();
      return {grant:g,duplicate:response.duplicate};
    },
    async recover(pending: Pending) {
      if(pending.kind==='issue'){
        const response=await request('/operations/'+encodeURIComponent(pending.input.idempotencyKey));
        if(response.found===false&&response.outcome==='unknown'&&response.grant===null)return null;
        if(response.found!==true||response.outcome!=='committed')return malformed();
        const g=grant(response.grant);if(g.userId!==pending.input.userId||g.level!==pending.input.level)return malformed();
        return {grant:g,duplicate:true};
      }
      if(!pending.input.userId)return null;
      let cursor: string|undefined;const seen=new Set<string>();
      do {
        const page=await listed(pending.input.userId,cursor),g=page.items.find(g=>g.grantId===pending.input.grantId);
        if(g)return g.status==='revoked'?{grant:g,duplicate:true}:null;
        cursor=page.nextCursor;if(cursor){if(seen.has(cursor)||seen.size>=100)return malformed();seen.add(cursor);}
      } while(cursor);
      return null;
    }
  };
}
