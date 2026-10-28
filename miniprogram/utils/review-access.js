const {api,saveSession,clearSession,sessionStamp,isCurrentSession}=require('./api');
const appId='wx47d5e3e20fd77f65',appVersion='1.1.0';
function reviewAvailable(health){return health?.nativeAuth?.review===true&&health.reviewAccess?.readOnly===true&&health.reviewAccess.appId===appId&&health.reviewAccess.appVersion===appVersion;}
function changed(){const error=new Error('登录页面或账号已变化，请重新操作。');error.code='CONTEXT_CHANGED';return error;}
async function loginReview({username,password,legalConsent},isActive){
  const stamp=sessionStamp();
  const current=()=>isCurrentSession(stamp)&&(!isActive||isActive());
  if(!current())throw changed();
  // Existing transport treats /native/auth/login as unauthenticated. authMode is
  // an explicit dispatch discriminator; there is no reviewer registration path.
  const result=await api('/native/auth/login',{authMode:'review',appId,appVersion,username,password,consent:true,legalConsent});
  if(!current())throw changed();
  if(result?.authMode!=='review'||result.tokenType!=='Bearer'||!/^[a-f0-9]{64}$/.test(result.accessToken||'')||!(Date.parse(result.expiresAt)>Date.now())||result.user?.role!=='reviewer'||result.user.authMode!=='review'||result.reviewAccess?.appId!==appId||result.reviewAccess.appVersion!==appVersion||result.reviewAccess.readOnly!==true||!['basic','star'].includes(result.reviewAccess.planId)||Date.parse(result.expiresAt)>Date.parse(result.reviewAccess.expiresAt)||!Number.isFinite(Date.parse(result.reviewAccess.expiresAt))||!/^review-[a-f0-9-]{36}$/.test(result.user.id||'')||result.user.referralCode!==null||result.user.sourceCode!==null)throw new Error('审核登录返回不正确，请重新检查服务。');
  // Only a successful current login replaces the account. Remove any pending
  // production referral/drafts, and do not run authenticate()'s referral sync.
  // Later memberContext calls must likewise skip review referral sync on server
  // integration; a denied review route must never fall through to production.
  clearSession({logout:true});saveSession(result);
  return result;
}
module.exports={reviewAvailable,loginReview};
