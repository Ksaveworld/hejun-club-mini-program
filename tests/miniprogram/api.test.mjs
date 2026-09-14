import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import vm from 'node:vm';

const source = readFileSync(new URL('../../miniprogram/utils/api.js', import.meta.url), 'utf8');
const referralModule = { exports: {} };
vm.runInNewContext(readFileSync(new URL('../../miniprogram/utils/referral.js', import.meta.url), 'utf8'), { module: referralModule, Error, Promise });
const local = 'http://127.0.0.1:5187/api';
const isolated = 'http://127.0.0.1:5197/api';
const credential = { tokenType: 'Bearer', accessToken: 'a'.repeat(64), expiresAt: '2099-01-01T00:00:00.000Z', authMode: 'local-trial' };
function setup() {
  const storage = new Map(), requests = [], app = { globalData: {} }, module = { exports: {} };
  let response = { statusCode: 200, data: { ok: true } }, networkFailure = false;
  const wx = {
    getStorageSync: key => storage.get(key), setStorageSync: (key, value) => storage.set(key, value), removeStorageSync: key => storage.delete(key),
    request(options) {
      requests.push(options);
      if (networkFailure) return options.fail({ errMsg: 'raw-network-detail' });
      const result = typeof response === 'function' ? response(options) : response;
      if (result) options.success(result);
    },
    login(options) { options.success({ code: 'temporary-wx-code' }); },
  };
  vm.runInNewContext(source, { module, require: path => path === './referral' ? referralModule.exports : ({ apiBaseUrl: local }), wx, getApp: () => app, Date, Math, Promise, Error });
  return { ...module.exports, wx, storage, requests, app, respond: value => { response = value; }, fail: () => { networkFailure = true; } };
}

test('report downloads use fixed endpoints and discard files after account changes or denied access',async()=>{
 const client=setup(),removed=[];let pending;
 client.wx.downloadFile=options=>{pending=options;};client.wx.getFileSystemManager=()=>({unlink:({filePath})=>removed.push(filePath)});
 const id='12345678-1234-1234-1234-123456789abc';
 const guest=client.downloadArticle(id,true);assert.equal(pending.url,local+'/articles/'+id+'/preview');assert.equal(pending.header.Authorization,undefined);pending.success({statusCode:200,tempFilePath:'guest.pdf'});assert.equal(await guest,'guest.pdf');
 client.saveSession(credential);const full=client.downloadArticle(id,false);assert.equal(pending.header.Authorization,'Bearer '+credential.accessToken);client.clearSession();pending.success({statusCode:200,tempFilePath:'stale.pdf'});await assert.rejects(full);assert.ok(removed.includes('stale.pdf'));
 const denied=client.downloadArticle(id,false);pending.success({statusCode:404,tempFilePath:'error.json'});await assert.rejects(denied);assert.ok(removed.includes('error.json'));
 await assert.rejects(client.downloadArticle('https://wrong.example',true));
});

test('native credentials stay scoped to an approved backend and expiry clears only that session', async () => {
  const client = setup(); client.saveSession(credential);
  client.app.globalData.apiBaseUrl = 'https://external.example/api';
  await client.api('/me');
  assert.equal(client.requests[0].url, local + '/me');
  assert.equal(client.requests[0].header.Authorization, 'Bearer ' + credential.accessToken);
  client.app.globalData.apiBaseUrl = isolated;
  assert.equal(client.hasSession(), false);
  await client.api('/me');
  assert.equal(client.requests[1].header.Authorization, undefined);
  client.storage.set('club-native-session:' + isolated, { ...credential, expiresAt: '2000-01-01T00:00:00Z' });
  assert.equal(client.hasSession(), false);
  assert.equal(client.storage.has('club-native-session:' + isolated), false);
  assert.equal(client.storage.has('club-native-session:' + local), true);
});

test('writes carry CSRF and idempotency headers without automatic retries or leaking stale tokens into login', async () => {
  const client = setup(); client.saveSession(credential);
  await client.api('/orders', { planId: 'basic' }, 'same-submission');
  assert.equal(client.requests[0].method, 'POST');
  assert.equal(client.requests[0].header['X-Club-Request'], '1');
  assert.equal(client.requests[0].header['Idempotency-Key'], 'same-submission');
  await client.api('/native/auth/login', { username: 'trial' });
  assert.equal(client.requests[1].header.Authorization, undefined);
  client.fail();
  await assert.rejects(client.api('/orders', { planId: 'basic' }, 'same-submission'), error => !error.message.includes('raw-network-detail'));
  assert.equal(client.requests.length, 3);
});

