import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { createServer } from 'node:net';
import { mkdir } from 'node:fs/promises';
import { chromium, expect } from '@playwright/test';
let origin;
let server, browser;
before(async () => {
  const reserve = createServer();
  await new Promise((resolve, reject) => { reserve.once('error', reject); reserve.listen(0, '127.0.0.1', resolve); });
  const port = reserve.address().port;
  await new Promise(resolve => reserve.close(resolve));
  origin = 'http://127.0.0.1:' + port;
  server = spawn(process.execPath, ['node_modules/vite/bin/vite.js', '--config', 'vite.grant-preview.config.ts', '--port', String(port)], { stdio: 'ignore' });
  for (let i = 0; i < 150; i++) {
    if (server.exitCode !== null) throw Error('Isolated preview server exited before readiness');
    try { if ((await fetch(origin + '/grant-preview/')).ok) break; } catch {}
    if (i === 149) throw Error('Preview server unavailable');
    await new Promise(r => setTimeout(r, 100));
  }
  browser = await chromium.launch({ channel: 'msedge', headless: true });
});
after(async () => { await browser?.close(); server?.kill(); });
async function fixture(t, viewport) {
  const context = await browser.newContext({ viewport: viewport || { width: 1440, height: 1100 } });
  const page = await context.newPage(); page.setDefaultTimeout(7000);
  const external = [], errors = [];
  await page.route('**/*', route => {
    const u = new URL(route.request().url());
    if (u.origin !== origin || u.pathname.startsWith('/api/')) { external.push(u.pathname); return route.abort(); }
    return route.continue();
  });
  page.on('pageerror', e => errors.push(e.message));
  page.on('dialog', d => d.accept());
  t.after(async () => { await context.close(); assert.deepEqual(external, [], 'preview must never call business APIs'); assert.deepEqual(errors, []); });
  await page.goto(origin + '/grant-preview/');
  await expect(page.getByRole('button', { name: '查找账号', exact: true })).toBeDisabled();
  await expect(page.getByLabel('手机号', { exact: true })).toBeEnabled();
  await page.getByLabel('查找方式', { exact: true }).selectOption('userId');
  return page;
}
async function lookup(page, id = 'DEMO-001') {
  await page.getByLabel('已注册用户编号', { exact: true }).fill(id);
  await page.getByRole('button', { name: '查找账号', exact: true }).click();
}
async function preflight(page) {
  await lookup(page);
  await page.getByLabel('我已核对该账号与获批受赠对象一致', { exact: true }).check();
  await page.getByLabel('赠送等级', { exact: true }).selectOption('star');
  await page.getByLabel('赠送原因', { exact: true }).fill('虚构的会员服务测试');
  await page.getByLabel('批准依据', { exact: true }).fill('SYNTHETIC-APPROVAL');
  await page.getByRole('button', { name: '检查赠送条件', exact: true }).click();
  await expect(page.getByRole('heading', { name: '确认赠送', exact: true })).toBeVisible();
}
async function confirm(page) {
  await page.getByLabel('确认本次赠送一年星级会员，不修改付款订单', { exact: true }).check();
  await page.getByRole('button', { name: '确认赠送', exact: true }).click();
}
const calls = page => page.evaluate(() => window.__grantFixture.control.issueCalls);
test('single verified recipient -> preflight -> grant -> history -> revoke; no business requests', async t => {
  const page = await fixture(t); await preflight(page);
  await expect(page.getByRole('button', { name: '确认赠送', exact: true })).toBeDisabled();
  await confirm(page); await expect(page.getByRole('status')).toContainText('模拟赠送结果已确认');
  assert.equal((await calls(page)).length, 1);
  const active = page.getByRole('row').filter({ hasText: '虚构的会员服务测试' });
  await expect(active).toContainText('有效');
  await active.getByRole('button', { name: '撤销', exact: true }).click();
  await expect(page.getByRole('button', { name: '确认撤销', exact: true })).toBeDisabled();
  await page.getByLabel('撤销原因', { exact: true }).fill('虚构撤销原因');
  await page.getByRole('button', { name: '确认撤销', exact: true }).click();
  await expect(page.getByRole('status')).toContainText('模拟撤销结果已确认');
  await expect(active).toContainText('已撤销'); await expect(active.getByRole('button')).toBeDisabled();
});
test('unverified, absent and ambiguous accounts block further actions', async t => {
  const page = await fixture(t);
  await lookup(page, 'DEMO-003'); await expect(page.getByText('身份依据不足，不能赠送', { exact: true })).toBeVisible();
  await expect(page.getByLabel('我已核对该账号与获批受赠对象一致')).toBeDisabled();
  await lookup(page, 'DEMO-MULTI'); await expect(page.getByRole('alert')).toContainText('多个账号');
  await lookup(page, 'MISSING'); await expect(page.getByRole('alert')).toContainText('没有找到');
  await expect(page.getByRole('button', { name: '检查赠送条件' })).toBeDisabled(); assert.equal((await calls(page)).length, 0);
});
test('overlap shows paid source and blocks confirmation; input changes invalidate preview', async t => {
  const page = await fixture(t); await lookup(page, 'DEMO-002');
  await page.getByLabel('我已核对该账号与获批受赠对象一致').check();
  await page.getByLabel('赠送等级', { exact: true }).selectOption('star');
  await page.getByLabel('赠送原因', { exact: true }).fill('虚构'); await page.getByLabel('批准依据', { exact: true }).fill('SYNTHETIC');
  await page.getByRole('button', { name: '检查赠送条件' }).click();
  await expect(page.getByRole('alert')).toContainText('已有有效或未来重叠'); await expect(page.getByText(/付费 · 基础会员/)).toBeVisible();
  await expect(page.getByRole('button', { name: '确认赠送', exact: true })).toHaveCount(0);
  await preflight(page); await page.getByLabel('赠送原因', { exact: true }).fill('修改原因');
  await expect(page.getByRole('heading', { name: '确认赠送', exact: true })).toHaveCount(0);
  assert.equal((await calls(page)).length, 0);
});
test('lost issue response survives reload; same key retry creates only one grant', async t => {
  const page = await fixture(t); await preflight(page);
  await page.evaluate(() => { window.__grantFixture.control.issueReplyLost = true; });
  await confirm(page); await expect(page.getByRole('alert')).toContainText('结果尚未确认');
  const original = (await calls(page))[0];
  await expect(page.getByLabel('已注册用户编号')).toBeDisabled();
  await page.reload(); await expect(page.getByRole('button', { name: '核对并重试原操作' })).toBeEnabled();
  await page.getByRole('button', { name: '核对并重试原操作' }).click();
  await expect(page.getByRole('status')).toContainText('本次未重复执行');
  assert.deepEqual((await calls(page))[0], original);
  assert.equal(await page.evaluate(() => window.__grantFixture.data.rows.filter(g => g.grantId.startsWith('demo-grant-')).length), 1);
});
test('lost revoke response retries original operation without a second revocation', async t => {
  const page = await fixture(t); await lookup(page);
  await page.getByRole('row').filter({ hasText: '历史赠送示例' }).getByRole('button').click();
  await page.getByLabel('撤销原因').fill('虚构撤销'); await page.evaluate(() => { window.__grantFixture.control.revokeReplyLost = true; });
  await page.getByRole('button', { name: '确认撤销', exact: true }).click(); await expect(page.getByRole('alert')).toContainText('结果尚未确认');
  await page.getByRole('button', { name: '核对并重试原操作' }).click(); await expect(page.getByRole('status')).toContainText('本次未重复执行');
  const requests = await page.evaluate(() => window.__grantFixture.control.revokeCalls); assert.equal(requests.length, 2); assert.deepEqual(requests[0], requests[1]);
});
test('session change before confirmation sends no issue and clears visible identity', async t => {
  const page = await fixture(t); await preflight(page);
  await page.evaluate(() => { window.__grantFixture.control.actorId = 'other-admin'; });
  await confirm(page); await expect(page.getByRole('alert')).toContainText('身份已变化');
  assert.equal((await calls(page)).length, 0); await expect(page.getByText('虚构会员甲', { exact: true })).toHaveCount(0);
});
test('expired preflight and definitive conflict require fresh preflight', async t => {
  const page = await fixture(t); await page.evaluate(() => { window.__grantFixture.control.expirePreflight = true; }); await preflight(page);
  await expect(page.getByRole('button', { name: '确认赠送', exact: true })).toBeDisabled();
  await page.evaluate(() => { window.__grantFixture.control.expirePreflight = false; window.__grantFixture.control.rejectNextIssue = true; });
  await page.getByRole('button', { name: '检查赠送条件' }).click(); await confirm(page);
  await expect(page.getByRole('alert')).toContainText('原权益已变化'); await expect(page.getByRole('button', { name: '核对并重试原操作' })).toHaveCount(0);
  assert.equal(await page.evaluate(() => window.__grantFixture.data.rows.length), 1);
});
test('successful grant with failed history refresh is not presented as a failed grant', async t => {
  const page = await fixture(t); await preflight(page); await page.evaluate(() => { window.__grantFixture.control.failHistory = true; }); await confirm(page);
  await expect(page.getByRole('status')).toContainText('赠送结果已确认'); await expect(page.getByRole('alert')).toContainText('历史记录刷新失败');
  await expect(page.getByRole('button', { name: '核对并重试原操作' })).toHaveCount(0);
  await page.evaluate(() => { window.__grantFixture.control.failHistory = false; }); await page.getByRole('button', { name: '刷新记录' }).click();
  await expect(page.getByRole('row').filter({ hasText: '虚构的会员服务测试' })).toContainText('有效'); assert.equal((await calls(page)).length, 1);
});
test('storage failure before dispatch fails closed', async t => {
  const page = await fixture(t); await preflight(page);
  await page.evaluate(() => { const orig = Storage.prototype.setItem; Storage.prototype.setItem = function(k, v) { if (k.startsWith('grant-ui-pending-')) throw Error('storage denied'); return orig.call(this, k, v); }; });
  await confirm(page); await expect(page.getByRole('alert')).toContainText('本次未发出请求'); assert.equal((await calls(page)).length, 0);
});
test('changing recipient clears old revoke confirmation and pagination', async t => {
  const page = await fixture(t); await lookup(page);
  await page.getByRole('row').filter({ hasText: '历史赠送示例' }).getByRole('button').click();
  await page.getByLabel('撤销原因').fill('针对旧账号的原因');
  await page.getByLabel('已注册用户编号').fill('DEMO-002');
  await expect(page.getByRole('region', { name: '撤销确认' })).toHaveCount(0);
  await expect(page.getByRole('button', { name: '确认撤销', exact: true })).toHaveCount(0);
  await expect(page.getByRole('button', { name: '加载更多记录' })).toHaveCount(0);
  assert.equal(await page.evaluate(() => window.__grantFixture.control.revokeCalls.length), 0);
});
test('double confirmation sends one request, and pagination remains scoped', async t => {
  const page = await fixture(t);
  await page.evaluate(() => {
    const f = window.__grantFixture;
    for (let i = 0; i < 4; i++) f.data.rows.push({ ...f.data.rows[0], grantId: 'history-' + i });
  });
  await preflight(page);
  await page.getByRole('button', { name: '加载更多记录' }).click();
  await expect(page.locator('tbody tr')).toHaveCount(4);
  await page.getByRole('button', { name: '加载更多记录' }).click(); await expect(page.locator('tbody tr')).toHaveCount(5);
  await page.getByLabel('确认本次赠送一年星级会员，不修改付款订单').check();
  await page.evaluate(() => {
    window.__grantFixture.control.delay = 100;
    const b = [...document.querySelectorAll('button')].find(b => b.textContent === '确认赠送'); b.click(); b.click();
  });
  await expect(page.getByRole('status')).toContainText('赠送结果已确认'); assert.equal((await calls(page)).length, 1);
});
test('malformed success is treated as uncertain, never as a confirmed grant', async t => {
  const page = await fixture(t); await preflight(page);
  await page.evaluate(() => { window.__grantFixture.api.issue = async () => ({ grant: { userId: 'OTHER' }, duplicate: false }); });
  await confirm(page); await expect(page.getByRole('alert')).toContainText('结果尚未确认');
  await expect(page.getByRole('button', { name: '核对并重试原操作' })).toBeEnabled();
  await expect(page.getByRole('region', { name: '操作结果' })).toHaveCount(0);
});
test('desktop and narrow preview keep actions visible; screenshots', async t => {
  const page = await fixture(t); await preflight(page);
  await mkdir('work/grant-ui-evidence', { recursive: true });
  await page.screenshot({ path: 'work/grant-ui-evidence/desktop.png', fullPage: true });
  await page.setViewportSize({ width: 390, height: 844 });
  await expect(page.getByRole('button', { name: '确认赠送', exact: true })).toBeVisible();
  assert.ok(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), 'no page-level horizontal overflow');
  await page.screenshot({ path: 'work/grant-ui-evidence/narrow.png', fullPage: true });
});
async function phoneLookup(page, value = '+9990000001') {
  await page.getByLabel('查找方式', { exact: true }).selectOption('phone');
  await page.getByLabel('手机号', { exact: true }).fill(value);
  await page.getByRole('button', { name: '查找账号', exact: true }).click();
}
async function basicPreflight(page) {
  await phoneLookup(page, '+999 0000 001');
  await page.getByLabel('我已核对该账号与获批受赠对象一致').check();
  await page.getByLabel('赠送原因', { exact: true }).fill('虚构基础赠送');
  await page.getByLabel('批准依据', { exact: true }).fill('SYNTHETIC-BASIC');
  await expect(page.getByRole('button', { name: '检查赠送条件' })).toBeDisabled();
  await page.getByLabel('赠送等级', { exact: true }).selectOption('basic');
  await page.getByRole('button', { name: '检查赠送条件' }).click();
  await expect(page.getByText('本次赠送：基础会员 · 一年', { exact: true })).toBeVisible();
}
async function confirmBasic(page) {
  await page.getByLabel('确认本次赠送一年基础会员，不修改付款订单').check();
  await page.getByRole('button', { name: '确认赠送', exact: true }).click();
}
test('phone lookup resolves stable account, explicit basic grant and revoke retain actual level', async t => {
  const page = await fixture(t); await basicPreflight(page);
  await mkdir('work/grant-ui-evidence', { recursive: true });
  await page.screenshot({ path: 'work/grant-ui-evidence/basic-phone-desktop.png', fullPage: true });
  await page.setViewportSize({ width: 390, height: 844 });
  assert.ok(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth));
  await page.screenshot({ path: 'work/grant-ui-evidence/basic-phone-narrow.png', fullPage: true });
  await page.setViewportSize({ width: 1440, height: 1100 });
  await confirmBasic(page);
  await expect(page.getByRole('region', { name: '操作结果' })).toContainText('基础会员');
  const requests = await calls(page); assert.equal(requests[0].level, 'basic'); assert.equal(requests[0].userId, 'DEMO-001');
  assert.ok(!JSON.stringify(requests).includes('+999'), 'raw phone must not enter grant payload or journal');
  const row = page.getByRole('row').filter({ hasText: '虚构基础赠送' }); await expect(row).toContainText('基础会员');
  await row.getByRole('button', { name: '撤销', exact: true }).click();
  await expect(page.getByRole('region', { name: '撤销确认' })).toContainText('基础会员');
  await page.getByLabel('撤销原因').fill('虚构撤销基础赠送'); await page.getByRole('button', { name: '确认撤销', exact: true }).click();
  await expect(row).toContainText('已撤销'); await expect(row).toContainText('基础会员');
});
test('phone missing, multiple, unverified and unavailable binding sources all block granting', async t => {
  const page = await fixture(t);
  await phoneLookup(page, '+9990000099'); await expect(page.getByRole('alert')).toContainText('多个账号');
  await phoneLookup(page, '+9990000088'); await expect(page.getByRole('alert')).toContainText('没有找到');
  await phoneLookup(page, '+9990000004'); await expect(page.getByRole('alert')).toContainText('没有可核验');
  await phoneLookup(page, '+9990000003'); await expect(page.getByText('身份依据不足，不能赠送')).toBeVisible();
  await expect(page.getByLabel('我已核对该账号与获批受赠对象一致')).toBeDisabled();
  await expect(page.getByRole('button', { name: '检查赠送条件' })).toBeDisabled(); assert.equal((await calls(page)).length, 0);
});
test('changing tier, phone or lookup mode clears previous confirmation', async t => {
  const page = await fixture(t); await basicPreflight(page);
  await page.getByLabel('赠送等级').selectOption('star'); await expect(page.getByRole('button', { name: '确认赠送', exact: true })).toHaveCount(0);
  await page.getByRole('button', { name: '检查赠送条件' }).click(); await expect(page.getByText('本次赠送：星级会员 · 一年')).toBeVisible();
  await page.getByLabel('手机号', { exact: true }).fill('+9990000002');
  await expect(page.getByRole('heading', { name: '虚构会员甲' })).toHaveCount(0); await expect(page.getByLabel('赠送等级')).toHaveValue('');
  await expect(page.getByRole('button', { name: '确认赠送', exact: true })).toHaveCount(0);
  await page.getByLabel('查找方式').selectOption('userId'); await expect(page.getByLabel('已注册用户编号')).toHaveValue(''); assert.equal((await calls(page)).length, 0);
});
test('basic grant uncertain result keeps tier and original key after reload', async t => {
  const page = await fixture(t); await basicPreflight(page); await page.evaluate(() => { window.__grantFixture.control.issueReplyLost = true; }); await confirmBasic(page);
  await expect(page.getByRole('alert')).toContainText('结果尚未确认'); await expect(page.getByLabel('赠送等级')).toBeDisabled();
  const request = (await calls(page))[0]; await page.reload();
  await page.getByRole('button', { name: '核对并重试原操作' }).click();
  await expect(page.getByRole('status')).toContainText('本次未重复执行'); assert.deepEqual((await calls(page))[0], request);
  await expect(page.getByRole('region', { name: '操作结果' })).toContainText('基础会员');
});
test('wrong returned tier cannot turn a basic request into a star success', async t => {
  const page = await fixture(t); await basicPreflight(page);
  await page.evaluate(() => { const f = window.__grantFixture, issue = f.api.issue; f.api.issue = async input => { const r = await issue(input); return { ...r, grant: { ...r.grant, level: 'star' } }; }; });
  await confirmBasic(page); await expect(page.getByRole('alert')).toContainText('结果尚未确认'); await expect(page.getByRole('region', { name: '操作结果' })).toHaveCount(0);
});
test('legacy pending record without level is preserved and blocks new requests', async t => {
  const page = await fixture(t);
  await page.evaluate(() => sessionStorage.setItem('grant-ui-pending-v1:demo-admin', JSON.stringify({ kind: 'issue', input: { userId: 'DEMO-001', reason: 'legacy', approvalReference: 'SYNTHETIC', confirmationToken: 'legacy', idempotencyKey: 'legacy-key' } })));
  await page.reload(); await expect(page.getByRole('alert')).toContainText('缺少等级'); await expect(page.getByLabel('手机号', { exact: true })).toBeDisabled();
  assert.ok(await page.evaluate(() => sessionStorage.getItem('grant-ui-pending-v1:demo-admin'))); assert.equal((await calls(page)).length, 0);
});
