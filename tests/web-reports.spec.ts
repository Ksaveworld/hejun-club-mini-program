import {test,expect} from '@playwright/test';
test('visitors can preview ten pages but cannot retrieve the original or private body',async({page,context})=>{
 await page.goto('/hejun-club/#/articles');await page.getByRole('link').filter({hasText:'隔离会员试看报告'}).click();await expect(page.getByText('共 11 页 · 可试看前 10 页',{exact:true})).toBeVisible();
 const href=await page.getByRole('link',{name:'阅读试看版',exact:true}).getAttribute('href');const pdf=await context.request.get(href!);expect(pdf.status()).toBe(200);expect((await pdf.body()).includes(Buffer.from('Isolated page 11'))).toBe(false);
 expect((await context.request.get(href!.replace('/preview','/document'),{headers:{Range:'bytes=0-4'}})).status()).toBe(404);
 await expect(page.getByRole('link',{name:'下载原件'})).toHaveCount(0);await expect(page.getByRole('link',{name:'会员登录阅读全文'})).toBeVisible();
 expect(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth+1)).toBeTruthy();
});
test('imported report can be found and downloaded by staff while remaining private',async({page,context})=>{
 await page.goto('/hejun-club/#/admin');await page.getByRole('textbox',{name:'账号',exact:true}).fill('test_admin');await page.getByLabel('密码',{exact:true}).fill('OnlyInIsolatedTests1');await page.getByRole('button',{name:'登录',exact:true}).click();await page.getByRole('tab',{name:'资讯与知识',exact:true}).click();
 await page.getByRole('searchbox',{name:'搜索标题或文件名'}).fill('隔离PDF');await page.getByRole('button').filter({hasText:'隔离PDF导入报告'}).click();await expect(page.getByRole('region',{name:'报告原件'})).toContainText('1 页');
 const href=await page.getByRole('link',{name:'预览 PDF'}).getAttribute('href');const range=await context.request.get(href!,{headers:{Range:'bytes=0-4'}});expect(range.status()).toBe(206);expect((await range.body()).toString()).toBe('%PDF-');
 const downloadPromise=page.waitForEvent('download');await page.getByRole('link',{name:'下载原件'}).click();const download=await downloadPromise;expect(download.suggestedFilename()).toBe('隔离PDF导入报告.pdf');expect(await download.failure()).toBeNull();
 const publicHref=href!.replace('/admin/articles/','/articles/');expect((await context.request.get(publicHref)).status()).toBe(404);
 await page.getByRole('button',{name:'退出登录',exact:true}).click();await expect(page.getByRole('heading',{name:'登录会员账号',exact:true})).toBeVisible();expect((await context.request.get(href!)).status()).toBe(403);
});
