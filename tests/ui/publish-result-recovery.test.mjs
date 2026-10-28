import {test,before,after} from 'node:test';
import assert from 'node:assert/strict';
import {mkdir,writeFile} from 'node:fs/promises';
import {spawn,execFileSync} from 'node:child_process';
import {chromium,expect} from '@playwright/test';
const origin='http://127.0.0.1:51984';let server,browser;
before(async()=>{
  await mkdir('work',{recursive:true});
  if(process.env.OPS_TRANSITION_BASELINE==='1')await writeFile('work/TransitionBaseline.tsx',execFileSync('git',['show','259c8efbf5eb97f067569b7f877e3d4c220daa73:src/AdminArticles.tsx'],{encoding:'utf8'}).replaceAll("'./","'../src/"),'utf8');
  await writeFile('work/transition.html','<div id="root"></div><script type="module" src="/work/transition.tsx"></script>','utf8');
  await writeFile('work/transition.tsx',"import React from 'react';import{createRoot}from'react-dom/client';import{AdminArticles}from'../src/AdminArticles';createRoot(document.getElementById('root')!).render(<AdminArticles userId=\"fixture-admin\"/>);".replace('../src/AdminArticles',process.env.OPS_TRANSITION_BASELINE==='1'?'./TransitionBaseline':'../src/AdminArticles'),'utf8');
  server=spawn(process.execPath,['node_modules/vite/bin/vite.js','--config','vite.admin.config.ts','--mode','cloud-ops','--host','127.0.0.1','--port','51984','--strictPort'],{stdio:'ignore'});
  for(let n=0;n<100;n++){try{if((await fetch(origin+'/ops/work/transition.html')).ok)break;}catch{}if(n===99)throw Error('Local Vite did not start');await new Promise(r=>setTimeout(r,100));}
  browser=await chromium.launch({channel:'msedge',headless:true});
});
after(async()=>{await browser?.close();server?.kill();});
const label=action=>action==='publish'?'发布':'撤下';
async function fixture(t,action,mode='normal'){
  const context=await browser.newContext();t.after(()=>context.close());const page=await context.newPage();page.setDefaultTimeout(5000);
  const state={article:{id:'synthetic-1',revision:1,status:action==='publish'?'draft':'published',title:'合成发布验收',summary:'',body:'仅本地虚构正文',category:'news',access:{visibility:'public',planIds:[]}},attempts:0,writes:0,requests:[],failNextMe:false,failRead:false,failMeta:false,actor:'fixture-admin',removed:false,changeDuringRead:false};
  await page.route('**/*',async route=>{
    const req=route.request(),url=new URL(req.url());if(url.origin!==origin)return route.abort();if(!url.pathname.startsWith('/api/'))return route.continue();
    const send=(data,status=200)=>route.fulfill({status,contentType:'application/json',body:JSON.stringify(data)});
    if(url.pathname==='/api/me'){if(state.failNextMe){state.failNextMe=false;return route.abort();}return send({user:{id:state.actor,role:'admin'}});}
    if(url.pathname==='/api/admin/articles'&&req.method()==='GET'){
      if(state.failRead)return route.abort();const data=structuredClone(state.article);if(state.changeDuringRead){state.article.revision++;state.changeDuringRead=false;}return send({articles:state.removed?[]:[data]});
    }
    if(url.pathname==='/api/admin/content-meta/synthetic-1'&&req.method()==='GET'){
      if(state.failMeta)return route.abort();return send({metadata:{revision:state.article.revision,displayScope:'info',section:'launch',topic:'unclassified',activityGroup:'',originalUrl:'',policyCategory:'',practiceCategory:'',supportCategory:'',isRecap:false}});
    }
    if(/^\/api\/admin\/articles\/synthetic-1\/(publish|unpublish)$/.test(url.pathname)&&req.method()==='POST'){
      state.attempts++;state.requests.push({action:url.pathname.split('/').at(-1),...req.postDataJSON()});
      if(mode==='drop'&&state.attempts===1)return route.abort();
      if(mode==='conflict'&&state.attempts===1){state.article.revision++;state.article.body='其他编辑者的正文';return send({error:'内容版本冲突'},409);}
      if(mode==='reject'&&state.attempts===1)return send({error:'合成明确拒绝'},403);
      if(req.postDataJSON().revision!==state.article.revision)return send({error:'版本冲突'},409);
      state.writes++;state.article.status=url.pathname.endsWith('/publish')?'published':'draft';state.article.revision++;
      if(mode==='identity')state.actor='other-admin';
      if(['lost','read-fail','meta-fail'].includes(mode)&&state.attempts===1){state.failRead=mode==='read-fail';state.failMeta=mode==='meta-fail';return route.abort();}
      return send({article:state.article});
    }
    throw Error('Unexpected fixture route '+req.method()+' '+url.pathname);
  });
  await page.goto(origin+'/ops/work/transition.html');await expect(page.getByText(/共 1 条内容/)).toBeVisible();await page.locator('.article-choice').click();await expect(page.getByRole('button',{name:label(action)+'内容',exact:true})).toBeEnabled();return{page,state};
}
async function confirmAction(page,action){await page.getByRole('button',{name:label(action)+'内容',exact:true}).click();await page.getByRole('button',{name:'确认'+label(action),exact:true}).click();}
async function pending(page){await expect(page.getByRole('button',{name:'读取当前发布状态',exact:true})).toBeEnabled();await expect(page.getByRole('button',{name:'新建内容',exact:true})).toBeDisabled();assert.equal(await page.evaluate(()=>window.dispatchEvent(new Event('ops-before-section-change',{cancelable:true}))),false);}
async function recovered(page,state,status,attempts=1){await expect(page.getByText(new RegExp('^已读取当前状态：'+(status==='published'?'已发布':'草稿')))).toBeVisible();assert.equal(state.attempts,attempts);await expect(page.getByRole('button',{name:'读取当前发布状态',exact:true})).toHaveCount(0);await expect(page.getByRole('button',{name:status==='published'?'撤下内容':'发布内容',exact:true})).toBeEnabled();}

