import { authError } from './native-auth.mjs';

// Official reference: https://developers.weixin.qq.com/miniprogram/dev/server/API/user-login/api_code2session.html
// Only server configuration can supply credentials or a test transport; clients cannot choose the upstream URL.
export function createWechatAdapter({ appId, appSecret, fetchImpl = globalThis.fetch } = {}) {
  const configured = typeof appId === 'string' && appId.trim().length > 0
    && typeof appSecret === 'string' && appSecret.trim().length > 0;
  return {
    configured, appId: configured ? appId : null,
    async exchangeCode(code) {
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
      // Do not persist or return session_key / unionid; this milestone only needs the verified identity.
      return { appId, openId: data.openid };
    },
  };
}
