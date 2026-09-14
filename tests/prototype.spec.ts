import { test, expect, type Page } from "@playwright/test";

async function fillDemoApplication(page: Page, plan = "basic") {
  await page.goto(`/#/join/${plan}`);
  await page.getByRole("button", { name: "填入演示资料" }).click();
  await page.getByRole("checkbox").check();
  await page
    .getByRole("button", {
      name: plan === "basic" ? "确认信息，下一步" : "提交演示申请",
    })
    .click();
}

async function activateDemoMember(page: Page) {
  await fillDemoApplication(page);
  await page.getByRole("button", { name: "模拟付款成功，开通会员" }).click();
  await page.getByRole("link", { name: "进入会员中心" }).click();
  await expect(
    page.getByRole("heading", { name: "你好，演示会员" }),
  ).toBeVisible();
}

async function submitPost(page: Page, title: string) {
  await page.getByRole("tab", { name: "我的投稿" }).click();
  await page.getByRole("textbox", { name: "标题", exact: true }).fill(title);
  await page
    .getByRole("textbox", { name: "正文", exact: true })
    .fill("这是一条虚构的交流内容，用于检查投稿与审核流程。");
  await page.getByRole("button", { name: "提交演示投稿" }).click();
  await expect(
    page
      .getByRole("article")
      .filter({ has: page.getByRole("heading", { name: title, exact: true }) }),
  ).toContainText("待审核");
}

async function expectNoPageOverflow(page: Page) {
  const dimensions = await page.evaluate(() => ({
    viewport: document.documentElement.clientWidth,
    content: Math.max(
      document.documentElement.scrollWidth,
      document.body.scrollWidth,
    ),
  }));
  expect(
    dimensions.content,
    `页面 ${page.url()} 不应横向溢出：${JSON.stringify(dimensions)}`,
  ).toBeLessThanOrEqual(dimensions.viewport + 1);
}

test("基础会员：失败保留待付款订单，成功开通且刷新后后台记录一致", async ({
  page,
}) => {
  await fillDemoApplication(page);
  await expect(
    page.getByRole("heading", { name: "确认你的会员方案" }),
  ).toBeVisible();
  await page.getByRole("button", { name: "模拟支付失败", exact: true }).click();
  await expect(page.getByRole("alert")).toContainText("会员尚未开通");
  const savedAfterFailure = await page.evaluate(() =>
    JSON.parse(localStorage.getItem("china-asean-club-preview-v1") || "{}"),
  );
  expect(savedAfterFailure.orders).toHaveLength(1);
  expect(savedAfterFailure.orders[0].status).toBe("pending");
  expect(savedAfterFailure.memberOrderId).toBeNull();
  await page.getByRole("button", { name: "模拟付款成功，开通会员" }).click();
  await expect(
    page.getByRole("heading", { name: "会员已模拟开通" }),
  ).toBeVisible();
  await page.getByRole("link", { name: "进入会员中心" }).click();
  await page.reload();
  await expect(
    page.getByRole("heading", { name: "你好，演示会员" }),
  ).toBeVisible();
  await page.getByRole("tab", { name: "我的订单" }).click();
  await expect(page.getByRole("tabpanel")).toContainText("模拟已开通");
  await page.getByRole("link", { name: "演示后台", exact: true }).click();
  await expect(page.getByText("共 1 条", { exact: true })).toBeVisible();
  await expect(page.getByRole("table", { name: "会员订单记录" })).toContainText(
    "模拟已开通",
  );
  await page.getByRole("button", { name: "查看演示会员的订单详情" }).click();
  await expect(page.getByText("了解东盟市场", { exact: true })).toBeVisible();
  await page
    .getByRole("textbox", { name: "搜索姓名、电话或订单号" })
    .fill("没有这个人");
  await expect(
    page.getByRole("heading", { name: "没有找到匹配记录" }),
  ).toBeVisible();
  await page.getByRole("button", { name: "清除筛选" }).click();
  await expect(page.getByText("共 1 条", { exact: true })).toBeVisible();
});

