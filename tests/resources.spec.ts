import { test, expect, type Page } from '@playwright/test';

const password = 'OnlyInIsolatedTests1';
const title = () => '隔离服务-' + crypto.randomUUID().slice(0, 8);
async function login(page: Page, username = 'test_admin') {
  await page.goto('/#/admin');
  await page.getByRole('textbox', { name: '账号', exact: true }).fill(username);
  await page.getByLabel('密码', { exact: true }).fill(password);
  await page.getByRole('button', { name: '登录', exact: true }).click();
  await page.getByRole('tab', { name: '服务资源', exact: true }).click();
  await expect(page.getByText('正在读取服务；若读取失败，请刷新重试。')).toHaveCount(0);
}
async function draft(page: Page, name: string, visibility = 'public') {
  await page.getByLabel('服务标题', { exact: true }).fill(name);
  await page.getByLabel('服务说明', { exact: true }).fill('隔离正文。\n<b>这仍是普通文字</b>');
  await page.getByLabel('使用入口', {exact:true}).selectOption('miniProgram');
  await page.getByLabel('目标小程序 AppID', {exact:true}).fill('wx0000000000000001');
  await page.getByLabel('小程序页面路径', {exact:true}).fill('pages/course/index?id=fixture');
  await page.getByLabel('使用范围', { exact: true }).selectOption(visibility);
  if (visibility === 'plans') await page.getByLabel('基础会员', { exact: true }).check();
  await page.getByRole('button', { name: '保存草稿', exact: true }).click();
  await expect(page.getByRole('status')).toContainText('草稿已保存');
  return (await (await page.request.get('/api/admin/resources')).json()).resources.find((a: {title:string}) => a.title === name);
}
async function publish(page: Page) {
  await page.getByRole('button', { name: '发布服务', exact: true }).click();
  await expect(page.getByRole('group', { name: '确认服务操作' })).toBeVisible();
  await page.getByRole('button', { name: '确认发布', exact: true }).click();
  await expect(page.getByRole('status')).toContainText('已发布');
}

test('运营保存草稿、核对公开范围、发布、撤下、修改再发布，读者权限随状态变化', async ({page,browser}) => {
  await login(page); const name = title();
  const resource = await draft(page, name, 'unconfigured');
  await expect(page.getByRole('button', {name:'发布服务',exact:true})).toBeDisabled();
  const visitor = await browser.newContext();
  try {
    const read = () => visitor.request.get('http://127.0.0.1:5188/api/resources/' + resource.id);
    expect((await read()).status()).toBe(404);
    await page.getByLabel('使用范围', {exact:true}).selectOption('public');
    await page.getByRole('button', {name:'保存草稿',exact:true}).click();
    await expect(page.getByRole('status')).toContainText('草稿已保存');
    await publish(page); expect((await read()).status()).toBe(200);
    await expect(page.getByLabel('服务说明', {exact:true})).toBeDisabled();
    await page.getByRole('button', {name:'撤下服务',exact:true}).click();
    await page.getByRole('button', {name:'确认撤下',exact:true}).click();
    await expect(page.getByRole('status')).toContainText('已撤下'); expect((await read()).status()).toBe(404);
    await page.getByLabel('服务说明', {exact:true}).fill('更新的正文');
    await expect(page.getByRole('button', {name:'发布服务',exact:true})).toBeDisabled();
    await page.getByRole('button', {name:'保存草稿',exact:true}).click();
    await expect(page.getByRole('status')).toContainText('草稿已保存'); await publish(page);
    expect((await (await read()).json()).resource.body).toBe('更新的正文');
    await page.reload(); await page.getByRole('tab',{name:'服务资源',exact:true}).click();
    await expect(page.getByRole('button').filter({hasText:name})).toContainText('已发布');
  } finally { await visitor.close(); }
});

test('指定档位发布在窄屏可操作，游客拒绝且有效会员通过相同使用接口', async ({page,browser}) => {
  await page.setViewportSize({width:390,height:844}); await login(page);
  const resource = await draft(page, title(), 'plans'); await publish(page);
  const visitor = await browser.newContext();
  try {
    const url = 'http://127.0.0.1:5188/api/resources/' + resource.id;
    expect((await visitor.request.get(url)).status()).toBe(404);
    await visitor.request.post('http://127.0.0.1:5188/api/auth/login', {data:{username:'test_paid_member',password},headers:{'X-Club-Request':'1'}});
    expect((await visitor.request.get(url)).status()).toBe(200);
    const body = await page.locator('body').evaluate(el => ({width:el.scrollWidth, viewport:innerWidth}));
    expect(body.width).toBeLessThanOrEqual(body.viewport + 1);
  } finally { await visitor.close(); }
});

