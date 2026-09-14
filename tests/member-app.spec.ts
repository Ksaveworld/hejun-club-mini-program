import { test, expect } from "@playwright/test";

test("手机与电脑使用同一会员导航，后台保持独立布局", async ({ page }) => {
  for (const width of [360, 390, 1440]) {
    await page.setViewportSize({ width, height: 844 });
    await page.goto("/#/");
    const nav = page.getByRole("navigation", { name: "手机导航" });
    await expect(nav).toBeVisible();
    await expect(nav.getByRole("link")).toHaveCount(4);
    await expect(page.getByRole("navigation", { name: "主导航" })).toHaveCount(0);
    await nav.getByRole("link", { name: "我的", exact: true }).click();
    await expect(page.getByRole("heading", { name: "我的会员中心" })).toBeVisible();
    await page.getByRole("link", { name: "演示后台", exact: true }).click();
    await expect(page.getByRole("heading", { name: "运营工作台" })).toBeVisible();
    await expect(page.locator(".member-shell")).toHaveCount(0);
    await page.getByRole("link", { name: "返回会员端", exact: true }).click();
    await expect(nav).toBeVisible();
  }
});

test("三档会员切换显示对应费用及申请入口，权益对比可展开", async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 844 });
  await page.goto("/#/members");
  for (const [label, id, price] of [["基础会员", "basic", "365"], ["星级会员", "star", "3,650"], ["机构 / 专业", "organization", "36,500"]]) {
    await page.getByRole("tab", { name: label, exact: true }).click();
    const panel = page.getByRole("tabpanel");
    await expect(panel.locator(".price")).toContainText(price);
    await expect(panel.getByRole("link")).toHaveAttribute("href", `#/join/${id}`);
    await expect(page.locator(".plan-card")).toHaveCount(1);
  }
  await page.locator(".app-comparison summary").click();
  await expect(page.getByRole("table")).toBeVisible();
  expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBeLessThanOrEqual(390);
});

test("服务搜索、空结果恢复及首页订单投稿直达", async ({ page }) => {
  await page.goto("/#/services");
  const search = page.getByRole("searchbox", { name: "搜索会员服务" });
  await search.fill("知识");
  await expect(page.locator(".app-service-list > button")).toHaveCount(1);
  await page.getByRole("button", { name: /跨境知识库/ }).click();
  await expect(page.getByRole("dialog")).toContainText("本样稿尚未接入该服务");
  await page.keyboard.press("Escape");
  await search.fill("找不到的服务");
  await expect(page.getByRole("heading", { name: "没有找到相关服务" })).toBeVisible();
  await page.getByRole("button", { name: "查看全部服务", exact: true }).click();
  await expect(page.locator(".app-service-list > button")).toHaveCount(6);
  await page.goto("/#/join/basic");
  await page.getByRole("button", { name: "填入演示资料" }).click();
  await page.getByRole("checkbox").check();
  await page.getByRole("button", { name: "确认信息，下一步" }).click();
  await page.getByRole("button", { name: "模拟付款成功，开通会员" }).click();
  await page.goto("/#/");
  await page.getByRole("link", { name: "我的订单", exact: true }).click();
  await expect(page.getByRole("tab", { name: "我的订单", exact: true })).toHaveAttribute("aria-selected", "true");
  await expect(page.getByRole("tabpanel")).toContainText("模拟已开通");
  await page.goto("/#/");
  await page.getByRole("link", { name: "我的投稿", exact: true }).click();
  await expect(page.getByRole("tab", { name: "我的投稿", exact: true })).toHaveAttribute("aria-selected", "true");
  await expect(page.getByRole("textbox", { name: "标题", exact: true })).toBeVisible();
});
