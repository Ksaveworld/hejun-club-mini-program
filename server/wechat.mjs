import { authError } from './native-auth.mjs';

// Official reference: https://developers.weixin.qq.com/miniprogram/dev/server/API/user-login/api_code2session.html
// Only server configuration can supply credentials or a test transport; clients cannot choose the upstream URL.
export function createWechatAdapter({ appId, appSecret, fetchImpl = globalThis.fetch, clock = Date.now } = {}) {
  const configured = typeof appId === 'string' && appId.trim().length > 0
    && typeof appSecret === 'string' && appSecret.trim().length > 0;
  let cachedToken, tokenPending;
  async function exchange(code) {
    return adapter.exchangeCode(code, true);
  }
  const adapter = {
    configured, appId: configured ? appId : null,
    async exchangeCode(code, paymentOnly = false) {
      if (!configured) throw authError('微信登录尚未配置', 503, 'WECHAT_NOT_CONFIGURED');
      if (typeof code !== 'string' || !code.length || code.length > 512 || /\s/.test(code))
        throw authError('微信登录凭证不正确，请重试', 400, 'INVALID_REQUEST');
      const url = new URL('https://api.weixin.qq.com/sns/jscode2session');
      url.search = new URLSearchParams({ appid: appId, secret: appSecret, js_code: code, grant_type: 'authorization_code' }).toString();
      let data;
      try {
        const response = await fetchImpl(url, { method: 'GET', redirect: 'error', signal: AbortSignal.timeout(8000) });
        if (!response.ok) throw new Error('Upstream unavailable');
        data = await response.json();
      } catch {
        // Fetch errors can contain the credential-bearing URL. Never forward or log the original error.
        throw authError('微信登录暂时不可用，请稍后重试', 503, 'WECHAT_UNAVAILABLE');
      }
      if (!data || typeof data !== 'object' || Array.isArray(data))
        throw authError('微信登录返回异常，请重试', 503, 'WECHAT_UNAVAILABLE');
      if ([40029, 40163].includes(data.errcode)) throw authError('微信登录凭证已失效，请重新登录', 401, 'WECHAT_CODE_INVALID');
      if (data.errcode === 40226) throw authError('微信暂不允许此次登录，请稍后重试', 403, 'FORBIDDEN');
      if (data.errcode === 45011) throw authError('微信登录过于频繁，请稍后重试', 429, 'TOO_MANY_ATTEMPTS');
      if ((data.errcode !== undefined && data.errcode !== 0) || typeof data.openid !== 'string'
        || !/^[a-zA-Z0-9_-]{1,128}$/.test(data.openid) || typeof data.session_key !== 'string' || !data.session_key)
        throw authError('微信登录暂时不可用，请稍后重试', 503, 'WECHAT_UNAVAILABLE');
      // Normal login strips session_key/unionid. Payment exchange keeps sessionKey
      // only in RAM for immediate signing; never include this result in an HTTP response.
      return { appId, openId: data.openid, ...(paymentOnly ? {sessionKey:data.session_key} : {}) };
    },
    exchangePaymentCode: exchange,
    async getAccessToken({appId:expected} = {}) {
      if (!configured || expected !== appId) throw authError('支付接口凭证未配置', 503, 'WECHAT_TOKEN_UNAVAILABLE');
      if (cachedToken && cachedToken.until > clock()) return {appId,accessToken:cachedToken.value};
      if (!tokenPending) tokenPending = (async () => {
        let data;
        try {
          // Official stable_token uses POST, ordinary refresh; no credentials in URL.
          const response=await fetchImpl(new URL('https://api.weixin.qq.com/cgi-bin/stable_token'),{
            method:'POST',redirect:'error',signal:AbortSignal.timeout(8000),headers:{'Content-Type':'application/json'},
            body:JSON.stringify({grant_type:'client_credential',appid:appId,secret:appSecret,force_refresh:false})});
          if(!response.ok)throw Error('unavailable');data=await response.json();
        }catch {throw authError('支付接口凭证暂不可用，请稍后查单',503,'WECHAT_TOKEN_UNAVAILABLE');}
        if(!data||typeof data!=='object'||Array.isArray(data)||(data.errcode!==undefined&&data.errcode!==0)
          ||typeof data.access_token!=='string'||!data.access_token||data.access_token.length>4096||/\s/.test(data.access_token)
          ||!Number.isSafeInteger(data.expires_in)||data.expires_in<=0||data.expires_in>7200)
          throw authError('支付接口凭证暂不可用，请稍后查单',503,'WECHAT_TOKEN_UNAVAILABLE');
        const margin=Math.min(300,Math.floor(data.expires_in/2));
        cachedToken={value:data.access_token,until:clock()+(data.expires_in-margin)*1000};
        return {appId,accessToken:data.access_token};
      })();
      try{return await tokenPending;}finally{tokenPending=undefined;}
    },
  };
  return adapter;
}