test('另一编辑更新后，旧版本保存失败并可刷新载入，保留未保存修改供核对', async ({page}) => {
  await login(page); const resource = await draft(page, title());
  const changed = await page.request.post('/api/admin/resources/' + resource.id, {data:{...resource,body:'另一编辑的正文'},headers:{'X-Club-Request':'1'}});
  expect(changed.status()).toBe(200);
  await page.getByLabel('服务说明',{exact:true}).fill('当前编辑的旧版本');
  await page.getByRole('button',{name:'保存草稿',exact:true}).click();
  await expect(page.getByRole('alert')).toContainText('服务已变化');
  await expect(page.getByLabel('服务说明',{exact:true})).toHaveValue('当前编辑的旧版本');
  await page.getByRole('button',{name:'刷新服务列表',exact:true}).click();
  await expect(page.getByRole('button',{name:'刷新服务列表',exact:true})).toBeEnabled();
  page.once('dialog',dialog=>dialog.accept());
  await page.getByRole('button',{name:'重新载入所选服务',exact:true}).click();
  await expect(page.getByLabel('服务说明',{exact:true})).toHaveValue('另一编辑的正文');
});

test('创建已保存但响应丢失时原文和提交编号保留，重试只创建一篇', async ({page}) => {
  await login(page); const name = title();
  await page.route('**/api/admin/resources', async route => {
    if (route.request().method() !== 'POST') return route.continue();
    await route.fetch(); await route.abort('failed'); await page.unroute('**/api/admin/resources');
  });
  await page.getByLabel('服务标题',{exact:true}).fill(name);
  await page.getByLabel('服务说明',{exact:true}).fill('保持原文重试');
  await page.getByRole('button',{name:'保存草稿',exact:true}).click();
  await expect(page.getByRole('button',{name:'重试保存草稿',exact:true})).toBeVisible();
  await expect(page.getByLabel('服务说明',{exact:true})).toBeDisabled();
  await page.getByRole('button',{name:'重试保存草稿',exact:true}).click();
  await expect(page.getByRole('status')).toContainText('草稿已保存');
  const items = (await (await page.request.get('/api/admin/resources')).json()).resources;
  expect(items.filter((a:{title:string})=>a.title===name)).toHaveLength(1);
});

test('后台会话失效后再次操作先清除正文，不发送服务修改', async ({page}) => {
  await login(page); await draft(page, title());
  await page.request.post('/api/auth/logout', {data:{},headers:{'X-Club-Request':'1'}});
  let writes = 0;
  page.on('request', request => { if(request.method()==='POST' && request.url().includes('/admin/resources')) writes++; });
  await page.getByRole('button',{name:'保存草稿',exact:true}).click();
  await expect(page.getByRole('alert')).toContainText('登录状态已变化');
  await expect(page.getByLabel('服务说明',{exact:true})).toHaveValue(''); expect(writes).toBe(0);
});

test('入口参数错误可直接修正再保存，服务变更可在操作记录中按分类查询',async ({page})=>{
 await login(page);const name=title();
 await page.getByLabel('服务标题',{exact:true}).fill(name);
 await page.getByLabel('使用入口',{exact:true}).selectOption('miniProgram');
 await page.getByLabel('目标小程序 AppID',{exact:true}).fill('wx0000000000000001');
 await page.getByLabel('小程序页面路径',{exact:true}).fill('https://invalid.example');
 await page.getByRole('button',{name:'保存草稿',exact:true}).click();
 await expect(page.getByRole('alert')).toContainText('小程序内部页面路径');
 await expect(page.getByLabel('小程序页面路径',{exact:true})).toBeEnabled();
 await page.getByLabel('小程序页面路径',{exact:true}).fill('pages/course/index');
 await page.getByRole('button',{name:'保存草稿',exact:true}).click();
 await expect(page.getByRole('status')).toContainText('草稿已保存');
 const items=(await (await page.request.get('/api/admin/resources')).json()).resources;
 const item=items.find((r:{title:string})=>r.title===name);expect(item).toBeTruthy();
 const audit=(await (await page.request.get('/api/admin/audit?group=resource&target='+item.id)).json()).records;
 expect(audit).toHaveLength(1);expect(audit[0].label).toBe('创建服务草稿');expect(audit[0].revision).toBe(1);
 await page.getByRole('tab',{name:'操作记录',exact:true}).click();
 await expect(page.locator('option[value="resource"]')).toHaveText('服务资源');
});
