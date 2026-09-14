import { test, expect, type Page } from '@playwright/test';

test.beforeEach(async ({page})=>{await page.addInitScript(()=>localStorage.setItem('caexpo-ai-20260917-v1','dismissed'));});
const password='OnlyInIsolatedTests1';
const unique=()=>`u_${crypto.randomUUID().replaceAll('-','').slice(0,15)}`;
test('未付费访客分段填写需求问卷，后台导出同一记录且无公开答案接口', async ({ page, browser }) => {
  const schema = (await (await page.request.get('/api/surveys/demand')).json()).survey;
  await page.setViewportSize({width:390,height:844});
  await page.goto('/#/surveys/demand');
  await expect(page.getByRole('heading', { name: schema.title })).toBeVisible();
  for (let section = 1; section <= schema.sections.length; section++) {
    for (const field of schema.fields.filter((f: { section: number; required: boolean }) => f.section === section && f.required)) {
      if (field.type === 'text') await page.getByRole('textbox', { name: field.label, exact: true }).fill(field.id === 'q9' ? 'survey@example.test' : '隔离活动测试');
      else await page.locator('fieldset').filter({ has: page.locator('legend', { hasText: `${field.number}. ` }) }).locator('input').first().check();
    }
    if (section < schema.sections.length) await page.getByRole('button', { name: '下一部分' }).click();
  }
  await page.getByRole('checkbox').check();
  await page.getByRole('button', { name: '提交问卷', exact: true }).click();
  await expect(page.getByRole('heading', { name: '提交成功' })).toBeVisible();
  await page.screenshot({path:'../analysis/mvp-survey-receipt.png',fullPage:true});
  const receipt = (await page.getByText('回执编号：').innerText()).split('：')[1].trim();
  expect((await page.request.get('/api/admin/surveys')).status()).toBe(401);
  expect((await page.request.get('/api/surveys/demand/' + receipt)).status()).not.toBe(200);
  const context = await browser.newContext(); const admin = await context.newPage();
  try {
    await login(admin, 'test_admin', true);
    const exported = await admin.request.get('/api/admin/surveys');
    expect(exported.status()).toBe(200);
    const row = (await exported.json()).submissions.find((r: { id: string }) => r.id === receipt);
    expect(row.answers.q9).toBe('survey@example.test');
    const download = admin.waitForEvent('download');
    await admin.getByRole('button', { name: '导出全部问卷（JSON）' }).click();
    expect((await download).suggestedFilename()).toBe('ai-matchmaking-surveys.json');
  } finally { await context.close(); }
});
async function register(page:Page,username=unique(),path='/#/account?tab=orders',referral='') {
  await page.goto(path);
  await page.getByRole('button',{name:'没有账号，创建内测账号'}).click();
  await page.getByRole('textbox',{name:'账号',exact:true}).fill(username);
  await page.getByLabel('密码',{exact:true}).fill(password);
  if(referral)await page.getByRole('textbox',{name:'推荐码（选填）'}).fill(referral);
  await page.getByRole('checkbox').check();
  await page.getByRole('button',{name:'注册并登录',exact:true}).click();
  await expect(page.getByRole('heading',{name:'我的订单',exact:true})).toBeVisible();
  return username;
}
async function login(page:Page,username:string,admin=false) {
  await page.goto(admin?'/#/admin':'/#/account?tab=orders');
  await page.getByRole('textbox',{name:'账号',exact:true}).fill(username);
  await page.getByLabel('密码',{exact:true}).fill(password);
  await page.getByRole('button',{name:'登录',exact:true}).click();
  await expect(page.getByRole('heading',{name:admin?'运营工作台':'我的订单',exact:true})).toBeVisible();
}
async function apply(page:Page,plan='basic') {
  await page.goto(`/#/join/${plan}`);
  await page.getByRole('textbox',{name:'姓名 / 称呼'}).fill('内测申请人');
  await page.getByRole('textbox',{name:'手机号码'}).fill('13800000000');
  await page.getByRole('textbox',{name:'所在城市'}).fill('上海');
  if(plan==='organization')await page.getByRole('textbox',{name:'机构名称'}).fill('虚构内测机构');
  await page.getByRole('checkbox').check();
  await page.getByRole('button',{name:plan==='organization'?'提交预报名':'保存订单',exact:true}).click();
  await expect(page).toHaveURL(/#\/checkout\/HJ/);
  return page.url().split('/').at(-1)!;
}

test('注册、保存真实订单、取消与重新登录持久化；不提供模拟付款',async({page})=>{
  const username=await register(page);const id=await apply(page);
  await expect(page.getByRole('heading',{name:'待付款',exact:true})).toBeVisible();
  await expect(page.getByText('支付尚未开放',{exact:true})).toBeVisible();
  await expect(page.getByRole('button',{name:/模拟付款/})).toHaveCount(0);
  await page.reload();await expect(page.getByText(id,{exact:true})).toBeVisible();
  await page.goto('/#/account?tab=settings');await page.getByRole('button',{name:'退出登录'}).click();
  await expect(page).toHaveURL(/#\/account$/);
  await login(page,username);
  await expect(page.getByRole('tabpanel')).toContainText(id);
  await page.getByRole('link').filter({hasText:id}).click();
  await page.getByRole('button',{name:'取消订单',exact:true}).click();
  await page.getByRole('button',{name:'保留订单',exact:true}).click();
  await expect(page.getByRole('heading',{name:'待付款',exact:true})).toBeVisible();
  await page.getByRole('button',{name:'取消订单',exact:true}).click();
  await page.getByRole('button',{name:'确认取消订单',exact:true}).click();
  await expect(page.getByRole('heading',{name:'已取消',exact:true})).toBeVisible();
  await page.goto('/#/account');await expect(page.getByText('尚未开通会员',{exact:true})).toBeVisible();
});
test('星级无需预审；重复申请由服务端阻止',async({page})=>{
  await register(page);await apply(page,'star');
  await expect(page.getByRole('heading',{name:'待付款',exact:true})).toBeVisible();
  await expect(page.locator('.checkout-plan .price')).toContainText('3,650');
  await page.goto('/#/join/basic');
  await page.getByRole('textbox',{name:'姓名 / 称呼'}).fill('重复申请');
  await page.getByRole('textbox',{name:'手机号码'}).fill('13800000000');
  await page.getByRole('textbox',{name:'所在城市'}).fill('上海');
  await page.getByRole('checkbox').check();await page.getByRole('button',{name:'保存订单',exact:true}).click();
  await expect(page.getByRole('alert')).toContainText('已有待处理订单');
});
test('机构只预报名，管理员核验后仍待审核且不能付款',async({page,browser})=>{
  await register(page);const id=await apply(page,'organization');
  await expect(page.getByRole('heading',{name:'待资质审核',exact:true})).toBeVisible();
  const context=await browser.newContext();const admin=await context.newPage();
  try{
    await login(admin,'test_admin',true);
    await admin.getByRole('tab',{name:'机构及专业申请',exact:true}).click();
    await admin.getByRole('searchbox').fill(id);
    const card=admin.getByRole('article').filter({hasText:id});
    await expect(card).toContainText('虚构内测机构');
    await card.getByRole('button',{name:'保存核验记录（仍待审核）'}).click();
    await expect(admin.getByRole('alert')).toContainText('审核说明');
    await card.getByRole('textbox',{name:'资质核验 / 驳回说明'}).fill('隔离测试：已核对虚构资质，仅验证审核状态');
    await card.getByRole('button',{name:'保存核验记录（仍待审核）'}).click();
    await expect(card).toContainText('待资质审核');
    await page.getByRole('button',{name:'刷新订单状态'}).click();
    await expect(page.getByRole('heading',{name:'待资质审核',exact:true})).toBeVisible();
    await expect(page.locator('.checkout-plan')).toContainText('暂不收费');
    const payment = await page.request.post(`/api/orders/${id}/payment`, {headers:{'X-Club-Request':'1'},data:{}});
    expect(payment.status()).toBe(409);
    expect(await payment.json()).toMatchObject({error:expect.stringContaining('仅接受预报名')});
    await page.goto('/#/account');await expect(page.getByText('尚未开通会员',{exact:true})).toBeVisible();
  }finally{await context.close();}
});
test('机构驳回理由回到会员端，原申请留档且可重申请',async({page,browser})=>{
  await register(page);const id=await apply(page,'organization');
  const context=await browser.newContext();const admin=await context.newPage();
  try{
    await login(admin,'test_admin',true);await admin.getByRole('searchbox').fill(id);
    const card=admin.getByRole('article').filter({hasText:id});
    await card.getByRole('textbox',{name:'资质核验 / 驳回说明'}).fill('请补充资质联系信息');
    await card.getByRole('button',{name:'驳回申请',exact:true}).click();
    await page.getByRole('button',{name:'刷新订单状态'}).click();
    await expect(page.getByRole('heading',{name:'审核未通过',exact:true})).toBeVisible();
    await expect(page.getByText('请补充资质联系信息',{exact:true})).toBeVisible();
    expect(await apply(page,'organization')).not.toBe(id);
  }finally{await context.close();}
});
test('普通会员不能查看后台和其他会员订单，旧浏览器付费记录不迁入',async({page,browser})=>{
  await register(page);const id=await apply(page);
  const context=await browser.newContext();const other=await context.newPage();
  try{
    await register(other);
    await other.evaluate(()=>localStorage.setItem('china-asean-club-preview-v1',JSON.stringify({version:1,memberOrderId:'DEMO',orders:[{id:'DEMO',status:'paid'}],posts:[]})));
    await other.goto(`/#/checkout/${id}`);await expect(other.getByRole('alert')).toContainText('找不到这笔订单');
    await other.goto('/#/admin');await expect(other.getByRole('heading',{name:'需要管理员权限'})).toBeVisible();
    await other.goto('/#/account');await expect(other.getByText('尚未开通会员',{exact:true})).toBeVisible();
    expect(await other.evaluate(()=>localStorage.getItem('china-asean-club-preview-v1'))).toContain('DEMO');
  }finally{await context.close();}
});
test('推荐链接跨页面保留首次有效来源；空推荐码不会虚构默认归属',async({page})=>{
  await page.goto('/?ref=TESTAA#/');await page.getByRole('navigation',{name:'手机导航'}).getByRole('link',{name:'我的',exact:true}).click();
  await register(page,unique(),'/#/account?tab=orders');
  await page.getByRole('tab',{name:'推荐关系',exact:true}).click();
  await expect(page).toHaveURL(/#\/account\?tab=referral$/);
  await expect(page.locator('#page-title')).toHaveText('推荐关系');
  await expect(page.getByRole('tabpanel')).toContainText('TESTAA');
  await page.goto('/#/join/basic?ref=BADBAD');
  await expect(page.getByRole('textbox',{name:'推荐码',exact:false})).toHaveValue('TESTAA');
  await expect(page.getByRole('textbox',{name:'推荐码',exact:false})).toBeDisabled();
  await apply(page);await expect(page.locator('.order-details')).toContainText('TESTAA');
});
test('无效推荐码给出错误，清空可继续；未提供默认码时来源为空',async({page})=>{
  await page.goto('/#/account?tab=orders');await page.getByRole('button',{name:'没有账号，创建内测账号'}).click();
  await page.getByRole('textbox',{name:'账号',exact:true}).fill(unique());await page.getByLabel('密码',{exact:true}).fill(password);
  await page.getByRole('textbox',{name:'推荐码（选填）'}).fill('BADBAD');await page.getByRole('checkbox').check();
  await page.getByRole('button',{name:'注册并登录'}).click();await expect(page.getByRole('alert')).toContainText('推荐码无效');
  await page.getByRole('textbox',{name:'推荐码（选填）'}).fill('');await page.getByRole('button',{name:'注册并登录'}).click();
  await expect(page.getByRole('heading',{name:'我的订单',exact:true})).toBeVisible();await apply(page);
  await expect(page.locator('.order-details')).toContainText('未指定 · 默认值待配置');
});
test('隔离会员样本验证直接发布与运营下架',async({page,browser})=>{
  await login(page,'test_paid_member');await page.getByRole('tab',{name:'我的投稿',exact:true}).click();
  await expect(page).toHaveURL(/#\/account\?tab=posts$/);
  await expect(page.locator('#page-title')).toHaveText('我的投稿');
  const title=`隔离文字 ${unique()}`;
  await page.getByRole('textbox',{name:'标题',exact:true}).fill(title);await page.getByRole('textbox',{name:'正文',exact:true}).fill('这段文字只在隔离测试数据库验证，不是真实会员付款。');
  await page.getByRole('button',{name:'提交投稿',exact:true}).click();await expect(page.getByRole('status')).toContainText('投稿已保存');
  const context=await browser.newContext();const admin=await context.newPage();
  try{
    await admin.goto('/#/content');await expect(admin.getByRole('heading',{name:title,exact:true})).toHaveCount(0);
    await login(admin,'test_admin',true);await admin.getByRole('tab',{name:'内容审核',exact:true}).click();
    const card=admin.getByRole('article').filter({hasText:title});
    await card.getByRole('textbox',{name:'驳回理由'}).fill('补充信息来源');
    await card.getByRole('button',{name:'下架内容',exact:true}).click();
    await expect(admin.getByRole('status')).toContainText('审核已保存');
    await page.goto('/#/content');await expect(page.getByRole('heading',{name:title,exact:true})).toHaveCount(0);
  }finally{await context.close();}
});

test('交流内容要求登录，未付费注册用户可阅读，退出后不可读取',async({page,browser})=>{
  await login(page,'test_paid_member');
  await page.goto('/#/account?tab=posts');
  const title='注册用户阅读_'+unique();
  await page.getByRole('textbox',{name:'标题',exact:true}).fill(title);
  await page.getByRole('textbox',{name:'正文',exact:true}).fill('隔离测试的已审核交流文字。');
  await page.getByRole('button',{name:'提交投稿',exact:true}).click();
  await expect(page.getByRole('status')).toContainText('投稿已保存');
  const context=await browser.newContext();
  try {
    const reader=await context.newPage();
    await login(reader,'test_admin',true);
    await reader.getByRole('tab',{name:'内容审核',exact:true}).click();
    await expect(reader.getByRole('article').filter({hasText:title})).toContainText('已发布');
    await context.clearCookies();
    await reader.goto('/#/content');
    await expect(reader.getByRole('alert')).toHaveText('请先登录');
    await expect(reader.getByRole('heading',{name:title,exact:true})).toHaveCount(0);
    await reader.getByRole('button',{name:'前往登录',exact:true}).click();
    await expect(reader.getByRole('heading',{name:'登录会员账号',exact:true})).toBeVisible();
    await register(reader);
    await reader.goto('/#/content');
    await expect(reader.getByRole('heading',{name:title,exact:true})).toBeVisible();
    await reader.goto('/#/account?tab=settings');
    await reader.getByRole('button',{name:'退出登录',exact:true}).click();
    await reader.goto('/#/content');
    await expect(reader.getByRole('alert')).toHaveText('请先登录');
    await expect(reader.getByRole('heading',{name:title,exact:true})).toHaveCount(0);
  } finally { await context.close(); }
});
test('开发服务禁止下载数据、管理员凭据和服务端文件',async({request})=>{
  for(const path of ['/work/local-admin.txt','/work/data/club.sqlite','/server/domain.mjs','/scripts/e2e-server.mjs']) {
    const result=await request.get(path);expect(result.status(),path).toBe(403);
  }
});
test('游客从订单、推荐和投稿深链接登录后留在原栏目，设置退出后会话失效',async({page})=>{
  for(const [tab,title] of [['orders','我的订单'],['referral','推荐关系'],['posts','我的投稿']]) {
    await page.goto(`/#/account?tab=${tab}`);
    await expect(page.getByRole('heading',{name:'登录会员账号',exact:true})).toBeVisible();
    await expect(page.getByRole('navigation',{name:'手机导航'})).toHaveCount(0);
    await page.getByRole('textbox',{name:'账号',exact:true}).fill('test_paid_member');
    await page.getByLabel('密码',{exact:true}).fill(password);
    await page.getByRole('button',{name:'登录',exact:true}).click();
    await expect(page).toHaveURL(new RegExp(`#/account\\?tab=${tab}$`));
    await expect(page.locator('#page-title')).toHaveText(title);
    await expect(page.getByRole('tab',{name:title,exact:true})).toHaveAttribute('aria-selected','true');
    if(tab==='posts')await expect(page.getByRole('textbox',{name:'正文',exact:true})).toBeVisible();
    await page.goto('/#/account?tab=settings');
    await page.getByRole('button',{name:'退出登录',exact:true}).click();
    await expect(page).toHaveURL(/#\/account$/);
    await page.goto('/#/account?tab=settings');
    await expect(page.getByRole('heading',{name:'登录会员账号',exact:true})).toBeVisible();
    await expect(page.getByRole('textbox',{name:'账号',exact:true})).toBeVisible();
  }
});
for(const width of [360,390,820,1440])test(`当前设计与功能回归 ${width}px：导航、原版 Logo、服务、方案、表单和后台无溢出`,async({page},testInfo)=>{
  await page.setViewportSize({width,height:844});
  const errors:string[]=[];page.on('pageerror',err=>errors.push(err.message));
  await register(page);
  for(const path of ['/','/members','/services','/join/basic','/account','/account?tab=orders','/services/knowledge','/directory','/admin']) {
    await page.goto(`/#${path}`);await expect(page.locator('#page-title')).toBeVisible();
    if(path==='/')await expect(page.locator('.club-logo img')).toHaveAttribute('src','/images/cabc-official-logo.png');
    if(path==='/admin')await expect(page.locator('.brand img')).toHaveAttribute('src','/images/cabc-official-logo.png');
    await expect.poll(()=>page.evaluate(()=>Array.from(document.images).every(img=>img.complete&&img.naturalWidth>0))).toBe(true);
    expect(await page.evaluate(()=>Math.max(document.documentElement.scrollWidth,document.body.scrollWidth))).toBeLessThanOrEqual(width+1);
    const nav=page.getByRole('navigation',{name:'手机导航'});
    if(['/','/services','/account'].includes(path)) {
      await expect(nav).toBeVisible();
      await expect(nav.getByRole('link')).toHaveCount(3);
      for(const label of ['首页','服务','我的'])await expect(nav.getByRole('link',{name:label,exact:true})).toBeVisible();
    } else await expect(nav).toHaveCount(0);
    if(path==='/join/basic') {
      const button=page.getByRole('button',{name:'保存订单',exact:true});await button.scrollIntoViewIfNeeded();
      expect(await button.evaluate(el=>{const r=el.getBoundingClientRect();return r.bottom<=window.innerHeight&&el.contains(document.elementFromPoint(r.x+r.width/2,r.y+r.height/2));})).toBe(true);
    }
  }
  await page.goto('/#/members');await expect(page.locator('.club-plan')).toHaveCount(3);
  for(const plan of ['basic','star','organization'])await expect(page.locator(`a.club-plan[href="#/join/${plan}"]`)).toBeVisible();
  await page.goto('/#/services');await expect(page.locator('.service-link')).toHaveCount(6);
  await page.getByRole('searchbox',{name:'搜索会员服务',exact:true}).fill('知识');await expect(page.locator('.club-service-results a')).toHaveCount(1);
  await page.locator('.club-service-results').getByRole('link',{name:/跨境知识库/}).click();
  await expect(page).toHaveURL(/#\/services\/knowledge$/);await expect(page.locator('#page-title')).toHaveText('跨境知识库');
  await expect(page.getByRole('heading',{name:'知识资料待上架',exact:true})).toBeVisible();
  await page.getByRole('link',{name:'返回服务大厅',exact:true}).click();await expect(page).toHaveURL(/#\/services$/);
  await expect(page.getByRole('searchbox',{name:'搜索会员服务',exact:true})).toHaveValue('知识');
  await page.getByRole('searchbox',{name:'搜索会员服务',exact:true}).fill('不存在');
  await expect(page.locator('.club-service-results a')).toHaveCount(0);
  await page.getByRole('button',{name:'清空搜索',exact:true}).click();await expect(page.locator('.service-link')).toHaveCount(6);
  await page.goto('/#/directory');await expect(page.getByRole('searchbox')).toBeVisible();await expect(page.getByRole('tab')).toHaveCount(2);await expect(page.locator('.directory-category')).toHaveCount(6);
  await page.getByRole('tab',{name:'会员企业',exact:true}).click();await expect(page.getByRole('heading',{name:'会员企业资料整理中'})).toBeVisible();
  await page.goto('/#/');await page.getByRole('link',{name:/第一次加入，从这里开始/}).click();
  await expect(page).toHaveURL(/#\/guides\/getting-started$/);await expect(page.locator('#page-title')).toHaveText('第一次加入，从这里开始');
  await expect(page.locator('main')).toContainText('先审核资质');
  await page.goto('/#/');
  await page.screenshot({path:testInfo.outputPath(`home-${width}.png`),fullPage:true});
  await page.goto('/#/join/basic');await page.screenshot({path:testInfo.outputPath(`join-${width}.png`),fullPage:true});
  expect(errors).toEqual([]);
});
