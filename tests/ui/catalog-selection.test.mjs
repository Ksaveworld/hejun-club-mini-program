import{test,before,after}from'node:test';
import assert from'node:assert/strict';
import{mkdir,writeFile}from'node:fs/promises';
import{spawn,execFileSync}from'node:child_process';
import{chromium,expect}from'@playwright/test';
const origin='http://127.0.0.1:51887';let server,browser;
before(async()=>{
  await mkdir('work',{recursive:true});
  if(process.env.OPS_CATALOG_BASELINE==='1')await writeFile('work/CatalogBaseline.tsx',execFileSync('git',['show','af98cf4d44d15db6d65abd191da6c9067828cbb9:src/AdminArticles.tsx'],{encoding:'utf8'}).replaceAll("'./","'../src/"),'utf8');
  await writeFile('work/catalog.html','<div id="root"></div><script type="module" src="/work/catalog.tsx"></script>','utf8');
  await writeFile('work/catalog.tsx',"import React from'react';import{createRoot}from'react-dom/client';import{AdminArticles}from'../src/AdminArticles';createRoot(document.getElementById('root')!).render(<AdminArticles userId=\"fixture-admin\"/>);".replace('../src/AdminArticles',process.env.OPS_CATALOG_BASELINE==='1'?'./CatalogBaseline':'../src/AdminArticles'),'utf8');
  let log='';server=spawn(process.execPath,['node_modules/vite/bin/vite.js','--config','vite.admin.config.ts','--mode','cloud-ops','--host','127.0.0.1','--port','51887','--strictPort'],{stdio:['ignore','ignore','pipe']});server.stderr.on('data',data=>log+=data);
  for(let n=0;n<150;n++){try{if((await fetch(origin+'/ops/work/catalog.html')).ok)break;}catch{}if(n===149||server.exitCode!==null)throw Error('Local Vite did not start: '+log);await new Promise(r=>setTimeout(r,100));}
  browser=await chromium.launch({channel:'msedge',headless:true});
});
after(async()=>{await browser?.close();server?.kill();});
const id=n=>String(n).padStart(8,'0')+'-aaaa-4aaa-aaaa-aaaaaaaaaaaa';
const title=n=>'合成资料 '+String(n).padStart(2,'0');
const file={name:'selected.pdf',mimeType:'application/pdf',buffer:Buffer.from('%PDF-local selection only')};
async function fixture(t){
  const context=await browser.newContext(),page=await context.newPage();page.setDefaultTimeout(10000);
  const rows=Array.from({length:25},(_,i)=>({id:id(i+1),title:title(i+1),revision:1,status:(i+1)%2===0?'published':'draft',category:'news',summary:'',body:'合成正文 '+(i+1),access:{visibility:'public',planIds:[]},document:(i+1)%3===0?{filename:'file-'+String(i+1).padStart(2,'0')+'.pdf',bytes:100,pages:2,previewPages:2}:null}));
  const state={rows,requests:[],actor:'fixture-admin',failNextMe:false,failList:false,failMeta:false,failAfterMeta:false,actorAfterMeta:false,afterList:null,metaRevision:null,section:'launch',topic:'unclassified',acceptDialogs:false,dialogs:[]};
  page.on('dialog',async dialog=>{state.dialogs.push(dialog.message());await(state.acceptDialogs?dialog.accept():dialog.dismiss());});
  t.after(async()=>{try{assert.ok(state.requests.every(r=>r.method==='GET'),'catalog interactions must never write business records');}finally{await context.close();}});
  await page.route('**/*',async route=>{
    const req=route.request(),url=new URL(req.url());if(url.origin!==origin)return route.abort();if(!url.pathname.startsWith('/api/'))return route.continue();state.requests.push({method:req.method(),path:url.pathname});
    const send=(data,status=200)=>route.fulfill({status,contentType:'application/json',body:JSON.stringify(data)});
    if(req.method()!=='GET')return send({error:'Unexpected write in read-only fixture'},405);
    if(url.pathname==='/api/me'){if(state.failNextMe){state.failNextMe=false;return route.abort();}return send({user:{id:state.actor,role:'admin'}});}
    if(url.pathname==='/api/admin/articles'){if(state.failList)return route.abort();const articles=structuredClone(state.rows);state.afterList?.();state.afterList=null;return send({articles});}
    const meta=/^\/api\/admin\/content-meta\/(.+)$/.exec(url.pathname);if(meta){if(state.failMeta)return route.abort();const row=state.rows.find(r=>r.id===meta[1]);if(!row)return send({error:'不可用'},410);if(state.failAfterMeta)state.failNextMe=true;if(state.actorAfterMeta)state.actor='other-admin';return send({metadata:{revision:state.metaRevision??row.revision,displayScope:'info',section:state.section,topic:state.topic,activityGroup:'',originalUrl:'',policyCategory:'',practiceCategory:'',supportCategory:'',isRecap:false}});}
    throw Error('Unexpected local fixture request '+url.pathname);
  });
  await page.goto(origin+'/ops/work/catalog.html',{timeout:20000});await expect(page.getByText(/共 25 条内容/)).toBeVisible();return{page,state};
}
const choice=(page,n)=>page.locator('.article-choice').filter({hasText:title(n)});
async function pick(page,n=1){await choice(page,n).click();await expect(page.getByLabel('内容标题',{exact:true})).toHaveValue(title(n));await expect(page.getByRole('combobox',{name:'展示位置',exact:true})).toBeEnabled();}
async function refresh(page){await page.getByRole('button',{name:'刷新内容列表',exact:true}).click();}
async function dirty(page){await page.getByLabel('选择 PDF 文件',{exact:true}).setInputFiles(file);await page.getByLabel('内容正文 / 报告说明（发布前必填）',{exact:true}).fill('尚未保存的正文');await page.getByRole('combobox',{name:'展示位置',exact:true}).selectOption('both');await page.getByRole('combobox',{name:'活动展示栏目（必选）',exact:true}).selectOption('salon');}
async function preserved(page){await expect(page.getByLabel('内容标题',{exact:true})).toHaveValue(title(1));await expect(page.getByLabel('内容正文 / 报告说明（发布前必填）',{exact:true})).toHaveValue('尚未保存的正文');await expect(page.getByRole('combobox',{name:'展示位置',exact:true})).toHaveValue('both');assert.equal(await page.getByLabel('选择 PDF 文件',{exact:true}).evaluate(input=>input.files[0]?.name),'selected.pdf');}
async function locked(page){for(const name of ['保存内容与栏目','发布内容','删除草稿'])await expect(page.getByRole('button',{name,exact:true})).toBeDisabled();await expect(page.getByRole('button',{name:'刷新内容列表',exact:true})).toBeEnabled();}

