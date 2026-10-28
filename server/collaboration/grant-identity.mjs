import {digest} from '../domain.mjs';
import {one,fail} from './common.mjs';
import {normalizeEntitlementTime} from './entitlements.mjs';

export async function isOperationalAccount(c, userId) {
  const table = await one(c, "SELECT to_regclass('collab_accounts') AS name");
  return !!table?.name && !!await one(c, 'SELECT user_id FROM collab_accounts WHERE user_id=$1', [userId]);
}

// Local canonicalization only; never sends SMS or consults a third-party service.
// Bare numbers are mainland mobiles. Other countries require an explicit + prefix.
export function normalizeGrantPhone(value) {
  fail(typeof value==='string'&&value.length<=40,'Invalid phone');
  let phone=value.trim().replace(/[ ()-]/g,'');
  if(phone.startsWith('0086'))phone='+86'+phone.slice(4);
  if(/^1[3-9]\d{9}$/.test(phone))phone='+86'+phone;
  fail(/^\+[1-9]\d{7,14}$/.test(phone),'Phone requires a valid international prefix');
  if(phone.startsWith('+86'))fail(/^\+861[3-9]\d{9}$/.test(phone),'Invalid mainland mobile');
  return phone;
}

// resolvePhone must query SERVER-owned verified bindings in the current transaction,
// locking those rows. Self-reported form/profile phone fields are not this source.
export async function resolveGrantPhone(c,{value,actor,now,resolvePhone}) {
  const phone=normalizeGrantPhone(value),phoneMasked=phone.slice(0,-8)+'****'+phone.slice(-4);
  const blocked=code=>({verified:false,code,summary:{verified:false,phoneMasked,evidenceType:'verified-phone-binding'}});
  if(typeof resolvePhone!=='function')return blocked('PHONE_VERIFICATION_UNAVAILABLE');
  const response=await resolvePhone(c,{phone,actor,now});
  if(response?.available!==true||!Array.isArray(response.matches))return blocked('PHONE_VERIFICATION_UNAVAILABLE');
  if(response.matches.length===0)return blocked('PHONE_NOT_FOUND');
  if(response.matches.length!==1)return blocked('IDENTITY_AMBIGUOUS');
  const match=response.matches[0];let normalized,validUntil=null;
  try{normalized=normalizeGrantPhone(match.phone);if(match.expiresAt!=null)validUntil=normalizeEntitlementTime(match.expiresAt);}catch{return blocked('IDENTITY_UNVERIFIED');}
  if(match.verified!==true||normalized!==phone||typeof match.userId!=='string'||!match.userId||
    typeof match.reference!=='string'||!match.reference||typeof match.revision!=='string'||!match.revision||
    (validUntil&&Date.parse(validUntil)<=Date.parse(now)))return blocked('IDENTITY_UNVERIFIED');
  return {verified:true,userId:match.userId,validUntil,summary:{userId:match.userId,verified:true,phoneMasked,evidenceType:'verified-phone-binding'}};
}

// resolveEvidence is a SERVER-owned verified-person-to-account record. A stable
// userId or WeChat binding alone does not prove that this is the approved person.
// Never connect this callback to unverified request fields or a name search.
export function createGrantIdentityVerifier({resolveEvidence} = {}) {
  return async (c, {userId, actor, now}) => {
    const user = await one(c, 'SELECT id,role FROM users WHERE id=$1', [userId]);
    if (!user || user.role !== 'member') return {verified:false, code:'USER_UNAVAILABLE'};
    if (await isOperationalAccount(c, userId)) return {verified:false, code:'OPERATIONAL_ACCOUNT'};
    const raw = typeof resolveEvidence === 'function' ? await resolveEvidence(c, {userId, actor, now}) : null;
    const evidence = Array.isArray(raw) ? (raw.length === 1 ? raw[0] : null) : raw;
    if (Array.isArray(raw) && raw.length > 1) return {verified:false, code:'IDENTITY_AMBIGUOUS'};
    let validUntil=null;
    try { if(evidence?.expiresAt!==undefined && evidence.expiresAt!==null) validUntil=normalizeEntitlementTime(evidence.expiresAt); }
    catch { return {verified:false,code:'IDENTITY_UNVERIFIED'}; }
    if (!evidence || evidence.verified !== true || evidence.userId !== userId ||
        !evidence.appId || !evidence.openId || typeof evidence.reference !== 'string' ||
        !evidence.reference.trim() || typeof evidence.revision !== 'string' || !evidence.revision ||
        (validUntil && !(Date.parse(validUntil) > Date.parse(now)))) {
      return {verified:false, code:'IDENTITY_UNVERIFIED'};
    }
    const matches = (await c.query('SELECT app_id,open_id,user_id FROM wechat_identities WHERE app_id=$1 AND open_id=$2 FOR SHARE', [evidence.appId, evidence.openId])).rows;
    if (matches.length !== 1 || matches[0].user_id !== userId) return {verified:false, code:'IDENTITY_CHANGED'};
    return {
      verified:true,
      // Internal deadline: issue rechecks it after all asynchronous evidence reads.
      validUntil,
      fingerprint:digest(JSON.stringify({binding:matches[0], reference:evidence.reference, revision:evidence.revision, expiresAt:evidence.expiresAt ?? null})),
      summary:{userId, verified:true, evidenceType:'verified-person-wechat-binding', reference:evidence.reference}
    };
  };
}
