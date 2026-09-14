import test from 'node:test';
import assert from 'node:assert/strict';
import { request as httpRequest } from 'node:http';
import { randomUUID } from 'node:crypto';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { openDatabase } from '../../server/db.mjs';
import { createApplication } from '../../server/app.mjs';
import { hashPassword, insertUser, createOrder, applyVerifiedPayment } from '../../server/domain.mjs';
import { createResource, transitionResource } from '../../server/resources.mjs';
import { createBackup, verifyBackup, inspectDatabase } from '../../scripts/backup.mjs';

const password = 'IsolatedResourcePassword1';
const draft = { title: '未公开测试资料', summary: '隔离摘要', body: '私有正文不能通过列表泄漏', category: 'lectures', action: {type:'miniProgram',appId:'wx0000000000000001',path:'pages/course/index?id=isolated'} };
const publicAccess = { visibility: 'public', planIds: [] };
async function setup(t) {
  const db = openDatabase(':memory:');
  const server = createApplication(db, { allowNativeTrialAuth: true, hosts: ['127.0.0.1'], origins: ['http://127.0.0.1'] });
  await new Promise((resolve, reject) => { server.once('error', reject); server.listen(0, '127.0.0.1', resolve); });
  t.after(async () => { server.closeAllConnections(); await new Promise(resolve => server.close(resolve)); db.close(); });
  const base = `http://127.0.0.1:${server.address().port}/api`;
  const request = (path, body, headers = {}) => new Promise((resolve, reject) => {
    const req = httpRequest(base + path, { method: body === undefined ? 'GET' : 'POST', headers: {
      Host: '127.0.0.1', 'Content-Type': 'application/json', 'X-Club-Request': '1', ...headers } }, res => {
      const chunks = []; res.on('data', chunk => chunks.push(chunk)); res.on('error', reject);
      res.on('end', () => resolve({ status: res.statusCode, body: JSON.parse(Buffer.concat(chunks).toString('utf8')),
        cookie: res.headers['set-cookie']?.[0].split(';')[0] }));
    });
    req.on('error', reject); req.end(body === undefined ? undefined : JSON.stringify(body));
  });
  const admin = insertUser(db, 'resource_admin', await hashPassword(password), 'admin');
  const login = await request('/auth/login', { username: 'resource_admin', password });
  const manage = (path = '', body, headers = {}) => request('/admin/resources' + path, body, { Cookie: login.cookie, ...headers });
  async function member(planId) {
    const result = await request('/native/auth/register', { username: 'member_' + (planId || 'unpaid'), password, consent: true });
    if (planId) {
      const user = result.body.user;
      const order = createOrder(db, user.id, { planId, consent: true, form: { name: '隔离会员', phone: '13800000000', city: '测试城市', company: '测试机构', organizationType: '机构会员' } }, randomUUID());
      if (order.status === 'review') db.prepare("UPDATE orders SET status='pending' WHERE id=?").run(order.id);
      const expected = { appId: 'ISOLATED_ARTICLES', merchantId: 'ISOLATED_ARTICLES' };
      applyVerifiedPayment(db, { ...expected, transactionId: randomUUID(), orderId: order.id, currency: 'CNY',
        amountCents: order.amountCents, status: 'SUCCESS', paidAt: new Date().toISOString() }, expected);
    }
    return { id: result.body.user.id, headers: { Authorization: 'Bearer ' + result.body.accessToken } };
  }
  return { db, admin, request, manage, member };
}

test('resource draft creation requires admin and explicit publishing never defaults an audience', async t => {
  const env = await setup(t), key = randomUUID();
  const unpaid = await env.member();
  assert.equal((await env.request('/admin/resources', draft, { ...unpaid.headers, 'Idempotency-Key': key })).status, 403);
  const created = await env.manage('', draft, { 'Idempotency-Key': key });
  assert.equal(created.status, 201); const item = created.body.resource;
  assert.equal(item.status, 'draft'); assert.equal(item.access.visibility, 'unconfigured');
  assert.equal((await env.manage('', draft, { 'Idempotency-Key': key })).body.resource.id, item.id);
  assert.equal((await env.manage('', { ...draft, title: '换一个内容' }, { 'Idempotency-Key': key })).status, 409);
  assert.equal((await env.manage('/' + item.id + '/publish', { revision: item.revision })).status, 400);
  assert.equal((await env.request('/resources')).body.resources.length, 0);
  assert.equal((await env.request('/resources/' + item.id)).status, 404);
  assert.equal(env.db.prepare("SELECT count(*) n FROM audit_log WHERE action='resource.created'").get().n, 1);
});

test('configured plan access is exact, expires server-side, and lists never return restricted titles or bodies', async t => {
  const env = await setup(t);
  const basic = await env.member('basic'), star = await env.member('star'), organization = await env.member('organization');
  const item = createResource(env.db, env.admin, { ...draft, access: { visibility: 'plans', planIds: ['basic'] } }, randomUUID());
  transitionResource(env.db, env.admin, item.id, 'publish', item.revision);
  for (const headers of [{}, star.headers, organization.headers]) {
    const list = await env.request('/resources', undefined, headers);
    assert.deepEqual(list.body.resources, []);
    const detail = await env.request('/resources/' + item.id, undefined, headers);
    assert.equal(detail.status, 404); assert.equal(JSON.stringify(detail).includes(draft.body), false);
  }
  const list = (await env.request('/resources', undefined, basic.headers)).body.resources;
  assert.equal(list[0].id, item.id); assert.equal(list[0].body, undefined); assert.equal(list[0].access, undefined);
  assert.equal((await env.request('/resources/' + item.id, undefined, basic.headers)).body.resource.body, draft.body);
  env.db.prepare("UPDATE memberships SET expires_at='2000-01-01T00:00:00.000Z' WHERE user_id=?").run(basic.id);
  assert.deepEqual((await env.request('/resources', undefined, basic.headers)).body.resources, []);
  assert.equal((await env.request('/resources/' + item.id, undefined, basic.headers)).status, 404);
  env.db.prepare('DELETE FROM memberships WHERE user_id=?').run(basic.id);
  assert.equal((await env.request('/resources/' + item.id, undefined, basic.headers)).status, 404);
});

