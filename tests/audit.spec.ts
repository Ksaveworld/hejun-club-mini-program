import { test, expect, type Page } from '@playwright/test';

const password='OnlyInIsolatedTests1', headers={'X-Club-Request':'1'};
async function login(page:Page) {
  await page.goto('/#/admin'); await page.getByLabel('账号',{exact:true}).fill('test_admin');
  await page.getByLabel('密码',{exact:true}).fill(password); await page.getByRole('button',{name:'登录',exact:true}).click();
  await expect(page.getByRole('heading',{name:'运营工作台',exact:true})).toBeVisible();
}
test('管理员按内容编号追溯创建与发布，清空筛选后翻页读取更早记录',async({page})=>{
  await login(page);let selected:any;
  for(let i=0;i<34;i++) {
    const result=await page.request.post('/api/admin/articles',{headers:{...headers,'Idempotency-Key':crypto.randomUUID()},
      data:{title:'隔离审计-'+i,body:'不在日志下发的正文',category:'news',access:{visibility:'public',planIds:[]}}});
    expect(result.status()).toBe(201);if(i===0)selected=(await result.json()).article;
  }
  await page.request.post('/api/admin/articles/'+selected.id+'/publish',{headers,data:{revision:selected.revision}});
  await page.getByRole('tab',{name:'操作记录',exact:true}).click();
  const area=page.getByRole('region',{name:'操作记录查询'});
  await expect(area.getByRole('article')).toHaveCount(30);
  await page.getByLabel('操作分类',{exact:true}).selectOption('article');
  await page.getByLabel('订单或内容编号',{exact:true}).fill(selected.id);
  await page.getByRole('button',{name:'查询记录',exact:true}).click();
  await expect(area.getByRole('article')).toHaveCount(2);
  await expect(area).toContainText('创建内容草稿');await expect(area).toContainText('发布内容');await expect(area).toContainText('test_admin');
  await expect(area).not.toContainText('不在日志下发的正文');
  await page.getByLabel('订单或内容编号',{exact:true}).fill('不存在');await page.getByRole('button',{name:'查询记录',exact:true}).click();
  await expect(area).toContainText('没有符合条件');
  await page.getByLabel('订单或内容编号',{exact:true}).fill('');await page.getByRole('button',{name:'查询记录',exact:true}).click();
  await expect(area.getByRole('article')).toHaveCount(30);
  await page.getByRole('button',{name:'加载更早记录',exact:true}).click();await expect(area.getByRole('article')).toHaveCount(35);
  await expect(page.getByRole('button',{name:'加载更早记录',exact:true})).toHaveCount(0);
  await page.setViewportSize({width:390,height:844});
  expect(await page.locator('body').evaluate(el=>el.scrollWidth<=innerWidth+1)).toBe(true);
});
test('游客和普通会员拒绝审计接口，管理员退出后查询清空旧记录',async({page,browser})=>{
  const visitor=await browser.newContext();
  try {
    expect((await visitor.request.get('http://127.0.0.1:5188/api/admin/audit')).status()).toBe(401);
    await visitor.request.post('http://127.0.0.1:5188/api/auth/login',{headers,data:{username:'test_paid_member',password}});
    expect((await visitor.request.get('http://127.0.0.1:5188/api/admin/audit')).status()).toBe(403);
    await login(page);await page.getByRole('tab',{name:'操作记录',exact:true}).click();
    await expect(page.getByRole('region',{name:'操作记录查询'}).getByRole('article').first()).toBeVisible();
    await page.request.post('/api/auth/logout',{headers,data:{}});
    await page.getByRole('button',{name:'查询记录',exact:true}).click();
    await expect(page.getByRole('alert')).toContainText('登录状态已变化');
    await expect(page.getByRole('region',{name:'操作记录查询'}).getByRole('article')).toHaveCount(0);
  } finally {await visitor.close();}
});