test("取消模拟付款不会开通会员，订单显示已取消", async ({ page }) => {
  await fillDemoApplication(page);
  await page.getByRole("button", { name: "取消本次模拟" }).click();
  await expect(
    page.getByRole("heading", { name: "本次模拟已取消" }),
  ).toBeVisible();
  await page.goto("/#/account");
  await expect(
    page.getByRole("heading", { name: "还没有开通演示会员" }),
  ).toBeVisible();
  await page.goto("/#/admin");
  await expect(page.getByText("共 1 条", { exact: true })).toBeVisible();
  await expect(page.getByRole("table", { name: "会员订单记录" })).toContainText(
    "已取消",
  );
});

for (const [plan, name] of [
  ["star", "星级会员"],
  ["organization", "机构及专业会员"],
]) {
  test(`${name}只记录待确认申请，不产生模拟会员身份`, async ({ page }) => {
    await fillDemoApplication(page, plan);
    await expect(
      page.getByRole("heading", { name: "演示申请已记录" }),
    ).toBeVisible();
    await expect(
      page.getByText("资料已存入本机演示后台，尚未发送给秘书处或开通会员。"),
    ).toBeVisible();
    await page.getByRole("link", { name: "查看演示后台" }).click();
    await page.getByRole("tab", { name: "机构与星级申请" }).click();
    const applicationTable = page.getByRole("table", {
      name: "机构与星级申请记录",
    });
    await expect(applicationTable).toContainText(name);
    await expect(applicationTable).toContainText("待业务确认");
    await expect(page.getByText("共 1 条", { exact: true })).toBeVisible();
    await page.goto("/#/account");
    await expect(
      page.getByRole("heading", { name: "还没有开通演示会员" }),
    ).toBeVisible();
    await expect(
      page.getByRole("heading", { name: "已记录的演示申请" }),
    ).toBeVisible();
  });
}

