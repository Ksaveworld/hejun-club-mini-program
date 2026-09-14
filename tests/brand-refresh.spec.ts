import { test, expect } from "@playwright/test";

for (const width of [1440, 390]) {
  test(`首页 ${width}px：六项服务及会员指南均打开对应内容，关闭后恢复焦点`, async ({ page }) => {
    await page.setViewportSize({ width, height: 844 });
    await page.goto("/#/");
    const dock = page.getByRole("region", { name: "快捷查看会员服务" });
    for (const title of ["翻译服务", "跨境大讲堂", "跨境知识库", "产品与服务名录", "行业资讯", "交流与参访"]) {
      const trigger = dock.getByRole("button", { name: new RegExp(title) });
      await trigger.click();
      await expect(page.getByRole("dialog").getByRole("heading", { name: title, exact: true })).toBeVisible();
      await expect(page.getByRole("dialog")).toContainText("本样稿尚未接入该服务");
      await page.keyboard.press("Escape");
      await expect(trigger).toBeFocused();
    }
    const guide = page.locator(".club-guide-list");
    for (const title of ["第一次加入，从这里开始", "哪一种会员适合你？", "让更多人了解你的专业服务"]) {
      const trigger = guide.getByRole("button", { name: new RegExp(title.replace("？", "\\？")) });
      await trigger.click();
      await expect(page.getByRole("dialog").getByRole("heading", { name: title, exact: true })).toBeVisible();
      await page.getByRole("button", { name: "关闭弹窗" }).click();
      await expect(trigger).toBeFocused();
    }
  });
}

for (const width of [360, 390]) {
  test(`手机 ${width}px：服务台可直接进入，表单操作栏在滚动中不会被底部导航遮挡`, async ({ page }) => {
    await page.setViewportSize({ width, height: 844 });
    await page.goto("/#/");
    const nav = page.getByRole("navigation", { name: "手机导航" });
    await nav.getByRole("link", { name: "服务台" }).click();
    await expect(page.getByRole("heading", { name: "从信息到行动，找到支持" })).toBeVisible();
    await expect(nav.getByRole("link", { name: "服务台" })).toHaveAttribute("aria-current", "page");
    await page.goto("/#/join/basic");
    // The mobile service layout keeps submission after the fields in document flow.
    // Check its real hit target after scrolling, including on a shorter viewport.
    for (const height of [844, 650]) {
      await page.setViewportSize({ width, height });
      await page.locator(".form-bottom .button").scrollIntoViewIfNeeded();
      await expect.poll(() => page.locator(".form-bottom .button").evaluate((button) => {
        const rect = button.getBoundingClientRect();
        const navRect = document.querySelector(".mobile-nav")!.getBoundingClientRect();
        const hit = document.elementFromPoint(rect.x + rect.width / 2, rect.y + rect.height / 2);
        return rect.top >= 0 && rect.bottom <= navRect.top && !!hit && button.contains(hit);
      })).toBe(true);
    }
  });
}
