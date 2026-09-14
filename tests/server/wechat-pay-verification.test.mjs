import { test } from 'node:test';
import assert from 'node:assert/strict';
import { generateKeyPairSync, sign, createCipheriv } from 'node:crypto';
import { createPaymentVerifier } from '../../server/wechat-pay-verification.mjs';

const keys = generateKeyPairSync('rsa', { modulusLength: 2048 });
const publicKey = keys.publicKey.export({ type: 'spki', format: 'pem' });
const now = Date.parse('2026-09-14T12:00:00Z'), apiV3Key = 't'.repeat(32);
const config = { publicKey, publicKeyId: 'PUB_KEY_ID_TEST', apiV3Key, appId: 'wxTest', merchantId: '12345', now: () => now };
function fixture(changes = {}) {
  const transaction = { appid: 'wxTest', mchid: '12345', trade_state: 'SUCCESS', trade_type: 'JSAPI',
    amount: { total: 36500, currency: 'CNY' }, out_trade_no: 'HJ123456', transaction_id: '123456789',
    success_time: '2026-09-14T11:59:00Z', payer: { openid: 'isolated-test-payer' }, ...changes };
  const cipher = createCipheriv('aes-256-gcm', Buffer.from(apiV3Key), Buffer.from('testnonce123'));
  cipher.setAAD(Buffer.from('transaction'));
  const ciphertext = Buffer.concat([cipher.update(JSON.stringify(transaction)), cipher.final(), cipher.getAuthTag()]).toString('base64');
  const raw = Buffer.from(JSON.stringify({ event_type: 'TRANSACTION.SUCCESS', resource_type: 'encrypt-resource',
    resource: { original_type: 'transaction', algorithm: 'AEAD_AES_256_GCM', nonce: 'testnonce123', associated_data: 'transaction', ciphertext } }));
  return signed(raw);
}
function signed(raw, timestamp = String(now / 1000)) {
  const nonce = 'test-signature-nonce';
  return { raw, headers: { 'wechatpay-timestamp': timestamp, 'wechatpay-nonce': nonce, 'wechatpay-serial': config.publicKeyId,
    'wechatpay-signature': sign('RSA-SHA256', Buffer.concat([Buffer.from(timestamp + '\n' + nonce + '\n'), raw, Buffer.from('\n')]), keys.privateKey).toString('base64') } };
}
test('signed and encrypted payment is normalized without trusting client payment status', () => {
  const verify = createPaymentVerifier(config), f = fixture();
  const receipt = verify(f.raw, f.headers);
  assert.equal(receipt.amountCents, 36500);
  assert.equal(receipt.orderId, 'HJ123456');
  assert.equal(receipt.payerOpenId, 'isolated-test-payer');
  assert.deepEqual(verify(f.raw, f.headers), receipt); // Persistence layer handles duplicate transaction IDs.
});
test('tampering, unknown keys, stale timestamps, bad GCM and incomplete configuration fail closed', () => {
  const verify = createPaymentVerifier(config), f = fixture();
  const rejects = value => assert.throws(() => verify(value.raw, value.headers), /支付通知校验失败/);
  rejects({ ...f, raw: Buffer.concat([f.raw, Buffer.from(' ')]) });
  rejects({ ...f, headers: { ...f.headers, 'wechatpay-serial': 'unknown' } });
  rejects(signed(f.raw, String(now / 1000 - 301)));
  rejects(signed(f.raw, String(now / 1000 + 301)));
  rejects({ ...f, headers: { ...f.headers, 'wechatpay-signature': 'WECHATPAY/SIGNTEST/invalid' } });
  const body = JSON.parse(f.raw); body.resource.ciphertext = Buffer.alloc(32).toString('base64');
  rejects(signed(Buffer.from(JSON.stringify(body))));
  assert.throws(() => createPaymentVerifier({ ...config, apiV3Key: '' }), /配置不完整/);
});
test('valid signature cannot bypass merchant, app, currency, integer amount and successful JSAPI checks', () => {
  const verify = createPaymentVerifier(config);
  for (const changes of [{ appid: 'other' }, { mchid: 'other' }, { trade_state: 'NOTPAY' }, { trade_type: 'NATIVE' },
    { amount: { total: 1.5, currency: 'CNY' } }, { amount: { total: 36500, currency: 'USD' } },
    { payer: {} }, { success_time: 'invalid' }]) {
    const f = fixture(changes); assert.throws(() => verify(f.raw, f.headers), /支付通知校验失败/);
  }
});
