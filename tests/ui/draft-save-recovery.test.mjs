import {test,before,after} from 'node:test';
import assert from 'node:assert/strict';
import {mkdir,writeFile} from 'node:fs/promises';
import {spawn,execFileSync} from 'node:child_process';
import {chromium,expect} from '@playwright/test';

// Real React/browser interactions; synthetic HTTP fixtures only, no customer service.
const origin='http://127.0.0.1:51983';
let server,browser;
before(async()=>{
  await mkdir('work',{recursive:true});
  if(process.env.OPS_BASELINE==='1')await writeFile('work/AdminArticles-baseline.tsx',execFileSync('git',['show','0fa4bd9f373770bc7d240887cce63e421b8dd2d7:src/AdminArticles.tsx'],{encoding:'utf8'}).replaceAll("'./","'../src/"),'utf8');
  await writeFile('work/draft-recovery.html','<div id="root"></div><script type="module" src="/work/draft-recovery.tsx"></script>','utf8');
  await writeFile('work/draft-recovery.tsx',"import React from 'react';import{createRoot}from'react-dom/client';import{AdminArticles}from'../src/AdminArticles';createRoot(document.getElementById('root')!).render(<AdminArticles userId=\"fixture-admin\"/>);".replace('../src/AdminArticles',process.env.OPS_BASELINE==='1'?'./AdminArticles-baseline':'../src/AdminArticles'),'utf8');
  server=spawn(process.execPath,['node_modules/vite/bin/vite.js','--config','vite.admin.config.ts','--mode','cloud-ops','--host','127.0.0.1','--port','51983','--strictPort'],{stdio:'ignore'});
  for(let n=0;n<100;n++){try{if((await fetch(origin+'/ops/work/draft-recovery.html')).ok)break;}catch{}if(n===99)throw Error('Local Vite did not start');await new Promise(r=>setTimeout(r,100));}
  browser=await chromium.launch({channel:'msedge',headless:true});
});
after(async()=>{await browser?.close();server?.kill();});
const initialMeta=()=>({displayScope:'info',revision:1,section:'launch',topic:'unclassified',activityGroup:'',originalUrl:'',policyCategory:'',practiceCategory:'',supportCategory:'',isRecap:false});
async function fixture(t,mode,{existing=false}={}){
  const context=await browser.newContext();t.after(()=>context.close());const page=await context.newPage();page.setDefaultTimeout(5000); page.on('pageerror',e=>console.error('BROWSER',e.message));
  const state={items:existing?[{id:'fixture-1',revision:1,status:'draft',title:'原草稿',summary:'',body:'原正文',category:'news',access:{visibility:'public',planIds:[]}}]:[],meta:initialMeta(),creates:0,updates:0,metaWrites:0,keys:[],failed:false,reads:0};
  const receipts=new Map(),metaReceipts=new Map();
  await page.route('**/*',async route=>{
    const req=route.request(),url=new URL(req.url());
    if(url.origin!==origin)return route.abort();
    if(!url.pathname.startsWith('/api/'))return route.continue();
    const path=url.pathname,body=req.postDataJSON(),key=req.headers()['idempotency-key'];
    const send=(data,status=200)=>route.fulfill({status,contentType:'application/json',body:JSON.stringify(data)});
    if(path==='/api/me'){if(state.failNextMe){state.failNextMe=false;return route.abort();}return send({user:{id:mode==='session-change'&&state.failed?'other-admin':'fixture-admin',role:'admin'}});}
    if(path==='/api/admin/articles'&&req.method()==='GET'){
      state.reads++;if(mode==='read-lost'&&state.metaWrites&&!state.failed){state.failed=true;return route.abort();}
      return send({articles:state.items});
    }
    if(path.startsWith('/api/admin/content-meta/')){
      if(req.method()==='GET')return send({metadata:{...state.meta,revision:state.items[0].revision}});
      if(mode==='partial'&&!state.failed){state.failed=true;return send({error:'合成栏目服务失败'},503);}
      if(mode==='meta-invalid'&&!state.failed){state.failed=true;return send({error:'合成链接校验失败'},400);}
      if(metaReceipts.has(key)){assert.deepEqual(body,metaReceipts.get(key));return send({metadata:state.meta});}
      assert.equal(body.revision,state.items[0].revision);metaReceipts.set(key,body);state.metaWrites++;state.items[0].revision++;state.meta={...body,revision:state.items[0].revision};
      if(mode==='meta-lost'&&!state.failed){state.failed=true;return route.abort();}
      return send({metadata:state.meta});
    }
    if(path==='/api/admin/articles'&&req.method()==='POST'){
      state.keys.push(key);
      if(mode==='content-invalid'&&!state.failed){state.failed=true;return send({error:'合成内容校验失败'},400);}
      if(receipts.has(key)){assert.deepEqual(body,receipts.get(key).body);return send({article:state.items[0]});}
      state.creates++;const article={...body,id:'fixture-1',revision:1,status:'draft'};state.items=[article];receipts.set(key,{body,article:structuredClone(article)});
      if(['create-lost','create-conflict','session-change'].includes(mode)&&!state.failed){state.failed=true;if(mode==='create-conflict'){state.items[0].revision++;state.meta.activityGroup='salon';}return route.abort();}
      return send({article});
    }
    if(path==='/api/admin/articles/fixture-1'&&req.method()==='POST'){
      if(mode==='meta-conflict'&&!state.failed){state.failed=true;state.items[0].revision++;state.meta.activityGroup='salon';return route.abort();}
      assert.equal(body.revision,state.items[0].revision);state.updates++;state.items[0]={...state.items[0],...body,revision:body.revision+1};
      if((mode==='update-lost'||mode==='conflict')&&!state.failed){state.failed=true;if(mode==='conflict'){state.items[0].revision++;state.items[0].body='其他管理员的修改';}return route.abort();}
      return send({article:state.items[0]});
    }
    throw Error('Unexpected local fixture route: '+path);
  });
  await page.goto(origin+'/ops/work/draft-recovery.html');await expect(page.getByText(/共 \d+ 条内容/)).toBeVisible();
  if(existing){await page.locator('.article-choice').click();await expect(page.getByLabel('内容标题',{exact:true})).toBeEnabled();}
  await page.getByLabel('内容标题',{exact:true}).fill('恢复验证草稿');await page.getByLabel('内容正文 / 报告说明（发布前必填）',{exact:true}).fill('必须保留的合成正文');
  await page.getByLabel('阅读范围',{exact:true}).selectOption('public');await page.locator('label').filter({hasText:/^展示位置/}).locator('select').selectOption('activity');await page.locator('label').filter({hasText:/^活动展示栏目/}).locator('select').selectOption('expo');
  return {page,state};
}
const save=p=>p.getByRole('button',{name:'保存内容与栏目',exact:true}).click();
async function complete(page,state){
  await expect(page.getByText('内容与栏目已保存并重新核对，尚未发布。',{exact:true})).toBeVisible();
  assert.equal(state.items.length,1);assert.equal(state.meta.activityGroup,'expo');
  await expect(page.getByLabel('内容正文 / 报告说明（发布前必填）',{exact:true})).toHaveValue('必须保留的合成正文');
  await expect(page.getByRole('button',{name:'发布内容',exact:true})).toBeEnabled();
  await page.getByRole('button',{name:'重新载入所选内容',exact:true}).click();await expect(page.locator('label').filter({hasText:/^活动展示栏目/}).locator('select')).toHaveValue('expo');
}
test('normal save and reopen preserves content and placement',async t=>{const{page,state}=await fixture(t,'normal');await save(page);await complete(page,state);assert.equal(state.creates,1);});
for(const mode of ['partial','create-lost','meta-lost','read-lost','update-lost'])test(mode+': same draft recovers without losing input or duplicate writes',async t=>{
  const{page,state}=await fixture(t,mode,{existing:mode==='update-lost'});await save(page);
  await expect(page.getByRole('button',{name:'重试保存草稿',exact:true})).toBeEnabled();
  await expect(page.getByLabel('内容正文 / 报告说明（发布前必填）',{exact:true})).toHaveValue('必须保留的合成正文');
  await expect(page.locator('label').filter({hasText:/^活动展示栏目/}).locator('select')).toHaveValue('expo');
  await expect(page.getByRole('button',{name:'新建内容',exact:true})).toBeDisabled();
  if(state.items.length&&mode!=='create-lost')await expect(page.getByRole('button',{name:'发布内容',exact:true})).toBeDisabled();
  assert.equal(await page.evaluate(()=>window.dispatchEvent(new Event('ops-before-section-change',{cancelable:true}))),false);
  await page.getByRole('button',{name:'刷新内容列表',exact:true}).click();await complete(page,state);
  assert.equal(state.metaWrites,1);assert.equal(state.creates,mode==='update-lost'?0:1);assert.equal(state.updates,mode==='update-lost'?1:0);
  if(mode==='create-lost')assert.equal(new Set(state.keys).size,1);
});
for(const mode of ['content-invalid','meta-invalid'])test(mode+': definite rejection remains editable',async t=>{
  const{page,state}=await fixture(t,mode);await save(page);await expect(page.getByText(/输入已保留，请修改后保存/)).toBeVisible();
  await expect(page.getByLabel('内容标题',{exact:true})).toBeEnabled();await expect(page.locator('label').filter({hasText:/^活动展示栏目/}).locator('select')).toHaveValue('expo');
  await save(page);await complete(page,state);assert.equal(state.creates,1);
});
test('concurrent revision is never overwritten; discard requires confirmation',async t=>{
  const{page,state}=await fixture(t,'conflict',{existing:true});await save(page);await page.getByRole('button',{name:'重试保存草稿',exact:true}).click();
  await expect(page.getByText(/未覆盖最新版本/)).toBeVisible();assert.equal(state.updates,1);assert.equal(state.metaWrites,0);
  page.once('dialog',d=>d.dismiss());await page.getByRole('button',{name:'放弃本次修改并读取最新记录',exact:true}).click();await expect(page.getByLabel('内容正文 / 报告说明（发布前必填）',{exact:true})).toHaveValue('必须保留的合成正文');
  page.once('dialog',d=>d.accept());await page.getByRole('button',{name:'放弃本次修改并读取最新记录',exact:true}).click();await expect(page.getByLabel('内容正文 / 报告说明（发布前必填）',{exact:true})).toHaveValue('其他管理员的修改');assert.equal(state.updates,1);
});
for(const mode of ['create-conflict','meta-conflict'])test(mode+': recovery does not adopt another editors placement revision',async t=>{
  const{page,state}=await fixture(t,mode,{existing:mode==='meta-conflict'});
  if(mode==='meta-conflict'){await page.getByLabel('内容标题',{exact:true}).fill('原草稿');await page.getByLabel('内容正文 / 报告说明（发布前必填）',{exact:true}).fill('原正文');}
  await save(page);await page.getByRole('button',{name:'重试保存草稿',exact:true}).click();await expect(page.getByText(/未覆盖最新版本/)).toBeVisible();
  await page.getByRole('button',{name:'重试保存草稿',exact:true}).click();await expect(page.getByText(/未覆盖最新版本/)).toBeVisible();
  assert.equal(state.metaWrites,0);assert.equal(state.meta.activityGroup,'salon');assert.equal(state.items.length,1);
});
test('rapid repeated submit creates a single draft',async t=>{
  const{page,state}=await fixture(t,'normal');await page.locator('#article-content-form').evaluate(form=>{form.dispatchEvent(new Event('submit',{bubbles:true,cancelable:true}));form.dispatchEvent(new Event('submit',{bubbles:true,cancelable:true}));});await complete(page,state);assert.equal(state.creates,1);assert.equal(state.metaWrites,1);
});
test('identity change clears pending input and prevents replay as another admin',async t=>{
  const{page,state}=await fixture(t,'session-change');await save(page);await page.getByRole('button',{name:'重试保存草稿',exact:true}).click();await expect(page.getByText('登录状态已变化，请重新登录管理后台。',{exact:true})).toBeVisible();await expect(page.getByLabel('内容标题',{exact:true})).toHaveValue('');assert.equal(state.keys.length,1);assert.equal(state.metaWrites,0);
});
for(const action of ['retry','new','switch'])test('preflight failure before business submission: '+action+' never replays old input',async t=>{
  const{page,state}=await fixture(t,'normal',{existing:action==='switch'});state.failNextMe=true;await save(page);
  await expect(page.getByText(/保存前检查失败，尚未提交草稿/)).toBeVisible();
  assert.equal(state.creates,0);assert.equal(state.updates,0);assert.equal(state.metaWrites,0);
  await expect(page.getByLabel('内容标题',{exact:true})).toBeEnabled();
  await expect(page.getByLabel('内容标题',{exact:true})).toHaveValue('恢复验证草稿');
  if(action!=='retry'){
    page.once('dialog',d=>d.accept());
    if(action==='new')await page.getByRole('button',{name:'新建内容',exact:true}).click();else await page.locator('.article-choice').click();
    await expect(page.getByLabel('内容标题',{exact:true})).toBeEnabled();
  }
  await page.getByLabel('内容标题',{exact:true}).fill('检查失败后新输入');
  await page.getByLabel('内容正文 / 报告说明（发布前必填）',{exact:true}).fill('只保存现在这段文字');
  await page.getByLabel('阅读范围',{exact:true}).selectOption('public');await save(page);
  await expect(page.getByText('内容与栏目已保存并重新核对，尚未发布。',{exact:true})).toBeVisible();
  assert.equal(state.items.length,1);assert.equal(state.items[0].title,'检查失败后新输入');assert.equal(state.items[0].body,'只保存现在这段文字');
  assert.equal(state.creates,action==='switch'?0:1);assert.equal(state.updates,action==='switch'?1:0);
});
test('preflight failure during unknown-outcome recovery keeps the original submission locked',async t=>{
  const{page,state}=await fixture(t,'create-lost');await save(page);await expect(page.getByRole('button',{name:'重试保存草稿',exact:true})).toBeEnabled();state.failNextMe=true;
  await page.getByRole('button',{name:'重试保存草稿',exact:true}).click();
  await expect(page.getByRole('button',{name:'重试保存草稿',exact:true})).toBeEnabled();await expect(page.getByRole('button',{name:'新建内容',exact:true})).toBeDisabled();
  await page.getByRole('button',{name:'重试保存草稿',exact:true}).click();await complete(page,state);assert.equal(state.creates,1);assert.equal(new Set(state.keys).size,1);
});