test("必填信息和说明勾选会阻止提交，六位推荐码随订单留痕", async ({ page }) => {
  await page.goto("/#/join/basic?ref=ab1234");
  await page.getByRole("button", { name: "确认信息，下一步" }).click();
  await expect(page.getByText("请填写称呼", { exact: true })).toBeVisible();
  await expect(
    page.getByText("请填写 11 位手机号码；可使用演示资料"),
  ).toBeVisible();
  await expect(page.getByText("请填写所在城市", { exact: true })).toBeVisible();
  await expect(
    page.getByText("请先阅读并勾选样稿说明", { exact: true }),
  ).toBeVisible();
  await expect(page.getByRole("textbox", { name: /姓名/ })).toBeFocused();
  await page.getByRole("button", { name: "填入演示资料" }).click();
  await expect(page.getByRole("textbox", { name: /推荐码/ })).toHaveValue(
    "AB1234",
  );
  await page.getByRole("button", { name: "确认信息，下一步" }).click();
  await expect(page).toHaveURL(/#\/join\/basic/);
  await expect(
    page.getByText("请先阅读并勾选样稿说明", { exact: true }),
  ).toBeVisible();
  await page.getByRole("checkbox").check();
  await page.getByRole("button", { name: "确认信息，下一步" }).click();
  await expect(
    page.getByRole("heading", { name: "确认你的会员方案" }),
  ).toBeVisible();
  await expect(page.getByText("AB1234", { exact: true })).toBeVisible();
});

test("投稿审核：驳回理由必填，驳回与通过结果同步到会员中心", async ({
  page,
}) => {
  await activateDemoMember(page);
  await submitPost(page, "演示投稿：需要补充");
  await page.getByRole("link", { name: "前往演示后台审核" }).click();
  await page.getByRole("tab", { name: "内容审核" }).click();
  await page.getByRole("button", { name: "驳回投稿" }).click();
  await expect(page.getByRole("alert")).toHaveText(
    "请填写驳回理由，让投稿人知道需要修改什么。",
  );
  await expect(page.getByRole("article")).toContainText("待审核");
  await page
    .getByRole("textbox", { name: /驳回理由/ })
    .fill("请补充虚构企业的合作需求。");
  await page.getByRole("button", { name: "驳回投稿" }).click();
  await expect(page.getByRole("article")).toContainText("已驳回");
  await page.goto("/#/account");
  await page.getByRole("tab", { name: "我的投稿" }).click();
  const rejectedPost = page
    .getByRole("article")
    .filter({ has: page.getByRole("heading", { name: "演示投稿：需要补充" }) });
  await expect(rejectedPost).toContainText("已驳回");
  await expect(rejectedPost).toContainText("请补充虚构企业的合作需求。");
  await submitPost(page, "演示投稿：完整资料");
  await page.getByRole("link", { name: "前往演示后台审核" }).click();
  await page.getByRole("tab", { name: "内容审核" }).click();
  const pendingPost = page
    .getByRole("article")
    .filter({ has: page.getByRole("heading", { name: "演示投稿：完整资料" }) });
  await pendingPost.getByRole("button", { name: "通过投稿" }).click();
  await expect(pendingPost).toContainText("已通过");
  await page.goto("/#/account");
  await page.getByRole("tab", { name: "我的投稿" }).click();
  await expect(
    page
      .getByRole("article")
      .filter({
        has: page.getByRole("heading", { name: "演示投稿：完整资料" }),
      }),
  ).toContainText("已通过");
});

test("清空必须明确确认，保留记录和确认清空分别生效", async ({ page }) => {
  await activateDemoMember(page);
  await page.goto("/#/admin");
  await page.getByRole("button", { name: "清空本机演示记录" }).click();
  await expect(page.getByRole("dialog")).toBeVisible();
  await page.getByRole("button", { name: "保留记录" }).click();
  await expect(page.getByRole("dialog")).not.toBeVisible();
  await expect(page.getByText("共 1 条", { exact: true })).toBeVisible();
  await page.getByRole("button", { name: "清空本机演示记录" }).click();
  await page.getByRole("button", { name: "确认清空" }).click();
  await expect(page).toHaveURL(/#\/$/);
  await page.goto("/#/account");
  await expect(
    page.getByRole("heading", { name: "还没有开通演示会员" }),
  ).toBeVisible();
  await page.goto("/#/admin");
  await expect(
    page.getByRole("heading", { name: "第一笔演示订单，从会员端开始" }),
  ).toBeVisible();
});

test("权益说明弹窗可关闭且不假装已接入服务", async ({ page }) => {
  await page.goto("/#/services");
  await page.getByRole("button", { name: /翻译服务/ }).click();
  await expect(page.getByRole("dialog")).toContainText("本样稿尚未接入该服务");
  await page.keyboard.press("Escape");
  await expect(page.getByRole("dialog")).not.toBeVisible();
  await expect(page.getByRole("button", { name: /翻译服务/ })).toBeFocused();
});

for (const width of [390, 360]) {
  test(`手机 ${width}px：主要页面不横向溢出，入会及后台操作可触达`, async ({
    page,
  }) => {
    await page.setViewportSize({ width, height: 844 });
    for (const route of [
      "/",
      "/members",
      "/services",
      "/account",
      "/join/star",
      "/join/organization",
    ]) {
      await page.goto(`/#${route}`);
      await expect(page.locator("h1")).toBeVisible();
      await expectNoPageOverflow(page);
    }
    await page.goto("/#/join/basic");
    const fillButton = page.getByRole("button", { name: "填入演示资料" });
    await fillButton.click();
    await page.getByRole("checkbox").check();
    const continueButton = page.getByRole("button", {
      name: "确认信息，下一步",
    });
    await continueButton.scrollIntoViewIfNeeded();
    await expect(continueButton).toBeInViewport();
    await continueButton.click();
    await expectNoPageOverflow(page);
    await page.getByRole("button", { name: "模拟付款成功，开通会员" }).click();
    await expectNoPageOverflow(page);
    await page.getByRole("link", { name: "进入会员中心" }).click();
    await expectNoPageOverflow(page);
    await page.getByRole("tab", { name: "我的订单" }).click();
    await expectNoPageOverflow(page);
    await page.getByRole("tab", { name: "我的投稿" }).click();
    await expectNoPageOverflow(page);
    await page.getByRole("link", { name: "演示后台", exact: true }).click();
    await expectNoPageOverflow(page);
    await page.getByRole("button", { name: "查看演示会员的订单详情" }).click();
    await expectNoPageOverflow(page);
    await page.getByRole("button", { name: "清空本机演示记录" }).click();
    await expect(page.getByRole("dialog")).toBeVisible();
    await expectNoPageOverflow(page);
    await page.getByRole("button", { name: "保留记录" }).click();
  });
}
