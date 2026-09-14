import { createPublicKey, verify, createDecipheriv } from 'node:crypto';

// Ordinary merchant APIv3. Always verify the original bytes before parsing JSON.
// Reference: https://pay.wechatpay.cn/doc/v3/merchant/4012791861
export function createPaymentVerifier({ publicKey, publicKeyId, apiV3Key, appId, merchantId, now = Date.now }) {
  if (!publicKeyId || !appId || !merchantId || typeof apiV3Key !== 'string' || Buffer.byteLength(apiV3Key) !== 32)
    throw new Error('支付验签配置不完整');
  const key = createPublicKey(publicKey);
  if (key.asymmetricKeyType !== 'rsa' || key.asymmetricKeyDetails.modulusLength < 2048) throw new Error('支付验签公钥格式不正确');
  const fail = () => { throw new Error('支付通知校验失败'); };
  return function verifyNotification(raw, headers) {
    try {
      if (!Buffer.isBuffer(raw) || raw.length > 262144) return fail();
      const timestamp = headers['wechatpay-timestamp'], nonce = headers['wechatpay-nonce'];
      const serial = headers['wechatpay-serial'], signature = headers['wechatpay-signature'];
      if (serial !== publicKeyId || typeof timestamp !== 'string' || !/^\d{1,12}$/.test(timestamp)
        || Math.abs(now() / 1000 - Number(timestamp)) > 300
        || typeof nonce !== 'string' || !nonce.length || nonce.length > 128 || /[\r\n]/.test(nonce)
        || typeof signature !== 'string' || !/^[A-Za-z0-9+/]+={0,2}$/.test(signature)) return fail();
      const signed = Buffer.concat([Buffer.from(timestamp + '\n' + nonce + '\n'), raw, Buffer.from('\n')]);
      if (!verify('RSA-SHA256', signed, key, Buffer.from(signature, 'base64'))) return fail();
      const event = JSON.parse(raw.toString('utf8'));
      const r = event.resource;
      if (event.event_type !== 'TRANSACTION.SUCCESS' || event.resource_type !== 'encrypt-resource'
        || !r || r.original_type !== 'transaction' || r.algorithm !== 'AEAD_AES_256_GCM'
        || typeof r.nonce !== 'string' || Buffer.byteLength(r.nonce) !== 12
        || typeof r.associated_data !== 'string' || typeof r.ciphertext !== 'string'
        || !/^[A-Za-z0-9+/]+={0,2}$/.test(r.ciphertext)) return fail();
      const encrypted = Buffer.from(r.ciphertext, 'base64');
      if (encrypted.length <= 16) return fail();
      const decipher = createDecipheriv('aes-256-gcm', Buffer.from(apiV3Key), Buffer.from(r.nonce));
      decipher.setAAD(Buffer.from(r.associated_data));
      decipher.setAuthTag(encrypted.subarray(-16));
      const transaction = JSON.parse(Buffer.concat([decipher.update(encrypted.subarray(0, -16)), decipher.final()]).toString('utf8'));
      if (transaction.appid !== appId || transaction.mchid !== merchantId || transaction.trade_state !== 'SUCCESS'
        || transaction.trade_type !== 'JSAPI' || transaction.amount?.currency !== 'CNY'
        || !Number.isSafeInteger(transaction.amount.total) || transaction.amount.total <= 0
        || typeof transaction.out_trade_no !== 'string' || !/^[A-Z0-9]{1,32}$/.test(transaction.out_trade_no)
        || typeof transaction.transaction_id !== 'string' || !/^\d{6,64}$/.test(transaction.transaction_id)
        || typeof transaction.payer?.openid !== 'string' || !transaction.payer.openid
        || !Number.isFinite(Date.parse(transaction.success_time)) || Date.parse(transaction.success_time) > now() + 300000) return fail();
      return {
        transactionId: transaction.transaction_id, orderId: transaction.out_trade_no,
        merchantId, appId, currency: 'CNY', amountCents: transaction.amount.total,
        status: 'SUCCESS', paidAt: new Date(transaction.success_time).toISOString(), payerOpenId: transaction.payer.openid,
      };
    } catch { return fail(); }
  };
}
