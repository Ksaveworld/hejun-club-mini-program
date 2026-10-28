import {createHmac, timingSafeEqual, randomUUID} from 'node:crypto';
import {digest, validateKey} from '../domain.mjs';
import {fail, one, audit, string} from './common.mjs';
import {calendarYearExpiry, effectiveEntitlements, normalizeEntitlementTime} from './entitlements.mjs';
import {createGrantIdentityVerifier, isOperationalAccount, resolveGrantPhone} from './grant-identity.mjs';

const TOKEN_TTL_MS = 300000;
const states = new Set(['scheduled', 'active', 'expired', 'revoked']);
const hash = value => digest(JSON.stringify(value));
const identityView=(identity,userId)=>({userId,verified:identity?.verified===true,
  evidenceType:identity?.summary?.evidenceType==='verified-person-wechat-binding'?'verified-person-wechat-binding':'server-account-verification'});
function storedTime(value) {
  try { return normalizeEntitlementTime(value); }
  catch { fail(false,'Entitlement data requires reconciliation',503,'ENTITLEMENT_DATA_INVALID'); }
}
const state = (g, now) => g.status === 'revoked' ? 'revoked' : Date.parse(storedTime(g.starts_at)) > Date.parse(now) ? 'scheduled' : Date.parse(storedTime(g.expires_at)) <= Date.parse(now) ? 'expired' : 'active';
const alive = (deadline, now) => deadline===null || Date.parse(deadline)>Date.parse(now);
const overlaps = (sources, now) => sources.some(s=>Date.parse(s.startsAt)<Date.parse(s.expiresAt) && Date.parse(s.startsAt)<Date.parse(calendarYearExpiry(now)) && Date.parse(s.expiresAt)>Date.parse(now));
function object(input, keys) {
  fail(input && typeof input === 'object' && !Array.isArray(input), 'Object input required');
  fail(Object.keys(input).every(k => keys.includes(k)), 'Unsupported request field');
}
function normalize(input, issue = false) {
  object(input, ['userId','level','reason','approvalReference', ...(issue ? ['idempotencyKey','confirmationToken'] : [])]);
  fail(['basic','star'].includes(input.level),'A basic or star level is required');
  return {userId:string(input.userId,'userId',200),level:input.level, reason:string(input.reason,'reason',500), approvalReference:string(input.approvalReference,'approvalReference',200)};
}
function publicGrant(g, now) {
  return {grantId:g.id, userId:g.user_id, level:g.level, startsAt:storedTime(g.starts_at), expiresAt:storedTime(g.expires_at),
    source:'grant', status:state(g,now), reason:g.reason, approvalReference:g.approval_reference,
    actorId:g.actor_id, idempotencyKey:g.idempotency_key, createdAt:storedTime(g.created_at),
    revokedAt:g.revoked_at===null?null:storedTime(g.revoked_at), revokedBy:g.revoked_by, revokeReason:g.revoke_reason};
}

