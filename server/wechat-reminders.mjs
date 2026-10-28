import { createHash, createDecipheriv, timingSafeEqual } from 'node:crypto';
const failure = message => Object.assign(new Error(message), { status: 403 });

// Only encrypted WeChat safe-mode callbacks are accepted. Plain signature does
// not authenticate the message body and must not create notification grants.
export function decodeWechatReminderCallback(input, { appId, token, encodingAesKey, clock = Date.now } = {}) {
  if (!appId || !token || !/^[A-Za-z0-9+/]{43}$/.test(encodingAesKey ?? '') || !/^\d+$/.test(input?.timestamp ?? '')
    || Math.abs(clock() / 1000 - Number(input.timestamp)) > 300 || typeof input.nonce !== 'string' || input.nonce.length > 128
    || !/^[a-f0-9]{40}$/.test(input.msgSignature ?? '') || typeof input.encrypted !== 'string' || input.encrypted.length > 300000) throw failure('微信提醒回调身份未核实');
  const expected = createHash('sha1').update([token, input.timestamp, input.nonce, input.encrypted].sort().join('')).digest();
  if (!timingSafeEqual(expected, Buffer.from(input.msgSignature, 'hex'))) throw failure('微信提醒回调签名不符');
  try {
    const key = Buffer.from(encodingAesKey + '=', 'base64'), ciphertext = Buffer.from(input.encrypted, 'base64');
    if (ciphertext.toString('base64') !== input.encrypted || ciphertext.length % 16) throw Error();
    const decoder = createDecipheriv('aes-256-cbc', key, key.subarray(0, 16)); decoder.setAutoPadding(false);
    const padded = Buffer.concat([decoder.update(ciphertext), decoder.final()]), padding = padded.at(-1);
    if (!padding || padding > 32 || !padded.subarray(-padding).every(value => value === padding)) throw Error();
    const plain = padded.subarray(0, -padding); if (plain.length < 20) throw Error();
    const length = plain.readUInt32BE(16); if (length > plain.length - 20 || plain.subarray(20 + length).toString('utf8') !== appId) throw Error();
    const body = plain.subarray(20, 20 + length).toString('utf8'); if (/<!DOCTYPE|<!ENTITY/i.test(body)) throw Error();
    return { verified: true, appId, body, bodyHash: createHash('sha256').update(body).digest('hex') };
  } catch { throw failure('微信提醒回调解密或所属小程序不符'); }
}

export function reminderEventsFromCallback(decoded, { originalId } = {}) {
  if (decoded?.verified !== true || !originalId) throw failure('微信提醒回调来源未核实');
  const xmlValue = (text, tag) => { const value = new RegExp(`<${tag}>\\s*(?:<!\\[CDATA\\[([\\s\\S]*?)\\]\\]>|([^<]*))\\s*</${tag}>`).exec(text); return value ? (value[1] ?? value[2]).trim() : ''; };
  let body, lists;
  try {
    if (decoded.body.trim().startsWith('{')) { body = JSON.parse(decoded.body); lists = body.List ?? body.SubscribeMsgPopupEvent?.List ?? body.SubscribeMsgChangeEvent?.List ?? body.SubscribeMsgSentEvent?.List; }
    else { body = Object.fromEntries(['ToUserName','FromUserName','CreateTime','Event'].map(tag => [tag, xmlValue(decoded.body, tag)])); lists = [...decoded.body.matchAll(/<List>([\s\S]*?)<\/List>/g)].map(match => Object.fromEntries(['TemplateId','SubscribeStatusString','MsgID','ErrorCode'].map(tag => [tag, xmlValue(match[1],tag)]))); }
    if (body.ToUserName !== originalId || !body.FromUserName || !/^\d+$/.test(String(body.CreateTime))) throw Error();
    const kinds = { subscribe_msg_popup_event: 'popup', subscribe_msg_change_event: 'change', subscribe_msg_sent_event: 'sent' }, kind = kinds[body.Event];
    if (!kind || !lists) throw Error(); lists = Array.isArray(lists) ? lists : [lists];
    return lists.map(list => {
      const event = { appId: decoded.appId, openId: body.FromUserName, kind, templateId: list.TemplateId, occurredAt: new Date(Number(body.CreateTime) * 1000).toISOString(),
        ...(kind === 'sent' ? { providerMessageId: String(list.MsgID), errorCode: Number(list.ErrorCode) } : { result: list.SubscribeStatusString }) };
      if (!event.templateId || (kind === 'sent' ? !/^\d+$/.test(event.providerMessageId) || !Number.isSafeInteger(event.errorCode) : !['accept','reject'].includes(event.result))) throw Error();
      const id = createHash('sha256').update(JSON.stringify(event)).digest('hex');
      return { ...event, id, verified: true, source: 'wechat_verified_callback', evidenceRef: decoded.bodyHash };
    });
  } catch { throw failure('微信提醒事件结构未核实'); }
}

// Construction and disabled calls make no HTTP request. Tests inject transport;
// runtime must explicitly enable and supply current-AppID access-token authority.
export function createWechatReminderSender({ appId, enabled = false, getAccessToken, fetchImpl = globalThis.fetch } = {}) {
  const configured = enabled === true && !!appId && typeof getAccessToken === 'function';
  return { configured, appId,
    async send(payload) {
      if (!configured) return { outcome: 'not_sent', responseVerified: true, reason: '微信提醒发送尚未配置' };
      let token;
      try { token = await getAccessToken({ appId }); if (token?.appId !== appId || !token.accessToken) throw Error(); }
      catch { return { outcome: 'not_sent', responseVerified: true, reason: '发送前未能取得当前小程序凭证' }; }
      try {
        const response = await fetchImpl('https://api.weixin.qq.com/cgi-bin/message/subscribe/send?access_token=' + encodeURIComponent(token.accessToken), { method: 'POST', redirect: 'error', signal: AbortSignal.timeout(8000), headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(payload) });
        if (!response.ok) return { outcome: 'unknown', reason: '微信请求回执未核实' };
        const value = await response.json(); if (!Number.isSafeInteger(value?.errcode)) return { outcome: 'unknown', reason: '微信返回未包含确定结果' };
        return { outcome: value.errcode === 0 ? 'accepted' : 'rejected', responseVerified: true, errorCode: value.errcode,
          ...(value.msgid !== undefined || value.msg_id !== undefined ? { providerMessageId: String(value.msgid ?? value.msg_id) } : {}) };
      } catch { return { outcome: 'unknown', reason: '发送结果未知，禁止自动重发' }; }
    }
  };
}