test('unauthorized business responses clear the session and retain a usable status for page recovery', async () => {
  const client = setup(); client.saveSession(credential);
  client.respond({ statusCode: 401, data: { error: '登录已过期', code: 'SESSION_EXPIRED' } });
  await assert.rejects(client.api('/orders'), error => error.status === 401 && error.code === 'SESSION_EXPIRED');
  assert.equal(client.hasSession(), false);
  assert.equal(client.requests.length, 1);
});

test('invalid session responses and full URL paths never become credentials or external requests', async () => {
  const client = setup();
  for (const result of [null, { ...credential, tokenType: 'Cookie' }, { ...credential, accessToken: 'bad' }, { ...credential, expiresAt: 'invalid' }]) {
    assert.throws(() => client.saveSession(result), /登录返回异常/);
  }
  await assert.rejects(client.api('https://external.example/me'), /接口地址不正确/);
  assert.equal(client.storage.size, 0); assert.equal(client.requests.length, 0);
});

test('WeChat code is exchanged server-side and only the business session is saved', async () => {
  const client = setup(); client.captureReferral({ ref: 'ABC123' });
  client.respond(options => ({ statusCode: 200, data: options.url.endsWith('/referral')
    ? { user: { id: 'member1', sourceCode: 'ABC123', referralSource: 'explicit' } }
    : { ...credential, authMode: 'wechat', user: { id: 'member1' } } }));
  await client.loginWechat();
  assert.equal(client.requests[0].url, local + '/native/auth/wechat');
  assert.equal(client.requests[0].data.code, 'temporary-wx-code');
  assert.equal(client.requests[0].data.referral, undefined);
  assert.equal(client.requests[1].url, local + '/referral');
  assert.equal(client.requests[1].data.code, 'ABC123');
  assert.equal(client.requests[1].header.Authorization, 'Bearer ' + credential.accessToken);
  assert.equal(client.hasSession(), true);
  const saved = client.storage.get('club-native-session:' + local);
  assert.equal(saved.authMode, 'wechat'); assert.equal(saved.code, undefined); assert.equal(saved.user, undefined);
});

test('a late unauthorized response cannot erase a newer login session', async () => {
  const client = setup(); let pending;
  client.saveSession({ ...credential, user: { id: 'member-a' } });
  client.respond(options => { pending = options; return null; });
  const oldRequest = client.api('/orders');
  client.saveSession({ ...credential, accessToken: 'b'.repeat(64), user: { id: 'member-b' } });
  pending.success({ statusCode: 401, data: { error: 'expired' } });
  await assert.rejects(oldRequest, error => error.code === 'CONTEXT_CHANGED');
  assert.equal(client.storage.get('club-native-session:' + local).accessToken, 'b'.repeat(64));
});

test('new-account login never carries or applies the expired old-account candidate', async () => {
  const client = setup(); client.saveSession({ ...credential, user: { id: 'member-a' } });
  client.captureReferral({ ref: 'OLD111' }); client.clearSession();
  client.respond({ statusCode: 200, data: { ...credential, user: { id: 'member-b' } } });
  await client.loginLocal({ username: 'member-b', password: 'private-password' });
  assert.equal(client.requests.length, 1); assert.equal(client.requests[0].data.referral, undefined);
  assert.deepEqual(Array.from(client.storage.get('club-native-referral:' + local).codes), []);
});

test('referral failure after successful authentication preserves login and retries on member context', async () => {
  const client = setup(); const user = { id: 'member-a' }; let available = false;
  client.captureReferral({ ref: 'ABC123' });
  client.respond(options => {
    if (options.url.endsWith('/referral')) return available
      ? { statusCode: 200, data: { user: { ...user, sourceCode: 'ABC123', referralSource: 'explicit' } } }
      : { statusCode: 503, data: { error: 'service unavailable' } };
    return { statusCode: 200, data: { ...credential, user } };
  });
  const result = await client.loginLocal({ username: 'member-a', password: 'private-password', register: true });
  assert.equal(result.referralPending, true); assert.equal(client.hasSession(), true);
  available = true;
  assert.equal((await client.memberContext()).user.sourceCode, 'ABC123');
  assert.deepEqual(Array.from(client.storage.get('club-native-referral:' + local).codes), []);
});


test('explicit logout and a different login clear local drafts; renewing the same identity retains them',()=>{
 const e=setup(),key='club-native-drafts:'+local;
 e.saveSession({...credential,user:{id:'owner'}});e.storage.set(key,{owner:'owner',entries:{}});
 e.saveSession({...credential,user:{id:'owner'}});assert.ok(e.storage.get(key));
 e.saveSession({...credential,user:{id:'other'}});assert.equal(e.storage.get(key),undefined);
 e.storage.set(key,{owner:'other',entries:{}});e.clearSession({logout:true});assert.equal(e.storage.get(key),undefined);
});