for(const action of ['publish','unpublish']){
  const desired=action==='publish'?'published':'draft',original=action==='publish'?'draft':'published';
  test(action+' normal response and reopen',async t=>{const{page,state}=await fixture(t,action);await confirmAction(page,action);await expect(page.getByText(action==='publish'?'已发布，符合阅读范围的用户刷新后可见。':'已撤下，用户再次读取时将无法访问。',{exact:true})).toBeVisible();await page.getByRole('button',{name:'刷新内容列表',exact:true}).click();await expect(page.getByRole('button',{name:action==='publish'?'撤下内容':'发布内容',exact:true})).toBeEnabled();assert.equal(state.writes,1);});
  test(action+' initial identity preflight failure sends no action',async t=>{const{page,state}=await fixture(t,action);state.failNextMe=true;await confirmAction(page,action);await expect(page.getByText(/前身份检查失败，尚未提交操作/)).toBeVisible();assert.equal(state.attempts,0);await confirmAction(page,action);await expect(page.getByRole('button',{name:action==='publish'?'撤下内容':'发布内容',exact:true})).toBeEnabled();assert.equal(state.writes,1);});
  test(action+' executed but response lost: refresh only reads',async t=>{const{page,state}=await fixture(t,action,'lost');await confirmAction(page,action);await pending(page);await expect(page.getByText(/结果尚未确认，不能据此认定操作未执行/)).toBeVisible();await page.getByRole('button',{name:'刷新内容列表',exact:true}).click();await recovered(page,state,desired);assert.equal(state.writes,1);});
  test(action+' request never arrived: read then require new confirmation',async t=>{const{page,state}=await fixture(t,action,'drop');await confirmAction(page,action);await pending(page);await page.getByRole('button',{name:'读取当前发布状态',exact:true}).click();await recovered(page,state,original);assert.equal(state.writes,0);await confirmAction(page,action);await expect(page.getByRole('button',{name:action==='publish'?'撤下内容':'发布内容',exact:true})).toBeEnabled();assert.equal(state.attempts,2);assert.equal(state.writes,1);});
  for(const mode of ['read-fail','meta-fail'])test(action+' '+mode+' keeps unknown state until complete reread',async t=>{const{page,state}=await fixture(t,action,mode);await confirmAction(page,action);await pending(page);await page.getByRole('button',{name:'读取当前发布状态',exact:true}).click();await pending(page);assert.equal(state.attempts,1);state.failRead=false;state.failMeta=false;await page.getByRole('button',{name:'重新载入所选内容',exact:true}).click();await recovered(page,state,desired);});
  test(action+' revision conflict reads latest without replay',async t=>{const{page,state}=await fixture(t,action,'conflict');await confirmAction(page,action);await pending(page);await expect(page.getByText(/服务端已拒绝本次/)).toBeVisible();await page.getByRole('button',{name:'读取当前发布状态',exact:true}).click();await recovered(page,state,original);assert.equal(state.writes,0);await expect(page.getByLabel('内容正文 / 报告说明（发布前必填）',{exact:true})).toHaveValue('其他编辑者的正文');});
  test(action+' other editor reverses outcome: never auto-repeat action',async t=>{const{page,state}=await fixture(t,action,'lost');await confirmAction(page,action);await pending(page);state.article.status=original;state.article.revision++;await page.getByRole('button',{name:'读取当前发布状态',exact:true}).click();await recovered(page,state,original);assert.equal(state.writes,1);assert.equal(state.article.revision,3);});
  test(action+' identity changes after response: clear controls and never replay',async t=>{const{page,state}=await fixture(t,action,'identity');await confirmAction(page,action);await expect(page.getByText('登录状态已变化，请重新登录管理后台。',{exact:true})).toBeVisible();await expect(page.getByLabel('内容标题',{exact:true})).toHaveValue('');await expect(page.getByRole('button',{name:'读取当前发布状态',exact:true})).toHaveCount(0);assert.equal(state.attempts,1);});
  test(action+' rapid double confirmation issues one action',async t=>{const{page,state}=await fixture(t,action);await page.getByRole('button',{name:label(action)+'内容',exact:true}).click();await page.getByRole('button',{name:'确认'+label(action),exact:true}).evaluate(button=>{button.click();button.click();});await expect(page.getByRole('button',{name:action==='publish'?'撤下内容':'发布内容',exact:true})).toBeEnabled();assert.equal(state.attempts,1);});
}
test('identity check fails during recovery: keep unknown state',async t=>{const{page,state}=await fixture(t,'publish','lost');await confirmAction(page,'publish');await pending(page);state.failNextMe=true;await page.getByRole('button',{name:'读取当前发布状态',exact:true}).click();await pending(page);await page.getByRole('button',{name:'读取当前发布状态',exact:true}).click();await recovered(page,state,'published');});
test('version changes between article and metadata reads: do not unlock stale record',async t=>{const{page,state}=await fixture(t,'publish','lost');await confirmAction(page,'publish');await pending(page);state.changeDuringRead=true;await page.getByRole('button',{name:'读取当前发布状态',exact:true}).click();await pending(page);await expect(page.getByText(/读取期间内容版本已变化/)).toBeVisible();await page.getByRole('button',{name:'读取当前发布状态',exact:true}).click();await recovered(page,state,'published');});
test('unavailable record clears old action after authenticated reread',async t=>{const{page,state}=await fixture(t,'publish','drop');await confirmAction(page,'publish');await pending(page);state.removed=true;await page.getByRole('button',{name:'读取当前发布状态',exact:true}).click();await expect(page.getByText('当前记录已不可用，已清除旧操作；未重发发布或撤下。',{exact:true})).toBeVisible();await expect(page.getByLabel('内容标题',{exact:true})).toHaveValue('');assert.equal(state.attempts,1);});
