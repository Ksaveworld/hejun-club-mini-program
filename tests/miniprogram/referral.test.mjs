import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import vm from 'node:vm';

const module = { exports: {} };
vm.runInNewContext(readFileSync(new URL('../../miniprogram/utils/referral.js', import.meta.url), 'utf8'), { module, Error, Promise });
const { createReferralContext } = module.exports;
const user = { id: 'member-a', referralSource: null, referralLockedAt: null };
const failure = status => Object.assign(new Error('upstream'), { status });
function setup(storage = new Map()) {
  let scope = 'backend-a';
  const context = createReferralContext({ getScope: () => scope, read: key => storage.get(key),
    write: (key, value) => storage.set(key, structuredClone(value)), remove: key => storage.delete(key) });
  return { context, storage, scope: value => { scope = value; } };
}
const codes = context => Array.from(context.snapshot().codes);

test('cold restore, warm entry and ordinary navigation preserve normalized candidates in order', () => {
  const { context, storage } = setup();
  context.capture({ ref: 'abc123' }); context.capture({ referral: 'ABC123', ref: 'def456' }); context.capture({});
  context.capture({ ref: 'bad<script>' });
  assert.deepEqual(codes(context), ['ABC123', 'DEF456']);
  assert.deepEqual(codes(setup(storage).context), ['ABC123', 'DEF456']);
  assert.equal(context.snapshot().ownerId, null);
});

test('invalid first candidate does not hide a later server-valid source', async () => {
  const { context } = setup(), sent = [];
  context.capture({ ref: 'BAD111', referral: 'BAD000' }); context.capture({ ref: 'GOOD22' });
  const result = await context.synchronize(user, async code => {
    sent.push(code); if (code !== 'GOOD22') throw failure(400);
    return { ...user, referralSource: 'explicit', sourceCode: code };
  });
  assert.deepEqual(sent, ['BAD000', 'BAD111', 'GOOD22']);
  assert.equal(result.user.sourceCode, 'GOOD22'); assert.equal(result.notice, ''); assert.deepEqual(codes(context), []);
});

test('default source is never promoted without an incoming candidate; explicit and locked sources are protected', async () => {
  const { context } = setup(); let sent = 0;
  const defaultUser = { ...user, referralSource: 'default', sourceCode: 'DEF111' };
  assert.equal((await context.synchronize(defaultUser, () => { sent++; })).user.referralSource, 'default');
  context.capture({ ref: 'NEW222' });
  const changed = await context.synchronize(defaultUser, async code => { sent++; return { ...user, sourceCode: code, referralSource: 'explicit' }; });
  assert.equal(changed.user.sourceCode, 'NEW222'); assert.equal(sent, 1);
  for (const protectedUser of [changed.user, { ...defaultUser, referralLockedAt: '2026-01-01' }]) {
    context.capture({ ref: 'ALT333' }); await context.synchronize(protectedUser, () => { throw new Error('must not send'); });
    assert.deepEqual(codes(context), []);
  }
});

test('pending orders discard candidates without changing the saved relationship', async () => {
  const { context } = setup(); context.capture({ ref: 'ABC123' });
  const result = await context.synchronize(user, async () => { throw failure(409); });
  assert.equal(result.user.id, user.id); assert.match(result.notice, /待处理订单/); assert.deepEqual(codes(context), []);
});

test('expired session keeps ownership; cold same-account recovery resumes but another account drops the old source', async () => {
  const { context, storage } = setup(); context.capture({ ref: 'ABC123' });
  await assert.rejects(context.synchronize(user, async () => { throw failure(401); }), error => error.status === 401);
  assert.equal(context.snapshot().ownerId, user.id); assert.deepEqual(codes(context), ['ABC123']);
  const same = setup(new Map(storage)).context;
  await same.synchronize(user, async code => ({ ...user, referralSource: 'explicit', sourceCode: code }));
  assert.deepEqual(codes(same), []);
  const other = setup(storage).context;
  await other.synchronize({ id: 'member-b' }, () => { throw new Error('old source leaked'); });
  assert.deepEqual(codes(other), []); assert.equal(other.snapshot().ownerId, 'member-b');
});

test('network errors retain candidates for an explicit retry', async () => {
  const { context } = setup(); context.capture({ ref: 'ABC123' });
  await assert.rejects(context.synchronize(user, async () => { throw failure(503); }), error => error.status === 503);
  assert.deepEqual(codes(context), ['ABC123']);
  await context.synchronize(user, async code => ({ ...user, sourceCode: code, referralSource: 'explicit' }));
  assert.deepEqual(codes(context), []);
});

test('logout and new identity reject a late response without consuming the new account candidate', async () => {
  const { context } = setup(); let finish;
  context.capture({ ref: 'OLD111' });
  const pending = context.synchronize(user, () => new Promise(resolve => { finish = resolve; }));
  context.clear(); context.capture({ ref: 'NEW222' }); context.identify({ id: 'member-b' });
  finish({ ...user, referralSource: 'explicit', sourceCode: 'OLD111' });
  await assert.rejects(pending, error => error.code === 'CONTEXT_CHANGED');
  assert.equal(context.snapshot().ownerId, 'member-b'); assert.deepEqual(codes(context), ['NEW222']);
});

test('backend switching rejects in-flight results and preserves independent source queues', async () => {
  const env = setup(); let finish;
  env.context.capture({ ref: 'AAA111' });
  const pending = env.context.synchronize(user, () => new Promise(resolve => { finish = resolve; }));
  env.scope('backend-b'); env.context.capture({ ref: 'BBB222' });
  finish({ ...user, referralSource: 'explicit', sourceCode: 'AAA111' });
  await assert.rejects(pending, error => error.code === 'CONTEXT_CHANGED');
  assert.deepEqual(codes(env.context), ['BBB222']);
  env.scope('backend-a'); assert.deepEqual(codes(env.context), ['AAA111']);
});

test('simultaneous consumers share one request and include later candidates after an invalid source', async () => {
  const { context } = setup(); let rejectFirst; const sent = [];
  context.capture({ ref: 'BAD111' });
  const send = code => {
    sent.push(code);
    return code === 'BAD111' ? new Promise((resolve, reject) => { rejectFirst = reject; }) : Promise.resolve({ ...user, referralSource: 'explicit', sourceCode: code });
  };
  const first = context.synchronize(user, send);
  context.capture({ ref: 'GOOD22' });
  const second = context.synchronize(user, send);
  assert.equal(first, second); rejectFirst(failure(400));
  assert.equal((await second).user.sourceCode, 'GOOD22'); assert.deepEqual(sent, ['BAD111', 'GOOD22']);
});

test('an inconsistent returned identity never confirms or consumes a source', async () => {
  const { context } = setup(); context.capture({ ref: 'ABC123' });
  await assert.rejects(context.synchronize(user, async () => ({ id: 'wrong-member', referralSource: 'explicit' })), error => error.code === 'CONTEXT_CHANGED');
  assert.deepEqual(codes(context), ['ABC123']);
});