test('published content must be withdrawn before editing and stale revisions cannot overwrite another edit', async t => {
  const env = await setup(t);
  const created = (await env.manage('', { ...draft, access: publicAccess }, { 'Idempotency-Key': randomUUID() })).body.resource;
  const pub = (await env.manage('/' + created.id + '/publish', { revision: created.revision })).body.resource;
  assert.equal((await env.request('/resources/' + pub.id)).body.resource.title, draft.title);
  assert.equal((await env.manage('/' + pub.id, { ...draft, access: publicAccess, revision: pub.revision })).status, 409);
  assert.equal((await env.manage('/' + pub.id + '/unpublish', { revision: created.revision })).status, 409);
  const withdrawn = (await env.manage('/' + pub.id + '/unpublish', { revision: pub.revision })).body.resource;
  assert.equal((await env.request('/resources/' + pub.id)).status, 404);
  const edited = await env.manage('/' + pub.id, { ...draft, title: '新版草稿', access: publicAccess, revision: withdrawn.revision });
  assert.equal(edited.status, 200);
  assert.equal((await env.manage('/' + pub.id, { ...draft, title: '迟到的旧修改', revision: withdrawn.revision })).status, 409);
  assert.equal((await env.request('/resources')).body.resources.length, 0);
  assert.equal((await env.manage('/' + pub.id + '/publish', { revision: edited.body.resource.revision })).status, 200);
  assert.equal((await env.request('/resources/' + pub.id)).body.resource.title, '新版草稿');
  assert.equal(env.db.prepare("SELECT count(*) n FROM audit_log WHERE action='resource.publish'").get().n, 2);
});

test('invalid access policies and empty bodies cannot be published', async t => {
  const env = await setup(t);
  for (const access of [null, { visibility: 'plans', planIds: [] }, { visibility: 'public', planIds: ['basic'] },
    { visibility: 'plans', planIds: ['__proto__'] }, { visibility: 'anything', planIds: [] }]) {
    assert.equal((await env.manage('', { ...draft, access }, { 'Idempotency-Key': randomUUID() })).status, 400);
  }
  const empty = (await env.manage('', { ...draft, body: '', access: publicAccess }, { 'Idempotency-Key': randomUUID() })).body.resource;
  assert.equal((await env.manage('/' + empty.id + '/publish', { revision: empty.revision })).status, 400);
});

test('additive content migration preserves legacy users and backup verification includes content rows', t => {
  const root = mkdtempSync(join(tmpdir(), 'club-resource-migration-'));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const path = join(root, 'old.sqlite'); let db = openDatabase(path);
  const admin = insertUser(db, 'old_admin', 'isolated-unused', 'admin');
  db.exec('DROP TABLE service_resources; DELETE FROM schema_version WHERE version>4'); db.close();
  const legacy = inspectDatabase(path); assert.equal(legacy.counts.service_resources, undefined);
  db = openDatabase(path);
  assert.equal(db.prepare('SELECT count(*) n FROM users WHERE id=?').get(admin.id).n, 1);
  const content = createResource(db, admin, draft, randomUUID()); db.close();
  db = openDatabase(path); assert.equal(db.prepare('SELECT title FROM service_resources WHERE id=?').get(content.id).title, draft.title); db.close();
  const backup = createBackup({ sourcePath: path, outputRoot: join(root, 'backups') });
  assert.equal(backup.counts.service_resources, 1);
  assert.equal(verifyBackup({ backupPath: backup.backupPath, restoreRoot: join(root, 'restore') }).contentDigest, backup.contentDigest);
  db = openDatabase(path); db.exec('DROP TABLE service_resources'); db.close();
  assert.throws(() => inspectDatabase(path), /服务资源数据表缺失/);
});

test('service publication requires a real action, rejects malformed targets, and never includes actions in the catalog', async t => {
  const env = await setup(t);
  for (const action of [null, {type:'web',url:'javascript:alert(1)'}, {type:'phone',phoneNumber:'invalid'},
    {type:'miniProgram',appId:'wx-invalid'}, {type:'miniProgram',appId:'wx0000000000000001',path:'https://example.com'}]) {
    assert.equal((await env.manage('', {...draft,action}, {'Idempotency-Key':randomUUID()})).status,400);
  }
  let item=(await env.manage('', {...draft,access:publicAccess,action:{type:'unconfigured'}}, {'Idempotency-Key':randomUUID()})).body.resource;
  assert.equal((await env.manage('/'+item.id+'/publish',{revision:item.revision})).status,400);
  item=(await env.manage('/'+item.id,{...draft,access:publicAccess,revision:item.revision,action:{type:'phone',phoneNumber:'13800000000'}})).body.resource;
  assert.equal((await env.manage('/'+item.id+'/publish',{revision:item.revision})).status,200);
  assert.equal((await env.request('/resources')).body.resources[0].action,undefined);
  assert.equal((await env.request('/resources/'+item.id)).body.resource.action.phoneNumber,'13800000000');
});
