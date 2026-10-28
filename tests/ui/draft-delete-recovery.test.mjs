import {test,before,after} from 'node:test';
import assert from 'node:assert/strict';
import {mkdir,writeFile} from 'node:fs/promises';
import {spawn,execFileSync} from 'node:child_process';
import {chromium,expect} from '@playwright/test';

const origin='http://127.0.0.1:51985';let server,browser;
before(async()=>{
  await mkdir('work',{recursive:true});
  if(process.env.OPS_DELETE_BASELINE==='1')await writeFile('work/DeleteBaseline.tsx',execFileSync('git',['show','0b95a0202ad5de250cd69dbf96ee4a4f44c1ac42:src/AdminArticles.tsx'],{encoding:'utf8'}).replaceAll("'./","'../src/"),'utf8');
  await writeFile('work/delete.html','<div id="root"></div><script type="module" src="/work/delete.tsx"></script>','utf8');
  await writeFile('work/delete.tsx',"import React from 'react';import{createRoot}from'react-dom/client';import{AdminArticles}from'../src/AdminArticles';createRoot(document.getElementById('root')!).render(<AdminArticles userId=\"fixture-admin\"/>);".replace('../src/AdminArticles',process.env.OPS_DELETE_BASELINE==='1'?'./DeleteBaseline':'../src/AdminArticles'),'utf8');
  server=spawn(process.execPath,['node_modules/vite/bin/vite.js','--config','vite.admin.config.ts','--mode','cloud-ops','--host','127.0.0.1','--port','51985','--strictPort'],{stdio:'ignore'});
  for(let n=0;n<150;n++){try{if((await fetch(origin+'/ops/work/delete.html')).ok)break;}catch{}if(n===149)throw Error('Local Vite did not start');await new Promise(r=>setTimeout(r,100));}
  browser=await chromium.launch({channel:'msedge',headless:true});
});
after(async()=>{await browser?.close();server?.kill();});

async function fixture(t,mode='normal'){
  const context=await browser.newContext();t.after(()=>context.close());const page=await context.newPage();page.setDefaultTimeout(10000);
  const article={id:'delete-target',revision:1,status:'draft',title:'合成待删草稿',summary:'',body:'合成原始正文',category:'news',access:{visibility:'public',planIds:[]},document:{filename:'synthetic.pdf',bytes:100,pages:1}};
  const other={...structuredClone(article),id:'untouched',title:'合成其他草稿'};
  const state={article,other,otherOriginal:structuredClone(other),attempts:[],writes:0,removed:false,failNextMe:false,failRead:false,failMeta:false,changeDuringRead:false,actor:'fixture-admin',readIdentityChange:false};
  await page.route('**/*',async route=>{
    const req=route.request(),url=new URL(req.url());if(url.origin!==origin)return route.abort();if(!url.pathname.startsWith('/api/'))return route.continue();
    const send=(data,status=200)=>route.fulfill({status,contentType:'application/json',body:JSON.stringify(data)});
    if(url.pathname==='/api/me'){if(state.failNextMe){state.failNextMe=false;return route.abort();}return send({user:{id:state.actor,role:'admin'}});}
    if(url.pathname==='/api/admin/articles'&&req.method()==='GET'){
      if(state.failRead)return route.abort();const target=structuredClone(article);if(state.changeDuringRead){article.revision++;state.changeDuringRead=false;}if(state.readIdentityChange)state.actor='other-admin';return send({articles:[...(state.removed?[]:[target]),other]});
    }
    if(url.pathname==='/api/admin/content-meta/delete-target'&&req.method()==='GET'){
      if(state.failMeta)return route.abort();return send({metadata:{revision:article.revision,displayScope:'info',section:'launch',topic:'unclassified',activityGroup:'',originalUrl:'',policyCategory:'',practiceCategory:'',supportCategory:'',isRecap:false}});
    }
    if(url.pathname==='/api/admin/articles/delete-target/delete'&&req.method()==='POST'){
      state.attempts.push({path:url.pathname,...req.postDataJSON()});
      if(mode==='drop'&&state.attempts.length===1)return route.abort();
      if(mode==='conflict'&&state.attempts.length===1){article.revision++;article.body='其他编辑者修改';return send({error:'内容版本冲突'},409);}
      if(mode==='published'&&state.attempts.length===1){article.revision++;article.status='published';return send({error:'已发布不能删除'},409);}
      if(mode==='already-deleted'&&state.attempts.length===1){state.removed=true;return send({error:'草稿已删除'},410);}
      if(mode==='reject')return send({error:'合成明确拒绝'},403);
      if(state.removed)return send({error:'草稿已删除'},410);
      if(req.postDataJSON().revision!==article.revision||article.status!=='draft')return send({error:'版本或状态冲突'},409);
      state.writes++;state.removed=true;
      if(mode==='identity')state.actor='other-admin';
      if(mode==='postcheck-fail')state.failNextMe=true;
      if(mode==='lost')return route.abort();
      return send({id:article.id,deleted:true});
    }
    throw Error('Unexpected fixture route '+req.method()+' '+url.pathname);
  });
  await page.goto(origin+'/ops/work/delete.html',{timeout:20000});await expect(page.getByText(/共 2 条内容/)).toBeVisible();await page.locator('.article-choice').filter({hasText:'合成待删草稿'}).click();await expect(page.getByRole('button',{name:'删除草稿',exact:true})).toBeEnabled();return{page,state};
}
async function confirmDelete(page){await page.getByRole('button',{name:'删除草稿',exact:true}).click();await page.getByRole('button',{name:'确认删除草稿',exact:true}).click();}
async function pending(page){
  await expect(page.getByRole('button',{name:'读取当前草稿状态',exact:true})).toBeEnabled();
  await expect(page.getByRole('button',{name:'新建内容',exact:true})).toBeDisabled();
  await expect(page.locator('.article-choice').filter({hasText:'合成其他草稿'})).toBeDisabled();
  await expect(page.getByRole('button',{name:'删除草稿',exact:true})).toBeDisabled();
  assert.equal(await page.evaluate(()=>window.dispatchEvent(new Event('ops-before-section-change',{cancelable:true}))),false);
}
async function read(page){await page.getByRole('button',{name:'读取当前草稿状态',exact:true}).click();}
function unchangedOther(state){assert.deepEqual(state.other,state.otherOriginal);assert.ok(state.attempts.every(a=>a.path==='/api/admin/articles/delete-target/delete'));}
async function unavailable(page,state){await expect(page.getByText(/^当前记录已不在可见列表中/)).toBeVisible();await expect(page.getByRole('button',{name:'读取当前草稿状态',exact:true})).toHaveCount(0);await expect(page.getByLabel('内容标题',{exact:true})).toHaveValue('');await expect(page.getByRole('button',{name:'新建内容',exact:true})).toBeEnabled();unchangedOther(state);}
async function present(page,state){await expect(page.getByText(/^已读取当前状态：/)).toBeVisible();await expect(page.getByRole('button',{name:'读取当前草稿状态',exact:true})).toHaveCount(0);unchangedOther(state);}