// All callbacks run inside the SAME DB transaction and must have no external
// side effects. They must lock the server-owned identity/approval rows they read.
export function createSingleGrants(access, {policy, clock=()=>new Date().toISOString(), confirmationSecret,
  identityVerifier=createGrantIdentityVerifier(), phoneResolver, approvalResolver, writesEnabled=false, writeCoordinationReady=false} = {}) {
  const run = access.run, writeRun = access.writeRun ?? run;
  const policySnapshot = policy ? JSON.parse(JSON.stringify(policy)) : null;
  const policyHash = hash(policySnapshot);
  const secret = typeof confirmationSecret === 'string' ? Buffer.from(confirmationSecret) : confirmationSecret;
  const readyPolicy = () => policySnapshot?.approved === true && policySnapshot.startRule === 'confirmation-time' &&
    policySnapshot.timeZone === 'Asia/Shanghai' && policySnapshot.yearRule === 'calendar-anniversary-clamp' &&
    policySnapshot.overlap === 'block-active' && typeof policySnapshot.version === 'string' && !!policySnapshot.version;
  const nowISO = () => { try { return normalizeEntitlementTime(clock()); } catch { fail(false,'Invalid server clock',503,'CLOCK_UNAVAILABLE'); } };
  const requireWrites = () => {
    fail(writesEnabled === true, 'Grant writes disabled',503,'FEATURE_DISABLED');
    fail(writeCoordinationReady === true,'Payment and grant coordination is not ready',503,'WRITE_COORDINATION_REQUIRED');
    fail(readyPolicy(),'Business decisions unconfirmed',409,'BUSINESS_DECISIONS_UNCONFIRMED');
  };
  function sign(payload) {
    fail(Buffer.isBuffer(secret) && secret.length >= 32,'Confirmation signing is not configured',503,'CONFIRMATION_NOT_CONFIGURED');
    const data = Buffer.from(JSON.stringify(payload)).toString('base64url');
    return data + '.' + createHmac('sha256',secret).update(data).digest('base64url');
  }
  function verify(token, now) {
    fail(typeof token === 'string' && token.length < 4096,'Invalid confirmation',409,'CONFIRMATION_INVALID');
    fail(Buffer.isBuffer(secret) && secret.length >= 32,'Confirmation signing is not configured',503,'CONFIRMATION_NOT_CONFIGURED');
    const parts = token.split('.'); fail(parts.length===2 && /^[A-Za-z0-9_-]+$/.test(parts[0]) && /^[A-Za-z0-9_-]+$/.test(parts[1]),'Invalid confirmation',409,'CONFIRMATION_INVALID');
    const actual = Buffer.from(parts[1],'base64url'), expected = createHmac('sha256',secret).update(parts[0]).digest();
    fail(actual.length===expected.length && timingSafeEqual(actual,expected),'Invalid confirmation',409,'CONFIRMATION_INVALID');
    let p; try {p=JSON.parse(Buffer.from(parts[0],'base64url').toString('utf8'));} catch {fail(false,'Invalid confirmation',409,'CONFIRMATION_INVALID');}
    fail(p?.v===1 && Number.isFinite(Date.parse(p.expiresAt)) && Date.parse(p.expiresAt)>Date.parse(now) && Date.parse(p.issuedAt)<=Date.parse(now),'Confirmation expired',409,'CONFIRMATION_EXPIRED');
    return p;
  }
  async function inspect(c, actor, request, now) {
    const blockers=[];
    if(!readyPolicy()) blockers.push({code:'BUSINESS_DECISIONS_UNCONFIRMED'});
    const user=await one(c,'SELECT id,role FROM users WHERE id=$1',[request.userId]);
    if(!user || user.role!=='member') blockers.push({code:'USER_UNAVAILABLE'});
    else if(await isOperationalAccount(c,request.userId)) blockers.push({code:'OPERATIONAL_ACCOUNT'});
    const identity = blockers.length ? {verified:false} : await identityVerifier(c,{userId:request.userId,actor,now});
    let identityValidUntil=null;
    try { if(identity?.validUntil!==undefined && identity.validUntil!==null) identityValidUntil=normalizeEntitlementTime(identity.validUntil); }
    catch { blockers.push({code:'IDENTITY_UNVERIFIED'}); }
    if(!identity?.verified || typeof identity.fingerprint!=='string' || !alive(identityValidUntil,now)) blockers.push({code:identity?.code || 'IDENTITY_UNVERIFIED'});
    const approval = typeof approvalResolver==='function' ? await approvalResolver(c,{...request, actor, now}) : null;
    let approvalValidUntil=null,validApprovalDate=true;
    try { if(approval?.expiresAt!==undefined && approval.expiresAt!==null) approvalValidUntil=normalizeEntitlementTime(approval.expiresAt); }
    catch { validApprovalDate=false; }
    const approved = approval?.approved===true && approval.userId===request.userId && approval.level===request.level &&
      approval.reference===request.approvalReference && typeof approval.revision==='string' && !!approval.revision &&
      (!approval.actorId || approval.actorId===actor.id) && validApprovalDate && alive(approvalValidUntil,now);
    if(!approved) blockers.push({code:'APPROVAL_REQUIRED'});
    const paid=await one(c,'SELECT user_id,order_id,plan_id,starts_at,expires_at FROM memberships WHERE user_id=$1',[request.userId]);
    const grants=(await c.query('SELECT id,user_id,level,starts_at,expires_at,status,revoked_at FROM collab_grants WHERE user_id=$1 ORDER BY id',[request.userId])).rows;
    const expiresAt=calendarYearExpiry(now);
    let invalid=false;
    const sources=[...(paid?[{source:'paid',id:paid.order_id,planId:paid.plan_id,startsAt:paid.starts_at,expiresAt:paid.expires_at}]:[]),
      ...grants.filter(g=>g.status==='active').map(g=>({source:'grant',id:g.id,planId:g.level,startsAt:g.starts_at,expiresAt:g.expires_at}))];
    // A paid source may legitimately be shortened to an empty interval by
    // aftercare; it is inactive and must not block an otherwise valid grant.
    for(const s of sources) { try { s.startsAt=normalizeEntitlementTime(s.startsAt);s.expiresAt=normalizeEntitlementTime(s.expiresAt);if(Date.parse(s.startsAt)>Date.parse(s.expiresAt))invalid=true; } catch { invalid=true; } }
    if(invalid) blockers.push({code:'ENTITLEMENT_DATA_INVALID'});
    if(!invalid && overlaps(sources,now)) blockers.push({code:'EXISTING_ENTITLEMENT'});
    const approvalSnapshot=approved?{userId:approval.userId,level:approval.level,reference:approval.reference,revision:approval.revision,actorId:approval.actorId??null,expiresAt:approval.expiresAt??null}:null;
    return {ready:blockers.length===0,blockers,approvalReference:request.approvalReference,identitySummary:identityView(identity,request.userId),
      existingEntitlements:sources, proposal:{level:request.level,startsAt:now,expiresAt,timeZone:'Asia/Shanghai',policyVersion:policySnapshot?.version??null,startIsEstimate:true},
      validity:{identityValidUntil,approvalValidUntil},
      binding:{snapshotHash:hash({paid:paid??null,grants}),identityHash:identity?.fingerprint??null,approvalHash:hash(approvalSnapshot)}};
  }
  function assertEvidenceCurrent(check, now) {
    fail(alive(check.validity.identityValidUntil,now) && alive(check.validity.approvalValidUntil,now),'Identity or approval expired; review again',409,'PREFLIGHT_CHANGED');
  }
  async function result(c, row, now, duplicate) { return {...publicGrant(row,now),duplicate,effectiveEntitlements:await effectiveEntitlements(c,row.user_id,now)}; }
  return {
    lookup:(actor,input)=>run(async c=>{
      await access.platform(c,actor);object(input,['type','value']);fail(['userId','phone'].includes(input.type),'Use an exact userId or phone');
      const now=nowISO();
      const phone=input.type==='phone'?await resolveGrantPhone(c,{value:input.value,actor,now,resolvePhone:phoneResolver}):null;
      if(phone&&!phone.verified)return {userId:null,verified:false,identitySummary:phone.summary,blockers:[{code:phone.code}]};
      const userId=phone?.userId??string(input.value,'value',200);
      const user=await one(c,'SELECT id,role FROM users WHERE id=$1',[userId]);
      const identity=!user||user.role!=='member'?{verified:false,code:'USER_UNAVAILABLE'}:
        await isOperationalAccount(c,userId)?{verified:false,code:'OPERATIONAL_ACCOUNT'}:await identityVerifier(c,{userId,actor,now});
      const lookupNow=nowISO(),verified=identity?.verified===true&&alive(identity.validUntil??null,lookupNow)&&alive(phone?.validUntil??null,lookupNow);
      return {userId,verified,identitySummary:{...identityView(identity,userId),...(phone?{phoneMasked:phone.summary.phoneMasked}:{}),verified},blockers:verified?[]:[{code:identity?.code??'IDENTITY_UNVERIFIED'}]};
    }),
    preflight:(actor,input)=>run(async c=>{
      await access.platform(c,actor); const request=normalize(input),now=nowISO(),check=await inspect(c,actor,request,now);
      const {binding,validity,...view}=check;
      if(!check.ready)return {...view,writes:0};
      assertEvidenceCurrent(check,nowISO());
      const expiresAt=new Date(Date.parse(now)+TOKEN_TTL_MS).toISOString();
      return {...view,writes:0,confirmationToken:sign({v:1,actorId:actor.id,requestHash:hash(request),policyHash,...binding,issuedAt:now,expiresAt}),expiresAt};
    }),
    issue:(actor,input)=>writeRun(async c=>{
      await access.platform(c,actor); requireWrites(); const request=normalize(input,true);validateKey(input.idempotencyKey);
      const requestHash=hash({actorId:actor.id,request}),key=input.idempotencyKey;
      // Global batch key precedes target lock. Two disjoint requests using one key
      // cannot each create a grant. The batch insert is rolled back on any failure.
      await c.query('INSERT INTO collab_grant_batches(idempotency_key,request_hash,created_at) VALUES($1,$2,$3) ON CONFLICT DO NOTHING',[key,requestHash,nowISO()]);
      const batch=await one(c,'SELECT * FROM collab_grant_batches WHERE idempotency_key=$1 FOR UPDATE',[key]);
      fail(batch.request_hash===requestHash,'Idempotency key was used for another request',409,'IDEMPOTENCY_CONFLICT');
      const user=await one(c,'SELECT id,role FROM users WHERE id=$1 FOR UPDATE',[request.userId]);
      fail(user?.role==='member','Consumer account unavailable',404,'USER_UNAVAILABLE');
      const now=nowISO();
      const existing=await one(c,'SELECT * FROM collab_grants WHERE idempotency_key=$1',[key]);
      if(existing){
        fail(existing.request_hash===requestHash,'Idempotency conflict',409,'IDEMPOTENCY_CONFLICT');
        // A successful retry remains valid after token expiry, but never after
        // authorization, reliable identity, or per-user approval was withdrawn.
        const check=await inspect(c,actor,request,now);
        fail(!check.blockers.some(b=>b.code!=='EXISTING_ENTITLEMENT'),'Identity or approval changed',409,'PREFLIGHT_CHANGED');
        await access.platform(c,actor);const replayNow=nowISO();assertEvidenceCurrent(check,replayNow);
        return result(c,existing,replayNow,true);
      }
      const token=verify(input.confirmationToken,now);
      fail(token.actorId===actor.id && token.requestHash===hash(request) && token.policyHash===policyHash,'Confirmation target or policy changed',409,'PREFLIGHT_CHANGED');
      const check=await inspect(c,actor,request,now);
      fail(check.ready,'Grant preflight blocked',409,'PREFLIGHT_BLOCKED');
      fail(Object.entries(check.binding).every(([k,v])=>token[k]===v),'Identity, approval or entitlements changed',409,'PREFLIGHT_CHANGED');
      // Recheck expiry after any evidence-provider wait. Held rows prevent role,
      // binding and approval mutations; elapsed time can still expire a session.
      await access.platform(c,actor);
      const confirmedAt=nowISO();verify(input.confirmationToken,confirmedAt);assertEvidenceCurrent(check,confirmedAt);
      fail(!overlaps(check.existingEntitlements,confirmedAt),'Grant preflight blocked',409,'PREFLIGHT_BLOCKED');
      const row=await one(c,"INSERT INTO collab_grants(id,user_id,level,starts_at,expires_at,reason,approval_reference,actor_id,status,idempotency_key,request_hash,created_at) VALUES($1,$2,$10,$3,$4,$5,$6,$7,'active',$8,$9,$3) RETURNING *",[randomUUID(),request.userId,confirmedAt,calendarYearExpiry(confirmedAt),request.reason,request.approvalReference,actor.id,key,requestHash,request.level]);
      await audit(c,actor.id,'collab.grant.issued',row.id,{userId:request.userId,level:request.level,startsAt:row.starts_at,expiresAt:row.expires_at,reason:request.reason,approvalReference:request.approvalReference,idempotencyKey:key,policyVersion:policySnapshot.version},confirmedAt);
      return result(c,row,confirmedAt,false);
    }),
    revoke:(actor,id,input)=>writeRun(async c=>{
      await access.platform(c,actor);requireWrites();object(input,['reason']);const reason=string(input.reason,'reason',500);id=string(id,'grantId',200);
      const ref=await one(c,'SELECT user_id FROM collab_grants WHERE id=$1',[id]);fail(ref,'Grant unavailable',404,'NOT_FOUND');
      await one(c,'SELECT id FROM users WHERE id=$1 FOR UPDATE',[ref.user_id]);
      const grant=await one(c,'SELECT * FROM collab_grants WHERE id=$1 FOR UPDATE',[id]);
      await access.platform(c,actor);
      const now=nowISO();
      if(grant.status==='revoked')return result(c,grant,now,true);
      const row=await one(c,"UPDATE collab_grants SET status='revoked',revoked_at=$1,revoked_by=$2,revoke_reason=$3 WHERE id=$4 RETURNING *",[now,actor.id,reason,id]);
      await audit(c,actor.id,'collab.grant.revoked',id,{reason,userId:grant.user_id},now);
      return result(c,row,now,false);
    }),
    operation:(actor,key)=>run(async c=>{
      await access.platform(c,actor);validateKey(key);
      const row=await one(c,'SELECT * FROM collab_grants WHERE idempotency_key=$1',[key]);
      // A concurrently running transaction may not yet be visible. Absence is
      // UNKNOWN, never evidence that a new key is safe or that payment failed.
      return row?{found:true,outcome:'committed',grant:await result(c,row,nowISO(),true)}:{found:false,outcome:'unknown',grant:null};
    }),
    list:(actor,filters={})=>run(async c=>{
      await access.platform(c,actor);object(filters,['userId','status','cursor','limit']);
      const userId=filters.userId===undefined?null:string(filters.userId,'userId',200),status=filters.status??null;
      fail(status===null||states.has(status),'Invalid status');
      const limit=filters.limit===undefined?25:Number(filters.limit);fail(Number.isSafeInteger(limit)&&limit>=1&&limit<=100,'Invalid page limit');
      let cursor=null;const now=nowISO();
      if(filters.cursor){try{fail(typeof filters.cursor==='string'&&filters.cursor.length<2048,'Invalid cursor');cursor=JSON.parse(Buffer.from(filters.cursor,'base64url').toString('utf8'));}catch{fail(false,'Invalid cursor');}
        fail(cursor?.userId===userId && cursor?.status===status && typeof cursor.createdAt==='string' && typeof cursor.id==='string' && cursor.id.length>0 && cursor.id.length<=200,'Cursor does not match filter');
        cursor.asOf=normalizeEntitlementTime(cursor.asOf);cursor.createdAt=normalizeEntitlementTime(cursor.createdAt);
        fail(Date.parse(cursor.asOf)<=Date.parse(now),'Cursor time is in the future');}
      const asOf=cursor?.asOf??now;
      let rows;
      try { rows=(await c.query(`SELECT * FROM collab_grants WHERE ($1::text IS NULL OR user_id=$1)
        AND ($2::text IS NULL OR CASE WHEN status='revoked' THEN 'revoked' WHEN starts_at::timestamptz>$3::timestamptz THEN 'scheduled' WHEN expires_at::timestamptz<=$3::timestamptz THEN 'expired' ELSE 'active' END=$2)
        AND ($4::text IS NULL OR (created_at::timestamptz,id)<($4::timestamptz,$5)) ORDER BY created_at::timestamptz DESC,id DESC LIMIT $6`,[userId,status,asOf,cursor?.createdAt??null,cursor?.id??null,limit+1])).rows; }
      catch(error) { if(['22007','22008'].includes(error.code))fail(false,'Entitlement data requires reconciliation',503,'ENTITLEMENT_DATA_INVALID');throw error; }
      const page=rows.slice(0,limit),last=page.at(-1);
      return {items:page.map(g=>publicGrant(g,asOf)),asOf,nextCursor:rows.length>limit?Buffer.from(JSON.stringify({userId,status,createdAt:storedTime(last.created_at),id:last.id,asOf})).toString('base64url'):null};
    }),
    effectiveInTransaction:effectiveEntitlements
  };
}