test('search combined filters and pages have matching rows and counts',async t=>{
  const{page,state}=await fixture(t);await expect(page.locator('.article-choice')).toHaveCount(10);await expect(page.getByText('共 25 条 · 第 1 / 3 页',{exact:true})).toBeVisible();await page.getByRole('button',{name:'下一页',exact:true}).click();await expect(choice(page,11)).toBeVisible();await page.getByLabel('跳至页码',{exact:true}).selectOption('3');await expect(page.locator('.article-choice')).toHaveCount(5);
  await page.getByLabel('筛选状态',{exact:true}).selectOption('published');await page.getByLabel('筛选文件',{exact:true}).selectOption('pdf');await expect(page.locator('.article-choice')).toHaveCount(4);await expect(page.getByText('共 4 条 · 第 1 / 1 页',{exact:true})).toBeVisible();await expect(choice(page,6)).toBeVisible();await expect(choice(page,24)).toBeVisible();await page.getByRole('searchbox').fill('file-12.pdf');await expect(page.locator('.article-choice')).toHaveCount(1);await expect(choice(page,12)).toBeVisible();await page.getByRole('searchbox').fill('没有此合成资料');await expect(page.locator('.article-choice')).toHaveCount(0);await expect(page.getByText('共 0 条 · 第 1 / 1 页',{exact:true})).toBeVisible();assert.equal(state.dialogs.length,0);
});
test('filtering and paging keep body placement and selected file with clear editor identity',async t=>{
  const{page,state}=await fixture(t);await pick(page);await dirty(page);await page.getByRole('button',{name:'下一页',exact:true}).click();await preserved(page);await expect(page.getByText(/当前编辑：合成资料 01.*不在当前列表页/)).toBeVisible();await page.getByRole('searchbox').fill(title(20));await preserved(page);await expect(page.getByText(/当前编辑：合成资料 01.*不在当前筛选结果/)).toBeVisible();assert.equal(state.dialogs.length,0);
});
test('cancel selecting another record keeps inputs; accept switches only to chosen target',async t=>{
  const{page,state}=await fixture(t);await pick(page);await dirty(page);await choice(page,3).click();await preserved(page);assert.equal(state.dialogs.length,1);state.acceptDialogs=true;await choice(page,3).click();await expect(page.getByLabel('内容标题',{exact:true})).toHaveValue(title(3));await expect(page.getByText(/已选择，尚未上传/)).toHaveCount(0);
});
test('new content asks before discarding inputs; cancelling keeps same draft',async t=>{
  const{page,state}=await fixture(t);await pick(page);await dirty(page);await page.getByRole('button',{name:'新建内容',exact:true}).click();await preserved(page);state.acceptDialogs=true;await page.getByRole('button',{name:'新建内容',exact:true}).click();await expect(page.getByLabel('内容标题',{exact:true})).toHaveValue('');await expect(page.getByText(/已选择，尚未上传/)).toHaveCount(0);
});
test('cancel refresh sends no reads and keeps all unsaved input',async t=>{
  const{page,state}=await fixture(t);await pick(page);await dirty(page);const count=state.requests.length;state.rows=state.rows.filter(r=>r.id!==id(1));await refresh(page);await preserved(page);assert.equal(state.requests.length,count);
});
test('unavailable selection after full refresh is cleared with confirmation controls',async t=>{
  const{page,state}=await fixture(t);await pick(page);await page.getByRole('button',{name:'发布内容',exact:true}).click();state.rows=state.rows.filter(r=>r.id!==id(1));await refresh(page);await expect(page.getByLabel('内容标题',{exact:true})).toHaveValue('');await expect(page.getByText(/^当前编辑记录已不在完整内容列表中/)).toBeVisible();for(const name of ['发布内容','删除草稿','确认发布'])await expect(page.getByRole('button',{name,exact:true})).toHaveCount(0);await expect(page.getByText(/共 24 条内容/)).toBeVisible();
});
test('refresh updated record adopts content status revision and matching metadata together',async t=>{
  const{page,state}=await fixture(t);await pick(page);Object.assign(state.rows[0],{body:'其他编辑者的新正文',revision:2,status:'published'});state.section='landing';state.topic='policy';await refresh(page);await expect(page.getByLabel('内容正文 / 报告说明（发布前必填）',{exact:true})).toHaveValue('其他编辑者的新正文');await expect(page.getByRole('combobox',{name:'资讯展示栏目（与小程序对应）',exact:true})).toHaveValue('policy');await expect(page.getByText(/已发布 · 版本 2/)).toBeVisible();await expect(page.getByRole('button',{name:'撤下内容',exact:true})).toBeEnabled();assert.deepEqual(state.requests.slice(-4).map(r=>r.path),['/api/me','/api/admin/articles','/api/admin/content-meta/'+id(1),'/api/me']);
});
test('list failure keeps visible record locked until successful refresh',async t=>{
  const{page,state}=await fixture(t);await pick(page);state.failList=true;await refresh(page);await expect(page.getByRole('alert').first()).toBeVisible();await locked(page);await expect(page.getByLabel('内容标题',{exact:true})).toHaveValue(title(1));await expect(page.getByText(/共 25 条内容/)).toBeVisible();state.failList=false;await refresh(page);await expect(page.getByRole('button',{name:'发布内容',exact:true})).toBeEnabled();
});
test('metadata read failure does not partially adopt new list or content',async t=>{
  const{page,state}=await fixture(t);await pick(page);state.rows.pop();state.rows[0].revision=2;state.rows[0].body='待确认的新内容';state.failMeta=true;await refresh(page);await locked(page);await expect(page.getByLabel('内容正文 / 报告说明（发布前必填）',{exact:true})).toHaveValue('合成正文 1');await expect(page.getByText(/共 25 条内容/)).toBeVisible();state.failMeta=false;await refresh(page);await expect(page.getByText(/共 24 条内容/)).toBeVisible();await expect(page.getByLabel('内容正文 / 报告说明（发布前必填）',{exact:true})).toHaveValue('待确认的新内容');
});
test('initial identity read failure makes no catalog read and keeps old writes locked',async t=>{
  const{page,state}=await fixture(t);await pick(page);const count=state.requests.filter(r=>r.path==='/api/admin/articles').length;state.failNextMe=true;await refresh(page);await locked(page);assert.equal(state.requests.filter(r=>r.path==='/api/admin/articles').length,count);await refresh(page);await expect(page.getByRole('button',{name:'发布内容',exact:true})).toBeEnabled();
});
test('final identity read failure never unlocks refreshed content',async t=>{
  const{page,state}=await fixture(t);await pick(page);state.rows[0].revision=2;state.rows[0].body='身份待确认的新内容';state.failAfterMeta=true;await refresh(page);await locked(page);await expect(page.getByLabel('内容正文 / 报告说明（发布前必填）',{exact:true})).toHaveValue('合成正文 1');state.failAfterMeta=false;await refresh(page);await expect(page.getByLabel('内容正文 / 报告说明（发布前必填）',{exact:true})).toHaveValue('身份待确认的新内容');await expect(page.getByRole('button',{name:'发布内容',exact:true})).toBeEnabled();
});
test('mixed revision refresh refuses content and metadata combination',async t=>{
  const{page,state}=await fixture(t);await pick(page);state.afterList=()=>{state.rows[0].revision=2;state.rows[0].body='列表读取后的并发修改';};await refresh(page);await expect(page.getByText(/内容与栏目版本不一致/)).toBeVisible();await locked(page);await expect(page.getByLabel('内容正文 / 报告说明（发布前必填）',{exact:true})).toHaveValue('合成正文 1');await refresh(page);await expect(page.getByLabel('内容正文 / 报告说明（发布前必填）',{exact:true})).toHaveValue('列表读取后的并发修改');
});
test('choosing stale cached record does not unlock a different metadata revision',async t=>{
  const{page,state}=await fixture(t);state.rows[0].revision=2;await choice(page,1).click();await expect(page.getByText(/内容与栏目版本不一致/)).toBeVisible();await locked(page);await refresh(page);await expect(page.getByRole('button',{name:'发布内容',exact:true})).toBeEnabled();await expect(page.getByText(/草稿 · 版本 2/)).toBeVisible();
});
test('identity changes during metadata read: clear old record and inputs',async t=>{
  const{page,state}=await fixture(t);await pick(page);state.actorAfterMeta=true;await refresh(page);await expect(page.getByText('登录状态已变化，请重新登录管理后台。',{exact:true})).toBeVisible();await expect(page.getByLabel('内容标题',{exact:true})).toHaveValue('');await expect(page.locator('.article-choice')).toHaveCount(0);await expect(page.getByRole('button',{name:'发布内容',exact:true})).toHaveCount(0);
});
test('record outside filter remains selected after full-list refresh',async t=>{
  const{page}=await fixture(t);await pick(page);await page.getByRole('searchbox').fill(title(20));await refresh(page);await expect(page.getByLabel('内容标题',{exact:true})).toHaveValue(title(1));await expect(page.getByText(/当前编辑：合成资料 01.*不在当前筛选结果/)).toBeVisible();await expect(page.getByRole('button',{name:'发布内容',exact:true})).toBeEnabled();
});
test('confirmed refresh of unsaved new draft clears only local input',async t=>{
  const{page,state}=await fixture(t);await page.getByLabel('内容标题',{exact:true}).fill('尚未创建的新草稿');state.acceptDialogs=true;await refresh(page);await expect(page.getByLabel('内容标题',{exact:true})).toHaveValue('');await expect(page.getByText(/共 25 条内容/)).toBeVisible();
});
test('confirmed full refresh of missing selected record discards file and unsaved fields',async t=>{
  const{page,state}=await fixture(t);await pick(page);await dirty(page);state.rows=state.rows.filter(r=>r.id!==id(1));state.acceptDialogs=true;await refresh(page);await expect(page.getByLabel('内容标题',{exact:true})).toHaveValue('');await expect(page.getByText(/已选择，尚未上传/)).toHaveCount(0);await expect(page.getByText(/^当前编辑记录已不在完整内容列表中/)).toBeVisible();
});
test('confirmed same-revision refresh and reselect clear DOM file and allow same-file selection',async t=>{
  const{page,state}=await fixture(t);await pick(page);const input=page.getByLabel('选择 PDF 文件',{exact:true});await input.setInputFiles(file);state.acceptDialogs=true;await refresh(page);await expect(input).toHaveValue('');assert.equal(await input.evaluate(el=>el.files.length),0);await expect(page.getByRole('button',{name:'上传并生成试看',exact:true})).toBeDisabled();await input.setInputFiles(file);await expect(page.getByRole('button',{name:'上传并生成试看',exact:true})).toBeEnabled();await choice(page,1).click();await expect(input).toHaveValue('');await input.setInputFiles(file);await expect(page.getByRole('button',{name:'上传并生成试看',exact:true})).toBeEnabled();
});
test('full catalog shrink clamps current page without switching editor to visible record',async t=>{
  const{page,state}=await fixture(t);await pick(page);await page.getByLabel('跳至页码',{exact:true}).selectOption('3');state.rows=state.rows.slice(0,12);await refresh(page);await expect(page.getByText('共 12 条 · 第 2 / 2 页',{exact:true})).toBeVisible();await expect(page.getByLabel('跳至页码',{exact:true})).toHaveValue('2');await expect(page.locator('.article-choice')).toHaveCount(2);await expect(page.getByLabel('内容标题',{exact:true})).toHaveValue(title(1));await expect(page.getByText(/当前编辑：合成资料 01.*不在当前列表页/)).toBeVisible();
});