test('normal deletion requires confirmation and only removes target',async t=>{
  const{page,state}=await fixture(t);await page.getByRole('button',{name:'删除草稿',exact:true}).click();assert.equal(state.attempts.length,0);await page.getByRole('button',{name:'暂不操作',exact:true}).click();assert.equal(state.attempts.length,0);
  await confirmDelete(page);await expect(page.getByText('草稿已删除，已从列表移除；原始记录及文件保留备查。',{exact:true})).toBeVisible();await page.getByRole('button',{name:'刷新内容列表',exact:true}).click();await expect(page.getByText(/共 1 条内容/)).toBeVisible();assert.equal(state.writes,1);assert.equal(state.article.body,'合成原始正文');assert.equal(state.article.document.filename,'synthetic.pdf');unchangedOther(state);
});
test('initial identity preflight failure sends zero deletes and permits reconfirmation',async t=>{
  const{page,state}=await fixture(t);state.failNextMe=true;await confirmDelete(page);await expect(page.getByText(/删除前身份检查失败，尚未提交操作/)).toBeVisible();assert.equal(state.attempts.length,0);await confirmDelete(page);await expect(page.getByText('草稿已删除，已从列表移除；原始记录及文件保留备查。',{exact:true})).toBeVisible();assert.equal(state.writes,1);unchangedOther(state);
});
test('executed delete with lost response recovers by reading only',async t=>{
  const{page,state}=await fixture(t,'lost');await confirmDelete(page);await pending(page);await expect(page.getByText(/删除结果尚未确认，不能据此认定操作未执行/)).toBeVisible();await page.getByRole('button',{name:'刷新内容列表',exact:true}).click();await unavailable(page,state);assert.equal(state.attempts.length,1);assert.equal(state.writes,1);assert.equal(state.article.document.filename,'synthetic.pdf');
});
test('delete never arrived: reread then require another explicit confirmation',async t=>{
  const{page,state}=await fixture(t,'drop');await confirmDelete(page);await pending(page);await read(page);await present(page,state);assert.equal(state.writes,0);assert.equal(state.attempts.length,1);await expect(page.getByRole('button',{name:'删除草稿',exact:true})).toBeEnabled();await confirmDelete(page);await expect(page.getByText('草稿已删除，已从列表移除；原始记录及文件保留备查。',{exact:true})).toBeVisible();assert.equal(state.attempts.length,2);assert.equal(state.writes,1);
});
for(const failure of ['list','meta','identity'])test(failure+' read failure preserves unknown state and recovery entry',async t=>{
  const{page,state}=await fixture(t,'drop');await confirmDelete(page);await pending(page);state.failRead=failure==='list';state.failMeta=failure==='meta';state.failNextMe=failure==='identity';await read(page);await pending(page);assert.equal(state.attempts.length,1);state.failRead=false;state.failMeta=false;await page.getByRole('button',{name:'重新载入所选内容',exact:true}).click();await present(page,state);assert.equal(state.writes,0);
});
test('list failure after server deletion never restores or replays record',async t=>{
  const{page,state}=await fixture(t,'lost');await confirmDelete(page);await pending(page);state.failRead=true;await read(page);await pending(page);state.failRead=false;await read(page);await unavailable(page,state);assert.equal(state.writes,1);assert.equal(state.attempts.length,1);
});
test('edit revision conflict rereads without deletion; reconfirm uses current revision',async t=>{
  const{page,state}=await fixture(t,'conflict');await confirmDelete(page);await pending(page);await expect(page.getByText(/服务端已拒绝本次删除/)).toBeVisible();await read(page);await present(page,state);assert.equal(state.writes,0);await expect(page.getByLabel('内容正文 / 报告说明（发布前必填）',{exact:true})).toHaveValue('其他编辑者修改');assert.equal(state.attempts.length,1);await confirmDelete(page);await expect(page.getByText('草稿已删除，已从列表移除；原始记录及文件保留备查。',{exact:true})).toBeVisible();assert.deepEqual(state.attempts.map(a=>a.revision),[1,2]);
});
test('another editor publishes: reread current published record and cannot delete',async t=>{
  const{page,state}=await fixture(t,'published');await confirmDelete(page);await pending(page);await read(page);await present(page,state);await expect(page.getByText(/^已读取当前状态：已发布/)).toBeVisible();await expect(page.getByRole('button',{name:'删除草稿',exact:true})).toHaveCount(0);assert.equal(state.attempts.length,1);assert.equal(state.writes,0);
});
test('another editor deleted: definite 410 refusal only reads visibility',async t=>{
  const{page,state}=await fixture(t,'already-deleted');await confirmDelete(page);await pending(page);await expect(page.getByText(/服务端已拒绝本次删除/)).toBeVisible();await read(page);await unavailable(page,state);assert.equal(state.writes,0);assert.equal(state.attempts.length,1);
});
test('definite permission refusal stays read-only until current state is read',async t=>{
  const{page,state}=await fixture(t,'reject');await confirmDelete(page);await pending(page);await expect(page.getByText(/服务端已拒绝本次删除/)).toBeVisible();await read(page);await present(page,state);assert.equal(state.writes,0);assert.equal(state.attempts.length,1);
});
test('revision changes between list and metadata: retain pending until consistent reread',async t=>{
  const{page,state}=await fixture(t,'drop');await confirmDelete(page);await pending(page);state.changeDuringRead=true;await read(page);await pending(page);await expect(page.getByText(/读取期间内容版本已变化/)).toBeVisible();await read(page);await present(page,state);assert.equal(state.attempts.length,1);assert.equal(state.writes,0);
});
test('identity changes after delete response: clear pending and selection',async t=>{
  const{page,state}=await fixture(t,'identity');await confirmDelete(page);await expect(page.getByText('登录状态已变化，请重新登录管理后台。',{exact:true})).toBeVisible();await expect(page.getByLabel('内容标题',{exact:true})).toHaveValue('');await expect(page.getByRole('button',{name:'读取当前草稿状态',exact:true})).toHaveCount(0);assert.equal(state.attempts.length,1);unchangedOther(state);
});
test('identity changes during recovery: discard pending without replay under new actor',async t=>{
  const{page,state}=await fixture(t,'drop');await confirmDelete(page);await pending(page);state.readIdentityChange=true;await read(page);await expect(page.getByText('登录状态已变化，请重新登录管理后台。',{exact:true})).toBeVisible();await expect(page.getByLabel('内容标题',{exact:true})).toHaveValue('');await expect(page.getByRole('button',{name:'读取当前草稿状态',exact:true})).toHaveCount(0);assert.equal(state.attempts.length,1);assert.equal(state.writes,0);
});
test('post-response identity network failure remains unconfirmed and reads without replay',async t=>{
  const{page,state}=await fixture(t,'postcheck-fail');await confirmDelete(page);await pending(page);await read(page);await unavailable(page,state);assert.equal(state.writes,1);assert.equal(state.attempts.length,1);
});
test('rapid double confirmation sends exactly one delete',async t=>{
  const{page,state}=await fixture(t);await page.getByRole('button',{name:'删除草稿',exact:true}).click();await page.getByRole('button',{name:'确认删除草稿',exact:true}).evaluate(button=>{button.click();button.click();});await expect(page.getByText('草稿已删除，已从列表移除；原始记录及文件保留备查。',{exact:true})).toBeVisible();assert.equal(state.attempts.length,1);assert.equal(state.writes,1);unchangedOther(state);
});
