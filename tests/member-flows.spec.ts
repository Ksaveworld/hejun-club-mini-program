import { test, expect, type Page } from '@playwright/test';

async function login(page: Page, admin = false) {
  await page.goto(admin ? '/#/admin' : '/#/account?tab=orders');
  await page.getByRole('textbox', { name: '账号', exact: true }).fill(admin ? 'test_admin' : 'test_paid_member');
  await page.getByLabel('密码', { exact: true }).fill('OnlyInIsolatedTests1');
  await page.getByRole('button', { name: '登录', exact: true }).click();
  await expect(page.getByRole('heading', { name: admin ? '运营工作台' : '我的订单', exact: true })).toBeVisible();
}

test('会员申请大使后，运营跟进结果回到本人页面且不产生奖励余额', async ({ page, browser }) => {
  await page.setViewportSize({ width: 390, height: 844 });
  await login(page);
  await page.goto('/#/account?tab=referral');
  await page.getByRole('textbox', { name: '联系微信或电话' }).fill('隔离测试联系');
  await page.getByRole('textbox', { name: '推荐意向（选填）' }).fill('希望邀请同行');
  await page.getByRole('checkbox', { name: '同意保存申请信息，以便运营人员联系' }).check();
  await page.getByRole('button', { name: '提交大使申请' }).click();
  await expect(page.getByText('申请已收到，待联系', { exact: true })).toBeVisible();
  await page.reload();
  await expect(page.getByText('申请已收到，待联系', { exact: true })).toBeVisible();
  const context = await browser.newContext();
  try {
    const admin = await context.newPage();
    await login(admin, true);
    await admin.getByText('推荐大使申请与跟进', { exact: true }).click();
    const card = admin.locator('article').filter({ has: admin.getByRole('heading', { name: '隔离测试联系', exact: true }) });
    await card.getByRole('textbox', { name: '会员可见的跟进说明' }).fill('已收到意向，后续联系您');
    await card.getByRole('button', { name: '记录跟进' }).click();
    await expect(card).toContainText('已跟进');
    await page.reload();
    await expect(page.getByText('跟进说明：已收到意向，后续联系您', { exact: true })).toBeVisible();
    await expect(page.getByText('本次为申请登记，尚未开始计奖。奖励与结算以正式开放时的规则为准。', { exact: true })).toBeVisible();
    await page.screenshot({ path: '../analysis/u13-ambassador.png', fullPage: true });
  } finally { await context.close(); }
});
