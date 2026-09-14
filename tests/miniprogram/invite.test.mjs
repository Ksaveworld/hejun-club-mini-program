import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import vm from 'node:vm';

function setup() {
  let pageDefinition, version = 1, logged = true, failure, user = { id: 'member-a', role: 'member', referralCode: 'OWN123', sourceCode: 'UPR456', username: 'private-name' };
  const text = [], exports = [], saved = [];
  let deferExport = false, albumError;
  const api = { hasSession: () => logged, sessionStamp: () => ({ version }), isCurrentSession: stamp => stamp.version === version,
    api: async () => { if (failure) throw failure; return { user }; } };
  const ctx = { fillRect() {}, strokeRect() {}, beginPath() {}, moveTo() {}, lineTo() {}, stroke() {}, fillText(value) { text.push(value); } };
  const wx = {
    createSelectorQuery() { return { in() { return this; }, select() { return this; }, fields() { return this; },
      exec(callback) { callback([{ node: { getContext: () => ctx } }]); } }; },
    canvasToTempFilePath(options) { exports.push(options); if (!deferExport) options.success({ tempFilePath: '/temp/invite-' + exports.length + '.png' }); },
    saveImageToPhotosAlbum(options) { saved.push(options.filePath); albumError ? options.fail(albumError) : options.success({}); },
    navigateTo() {}, openSetting() {}
  };
  const module = { exports: {} };
  vm.runInNewContext(readFileSync(new URL('../../miniprogram/utils/invite-art.js', import.meta.url), 'utf8'), { module, Error });
  vm.runInNewContext(readFileSync(new URL('../../miniprogram/pages/invite/index.js', import.meta.url), 'utf8'),
    { Page: value => { pageDefinition = value; }, require: path => path.endsWith('/api') ? api : module.exports, wx, Error, setTimeout, clearTimeout });
  const page = { ...pageDefinition, data: structuredClone(pageDefinition.data), writes: 0, setData(patch) { this.writes++; Object.assign(this.data, patch); } };
  page.onLoad(); page.onShow();
  return { page, text, exports, saved, ready: () => page.onReady(),
    swap: value => { version++; user = value; }, logout: () => { logged = false; version++; },
    user: value => { user = value; }, fail: error => { failure = error; },
    defer: () => { deferExport = true; }, albumFail: error => { albumError = error; } };
}
const tick = () => new Promise(resolve => setImmediate(resolve));

test('generates both images from own code, excludes identity/upstream data, and only saves after a user action', async () => {
  const env = setup(); await env.ready();
  assert.equal(env.page.data.ready, true); assert.equal(env.exports.length, 2);
  assert.equal(env.saved.length, 0); assert.equal(env.text.join('').includes('OWN123'), true);
  for (const secret of ['UPR456', 'private-name', 'member-a']) assert.equal(env.text.join('').includes(secret), false);
  const share = env.page.onShareAppMessage(); assert.equal(share.path, '/pages/home/index?ref=OWN123'); assert.equal(share.imageUrl, env.page.data.cardPath);
  await env.page.savePoster(); assert.equal(env.saved.length, 1); assert.match(env.page.data.message, /已保存/);
});

test('missing login, administrator, bad code or failed identity cannot export personalized images', async () => {
  for (const change of [env => env.logout(), env => env.user({role:'admin',referralCode:'ADM123'}),
    env => env.user({role:'member',referralCode:'bad-code'}), env => env.fail(new Error('offline'))]) {
    const env = setup(); change(env); await env.ready();
    assert.equal(env.exports.length, 0); assert.equal(env.page.data.ready, false);
    assert.equal(env.page.onShareAppMessage().path, '/pages/home/index');
  }
});

test('changing accounts during canvas export cannot produce or share old owner images', async () => {
  const env = setup(); env.defer(); const pending = env.ready(); await tick();
  env.swap({id:'member-b',role:'member',referralCode:'NEW789'});
  env.exports[0].success({tempFilePath:'/temp/old.png'}); await pending;
  assert.equal(env.page.data.cardPath, ''); assert.equal(env.page.data.ready, false);
  assert.equal(env.page.onShareAppMessage().imageUrl, undefined);
});

test('hiding or unloading discards delayed exports without writing the old page', async () => {
  for (const event of ['onHide','onUnload']) {
    const env = setup(); env.defer(); const pending = env.ready(); await tick(); env.page[event]();
    const writes = env.page.writes; env.exports[0].success({tempFilePath:'/temp/old.png'}); await pending;
    assert.equal(env.page.writes, writes); assert.equal(env.page.onShareAppMessage().path, '/pages/home/index');
  }
});

test('save revalidates server identity and current code, revocation/change sends no album request', async () => {
  for (const change of [env => env.logout(), env => env.user(null), env => env.user({id:'member-a',role:'member',referralCode:'NEW789'})]) {
    const env = setup(); await env.ready(); change(env); await env.page.savePoster();
    assert.equal(env.saved.length, 0); assert.equal(env.page.data.posterPath, ''); assert.equal(env.page.data.saving, false);
  }
});

test('denied photo permission preserves card sharing and allows explicit save retry; show refreshes the images', async () => {
  const env = setup(); await env.ready(); env.albumFail({errMsg:'saveImageToPhotosAlbum:fail auth deny'});
  await env.page.savePoster(); assert.equal(env.page.data.albumDenied, true); assert.equal(env.page.data.ready, true);
  assert.equal(env.page.onShareAppMessage().path, '/pages/home/index?ref=OWN123');
  env.albumFail(null); await env.page.savePoster(); assert.match(env.page.data.message, /已保存/);
  env.page.onHide(); assert.equal(env.page.data.code, ''); assert.equal(env.page.data.posterPath, '');
  await env.page.onShow(); assert.equal(env.page.data.ready, true); assert.equal(env.exports.length, 4);
});
