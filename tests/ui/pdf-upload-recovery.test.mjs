import {test,before,after} from 'node:test';
import assert from 'node:assert/strict';
import {mkdir,writeFile} from 'node:fs/promises';
import {spawn,execFileSync} from 'node:child_process';
import {chromium,expect} from '@playwright/test';
import {createReportUpload} from '../../server/report-upload-session.mjs';

const origin='http://127.0.0.1:51886',target='aaaaaaaa-aaaa-4aaa-aaaa-aaaaaaaaaaaa';let server,browser;
before(async()=>{
  await mkdir('work',{recursive:true});
  if(process.env.OPS_PDF_BASELINE==='1')await writeFile('work/PdfBaseline.tsx',execFileSync('git',['show','26d509c4fc7d6c717fc48836f3ceb4a9bdc01c8d:src/AdminArticles.tsx'],{encoding:'utf8'}).replaceAll("'./","'../src/"),'utf8');
  await writeFile('work/pdf.html','<div id="root"></div><script type="module" src="/work/pdf.tsx"></script>','utf8');
  await writeFile('work/pdf.tsx',"import React from 'react';import{createRoot}from'react-dom/client';import{AdminArticles}from'../src/AdminArticles';createRoot(document.getElementById('root')!).render(<AdminArticles userId=\"fixture-admin\"/>);".replace('../src/AdminArticles',process.env.OPS_PDF_BASELINE==='1'?'./PdfBaseline':'../src/AdminArticles'),'utf8');
  server=spawn(process.execPath,['node_modules/vite/bin/vite.js','--config','vite.admin.config.ts','--mode','cloud-ops','--host','127.0.0.1','--port','51886','--strictPort'],{stdio:'ignore'});
  for(let n=0;n<150;n++){try{if((await fetch(origin+'/ops/work/pdf.html')).ok)break;}catch{}if(n===149)throw Error('Local Vite did not start');await new Promise(r=>setTimeout(r,100));}
  browser=await chromium.launch({channel:'msedge',headless:true});
});
after(async()=>{await browser?.close();server?.kill();});
const pdfBytes=Buffer.concat([Buffer.from('%PDF-1.4\nSynthetic test only\n'),Buffer.alloc(262144,32)]);
const pdfFile={name:'synthetic.pdf',mimeType:'application/pdf',buffer:pdfBytes};

async function fixture(t,mode='normal'){
  const context=await browser.newContext(),page=await context.newPage();page.setDefaultTimeout(10000);
  const article={id:target,revision:1,status:'draft',title:'合成PDF草稿',summary:'',body:'仅本地合成说明',category:'knowledge',access:{visibility:'public',planIds:[]},document:null};
  const other={...structuredClone(article),id:'bbbbbbbb-bbbb-4bbb-bbbb-bbbbbbbbbbbb',title:'合成其他草稿'};
  const state={article,other,otherOriginal:structuredClone(other),requests:[],writes:0,actor:'fixture-admin',failNextMe:false,failRead:false,failMeta:false,changeDuringRead:false,removed:false,holdStage:null,gates:new Map(),readActorChange:false};
  state.release=stage=>{state.gates.get(stage)?.();state.gates.delete(stage);};
  t.after(async()=>{for(const stage of state.gates.keys())state.release(stage);state.releaseProcessing?.();await state.processing?.catch(()=>{});uploads.close();await context.close();});
  const uploads=createReportUpload(),actor=()=>({id:state.actor,role:'admin'});
  await page.route('**/*',async route=>{
    const req=route.request(),url=new URL(req.url());if(url.origin!==origin)return route.abort();if(!url.pathname.startsWith('/api/'))return route.continue();
    const send=(data,status=200)=>route.fulfill({status,contentType:'application/json',body:JSON.stringify(data)});
    if(url.pathname==='/api/me'){if(state.failNextMe){state.failNextMe=false;return route.abort();}if(state.holdIdentityAfterParts&&state.requests.filter(r=>r.stage==='part').length===2){await new Promise(resolve=>state.gates.set('identity',resolve));}return send({user:actor()});}
    if(url.pathname==='/api/admin/articles'&&req.method()==='GET'){
      if(state.failRead)return route.abort();const copy=structuredClone(article);if(state.changeDuringRead){article.revision++;state.changeDuringRead=false;}if(state.readActorChange)state.actor='other-admin';return send({articles:[...(state.removed?[]:[copy]),other]});
    }
    if(url.pathname==='/api/admin/content-meta/'+target&&req.method()==='GET'){
      if(state.failMeta)return route.abort();return send({metadata:{revision:article.revision,displayScope:'info',section:'launch',topic:'unclassified',activityGroup:'',originalUrl:'',policyCategory:'',practiceCategory:'',supportCategory:'',isRecap:false}});
    }
    const path=new RegExp('^/api/admin/articles/'+target+'/pdf/(start|([a-f0-9-]+)/(part|complete|abort))$').exec(url.pathname);
    if(path&&req.method()==='POST'){
      const stage=path[1]==='start'?'start':path[3],input=req.postDataJSON(),key=req.headers()['idempotency-key'];
      state.requests.push({stage,actor:state.actor,input,key});
      if(state.holdStage===stage)await new Promise(resolve=>state.gates.set(stage,resolve));
      if((mode==='start-drop'&&stage==='start')||(mode==='complete-drop'&&stage==='complete')||(mode==='abort-drop'&&stage==='abort'))return route.abort();
      if(mode==='pre400'&&stage==='complete')return send({error:'请求参数不正确'},400);
      if(mode==='start-reject'&&stage==='start')return send({error:'合成上传准备拒绝'},403);
      try{
        let result;
        if(stage==='start')result={upload:uploads.start(actor(),target,input,key)};
        if(stage==='part')result=uploads.part(actor(),target,path[2],input);
        if(stage==='abort')result=uploads.abort(actor(),target,path[2],input);
        if(stage==='complete'&&mode==='processing409')state.processing=uploads.complete(actor(),target,path[2],input,key,()=>new Promise(resolve=>state.releaseProcessing=()=>resolve({})));
        if(stage==='complete')result=await uploads.complete(actor(),target,path[2],input,mode==='key409'?'cccccccc-cccc-4ccc-cccc-cccccccccccc':key,async data=>{
          if(['parser','pages','active-content','generic400'].includes(mode))throw Object.assign(Error({parser:'PDF无法解析或已加密，请换用普通PDF',pages:'PDF须为1至300页','active-content':'PDF包含活动内容或附件，请导出普通PDF',generic400:'合成通用请求拒绝'}[mode]),{status:400});
          if(mode==='revision-conflict'){article.revision++;article.body='他人修改正文';}
          if(mode==='published'){article.revision++;article.status='published';}
          if(mode==='removed'){state.removed=true;throw Object.assign(Error('草稿已删除'),{status:410});}
          if(data.revision!==article.revision||article.status!=='draft')throw Object.assign(Error('版本或状态已变化'),{status:409});
          state.writes++;article.document={filename:data.filename,bytes:Buffer.from(data.base64,'base64').length,pages:12,previewPages:10};article.revision++;article.access={visibility:'plans',planIds:['organization','star'],previewPages:10};
          return{articleId:target,revision:article.revision,document:structuredClone(article.document)};
        });
        if(mode==='identity-start'&&stage==='start'||mode==='identity-part'&&stage==='part'||mode==='identity-complete'&&stage==='complete')state.actor='other-admin';
        if(mode==='final-read-fail'&&stage==='complete')state.failRead=true;
        if(mode==='abort-invalid'&&stage==='abort'||mode==='part-invalid'&&stage==='part')return send({unexpected:true});
        if(mode==='part-fail'&&stage==='part'||['abort-lost','abort-drop'].includes(mode)&&stage==='part'||mode==='start-lost'&&stage==='start'||mode==='complete-lost'&&stage==='complete'||mode==='abort-lost'&&stage==='abort')return route.abort();
        return send(result);
      }catch(error){return send({error:error.message},error.status||400);}
    }
    throw Error('Unexpected fixture route '+req.method()+' '+url.pathname);
  });
  await page.goto(origin+'/ops/work/pdf.html',{timeout:20000});await expect(page.getByText(/共 2 条内容/)).toBeVisible();await page.locator('.article-choice').filter({hasText:'合成PDF草稿'}).click();await expect(page.getByRole('button',{name:'发布内容',exact:true})).toBeEnabled();return{page,state};
}
async function select(page,file=pdfFile){await page.getByLabel('选择 PDF 文件',{exact:true}).setInputFiles(file);}
async function upload(page){await select(page);await page.getByRole('button',{name:'上传并生成试看',exact:true}).click();}
async function pending(page){
  await expect(page.getByRole('button',{name:'核对当前PDF',exact:true})).toBeEnabled();
  for(const name of ['新建内容','发布内容','删除草稿','上传并生成试看'])await expect(page.getByRole('button',{name,exact:true})).toBeDisabled();
  await expect(page.locator('.article-choice').filter({hasText:'合成其他草稿'})).toBeDisabled();
  assert.equal(await page.evaluate(()=>window.dispatchEvent(new Event('ops-before-section-change',{cancelable:true}))),false);
}
async function read(page){await page.getByRole('button',{name:'核对当前PDF',exact:true}).click();}
function stages(state){return state.requests.map(r=>r.stage);}
function unchangedOther(state){assert.deepEqual(state.other,state.otherOriginal);assert.ok(state.requests.every(r=>r.actor==='fixture-admin'));}
async function linked(page,state){await expect(page.getByText(/^当前记录已关联 PDF/)).toBeVisible();await expect(page.getByRole('button',{name:'核对当前PDF',exact:true})).toHaveCount(0);await expect(page.getByRole('button',{name:'上传并生成试看',exact:true})).toBeDisabled();unchangedOther(state);}

test('normal upload: selection, transport 100%, processing and confirmed link are distinct',async t=>{
  const{page,state}=await fixture(t);await select(page);await expect(page.getByText(/已选择，尚未上传/)).toBeVisible();assert.deepEqual(stages(state),[]);state.holdStage='complete';await page.getByRole('button',{name:'上传并生成试看',exact:true}).click();await expect(page.getByText('正在校验 PDF 并生成试看，请勿关闭页面…',{exact:true})).toBeVisible();assert.equal(state.writes,0);await expect(page.getByText(/^PDF 已完整上传并生成试看/)).toHaveCount(0);await expect(page.getByRole('button',{name:'取消本次上传',exact:true})).toHaveCount(0);state.release('complete');await expect(page.getByText(/^PDF 已完整上传并生成试看/)).toBeVisible();assert.equal(state.writes,1);assert.deepEqual(stages(state),['start','part','part','complete']);unchangedOther(state);
});
for(const [name,file]of [['extension',{...pdfFile,name:'wrong.txt'}],['empty',{...pdfFile,buffer:Buffer.alloc(0)}],['size',{...pdfFile,buffer:Buffer.alloc(15*1024*1024+1)}]])test('local '+name+' validation causes zero upload requests',async t=>{
  const{page,state}=await fixture(t);await select(page,file);await page.getByRole('button',{name:'上传并生成试看',exact:true}).click();await expect(page.getByText(/请选择一份.*15MB.*PDF/)).toBeVisible();assert.deepEqual(stages(state),[]);await select(page);await page.getByRole('button',{name:'上传并生成试看',exact:true}).click();await expect(page.getByText(/^PDF 已完整上传并生成试看/)).toBeVisible();
});
test('initial identity preflight fails: retain selection but send no upload',async t=>{
  const{page,state}=await fixture(t);await select(page);state.failNextMe=true;await page.getByRole('button',{name:'上传并生成试看',exact:true}).click();await expect(page.getByText(/上传前身份检查失败，尚未提交上传/)).toBeVisible();assert.deepEqual(stages(state),[]);await expect(page.getByText(/已选择，尚未上传/)).toBeVisible();await page.getByRole('button',{name:'上传并生成试看',exact:true}).click();await expect(page.getByText(/^PDF 已完整上传并生成试看/)).toBeVisible();
});
test('part fails: confirm abort once and reread before allowing new selection',async t=>{
  const{page,state}=await fixture(t,'part-fail');await upload(page);await pending(page);assert.deepEqual(stages(state),['start','part','abort']);await read(page);await expect(page.getByText(/^本次上传已中止，当前未关联 PDF/)).toBeVisible();await expect(page.getByRole('button',{name:'核对当前PDF',exact:true})).toHaveCount(0);await expect(page.getByRole('button',{name:'新建内容',exact:true})).toBeEnabled();assert.equal(state.writes,0);unchangedOther(state);
});
test('user cancel waits for in-flight part and abort confirmation; no complete',async t=>{
  const{page,state}=await fixture(t);state.holdStage='part';await upload(page);await expect(page.getByRole('button',{name:'取消本次上传',exact:true})).toBeEnabled();await page.getByRole('button',{name:'取消本次上传',exact:true}).click();await expect(page.getByText(/正在停止本次传输/)).toBeVisible();assert.equal(state.writes,0);state.holdStage=null;state.release('part');await pending(page);await read(page);await expect(page.getByText(/^已确认取消本次上传，当前未关联 PDF/)).toBeVisible();assert.deepEqual(stages(state),['start','part','abort']);assert.equal(state.writes,0);
});
for(const mode of ['abort-lost','abort-drop'])test(mode+': no definite cancellation and readonly checks retain pending',async t=>{
  const{page,state}=await fixture(t,mode);await upload(page);await pending(page);await read(page);await pending(page);await expect(page.getByText(/本次上传是否结束仍无法确认/)).toBeVisible();assert.deepEqual(stages(state),['start','part','abort']);assert.equal(state.writes,0);
});
for(const mode of ['start-lost','start-drop'])test(mode+': unknown session stays protected after no-document read',async t=>{
  const{page,state}=await fixture(t,mode);await upload(page);await pending(page);await read(page);await pending(page);await expect(page.getByText(/本次上传是否结束仍无法确认/)).toBeVisible();assert.deepEqual(stages(state),['start']);assert.equal(state.writes,0);
});
test('definite start refusal permits new selection after consistent readonly check',async t=>{
  const{page,state}=await fixture(t,'start-reject');await upload(page);await pending(page);await read(page);await expect(page.getByText(/^上传准备已被拒绝，当前未关联 PDF/)).toBeVisible();await expect(page.getByRole('button',{name:'新建内容',exact:true})).toBeEnabled();assert.deepEqual(stages(state),['start']);
});
test('complete response lost: readonly refresh confirms current document without replay or abort',async t=>{
  const{page,state}=await fixture(t,'complete-lost');await upload(page);await pending(page);await page.getByRole('button',{name:'刷新内容列表',exact:true}).click();await linked(page,state);assert.deepEqual(stages(state),['start','part','part','complete']);assert.equal(state.writes,1);await expect(page.getByText(/^PDF 已完整上传并生成试看/)).toHaveCount(0);
});
test('complete request never arrived: no document does not prove failure or permit retry',async t=>{
  const{page,state}=await fixture(t,'complete-drop');await upload(page);await pending(page);await read(page);await pending(page);await expect(page.getByText(/本次上传是否结束仍无法确认/)).toBeVisible();assert.deepEqual(stages(state),['start','part','part','complete']);assert.equal(state.writes,0);
});
test('final record read fails after complete: only reread, no second upload or abort',async t=>{
  const{page,state}=await fixture(t,'final-read-fail');await upload(page);await pending(page);state.failRead=false;await read(page);await linked(page,state);assert.equal(state.writes,1);assert.deepEqual(stages(state),['start','part','part','complete']);
});
for(const failure of ['list','meta','identity'])test(failure+' read failure keeps upload recovery and controls protected',async t=>{
  const{page,state}=await fixture(t,'complete-lost');await upload(page);await pending(page);state.failRead=failure==='list';state.failMeta=failure==='meta';state.failNextMe=failure==='identity';await read(page);await pending(page);state.failRead=false;state.failMeta=false;await page.getByRole('button',{name:'重新载入所选内容',exact:true}).click();await linked(page,state);assert.equal(state.writes,1);assert.deepEqual(stages(state),['start','part','part','complete']);
});
test('revision changes between reads: do not clear recovery or use mixed state',async t=>{
  const{page,state}=await fixture(t,'complete-lost');await upload(page);await pending(page);state.changeDuringRead=true;await read(page);await pending(page);await expect(page.getByText(/读取期间内容版本已变化/)).toBeVisible();await read(page);await linked(page,state);assert.equal(state.requests.filter(r=>r.stage==='complete').length,1);
});
test('another document is current: display it without claiming this upload succeeded',async t=>{
  const{page,state}=await fixture(t,'complete-drop');await upload(page);await pending(page);state.article.document={filename:'other.pdf',bytes:999,pages:3,previewPages:3};state.article.revision++;await read(page);await linked(page,state);await expect(page.getByText(/other.pdf · 3 页/)).toBeVisible();await expect(page.getByText(/^PDF 已完整上传并生成试看/)).toHaveCount(0);assert.equal(state.writes,0);
});
for(const mode of ['revision-conflict','published','removed'])test(mode+': adopt current facts without new revision upload',async t=>{
  const{page,state}=await fixture(t,mode);await upload(page);await pending(page);await read(page);await expect(page.getByRole('button',{name:'核对当前PDF',exact:true})).toBeEnabled();await expect(page.getByRole('button',{name:'新建内容',exact:true})).toBeDisabled();assert.equal(state.writes,0);assert.deepEqual(stages(state),['start','part','part','complete']);if(mode==='published')await expect(page.getByRole('button',{name:'删除草稿',exact:true})).toHaveCount(0);if(mode==='removed')await expect(page.getByText(/目标当前已不在可见列表中/)).toBeVisible();
});
for(const mode of ['identity-start','identity-part','identity-complete'])test(mode+': clear file and recovery; never abort or replay as another identity',async t=>{
  const{page,state}=await fixture(t,mode);await upload(page);await expect(page.getByText('登录状态已变化，请重新登录管理后台。',{exact:true})).toBeVisible();await expect(page.getByLabel('内容标题',{exact:true})).toHaveValue('');await expect(page.getByText(/已选择，尚未上传/)).toHaveCount(0);await expect(page.getByRole('button',{name:'核对当前PDF',exact:true})).toHaveCount(0);assert.ok(!stages(state).includes('abort'));unchangedOther(state);
});
test('identity changes during readonly recovery: clear pending and do not replay',async t=>{
  const{page,state}=await fixture(t,'complete-drop');await upload(page);await pending(page);state.readActorChange=true;await read(page);await expect(page.getByText('登录状态已变化，请重新登录管理后台。',{exact:true})).toBeVisible();await expect(page.getByRole('button',{name:'核对当前PDF',exact:true})).toHaveCount(0);assert.deepEqual(stages(state),['start','part','part','complete']);unchangedOther(state);
});
test('rapid double upload starts one session',async t=>{
  const{page,state}=await fixture(t);await select(page);await page.getByRole('button',{name:'上传并生成试看',exact:true}).evaluate(button=>{button.click();button.click();});await expect(page.getByText(/^PDF 已完整上传并生成试看/)).toBeVisible();assert.equal(state.writes,1);assert.equal(state.requests.filter(r=>r.stage==='start').length,1);unchangedOther(state);
});

test('100 percent transmission does not report final success before complete',async t=>{
  const{page,state}=await fixture(t);state.holdIdentityAfterParts=true;await upload(page);await expect(page.getByText(/文件传输中 100%（传输后还需校验并生成试看，尚未完成）/)).toBeVisible();assert.equal(state.writes,0);assert.ok(!stages(state).includes('complete'));await expect(page.getByText(/^PDF 已完整上传并生成试看/)).toHaveCount(0);await expect(page.getByText(/已选择，尚未上传/)).toHaveCount(0);state.holdIdentityAfterParts=false;state.release('identity');await expect(page.getByText(/^PDF 已完整上传并生成试看/)).toBeVisible();
});
test('cancel acknowledgement lost never claims cancelled and keeps protection',async t=>{
  const{page,state}=await fixture(t,'abort-lost');state.holdStage='part';await upload(page);await expect(page.getByRole('button',{name:'取消本次上传',exact:true})).toBeEnabled();await page.getByRole('button',{name:'取消本次上传',exact:true}).click();state.holdStage=null;state.release('part');await pending(page);await read(page);await pending(page);await expect(page.getByText(/^已确认取消本次上传/)).toHaveCount(0);assert.deepEqual(stages(state),['start','part','abort']);assert.equal(state.writes,0);
});
for(const mode of ['parser','pages','active-content'])test(mode+' explicit PDF validation refusal allows reselect only after readonly check',async t=>{
  const{page,state}=await fixture(t,mode);await upload(page);await pending(page);await read(page);await expect(page.getByText(/^服务端已拒绝本次 PDF 处理，当前未关联原件/)).toBeVisible();await expect(page.getByRole('button',{name:'核对当前PDF',exact:true})).toHaveCount(0);await expect(page.getByRole('button',{name:'新建内容',exact:true})).toBeEnabled();await expect(page.getByLabel('选择 PDF 文件',{exact:true})).toBeEnabled();assert.equal(state.writes,0);assert.deepEqual(stages(state),['start','part','part','complete']);
});
test('generic complete 400 does not prove session ended or unlock retries',async t=>{
  const{page,state}=await fixture(t,'generic400');await upload(page);await pending(page);await read(page);await pending(page);assert.equal(state.writes,0);assert.deepEqual(stages(state),['start','part','part','complete']);
});

for(const mode of ['pre400','key409','processing409'])test(mode+' complete precondition refusal keeps readonly recovery locked',async t=>{
  const{page,state}=await fixture(t,mode);await upload(page);await pending(page);await read(page);await pending(page);assert.equal(state.writes,0);assert.deepEqual(stages(state),['start','part','part','complete']);
});
test('malformed abort receipt never confirms cancellation or unlocks retry',async t=>{
  const{page,state}=await fixture(t,'abort-invalid');state.holdStage='part';await upload(page);await expect(page.getByRole('button',{name:'取消本次上传',exact:true})).toBeEnabled();await page.getByRole('button',{name:'取消本次上传',exact:true}).click();state.holdStage=null;state.release('part');await pending(page);await read(page);await pending(page);await expect(page.getByText(/^已确认取消本次上传/)).toHaveCount(0);assert.deepEqual(stages(state),['start','part','abort']);assert.equal(state.writes,0);
});
test('malformed part acknowledgement stops before complete and confirms safe abort',async t=>{
  const{page,state}=await fixture(t,'part-invalid');await upload(page);await pending(page);await read(page);await expect(page.getByText(/^本次上传已中止，当前未关联 PDF/)).toBeVisible();assert.deepEqual(stages(state),['start','part','abort']);assert.equal(state.writes,0);
});

function preparedSession(){
  const uploads=createReportUpload(),actor={id:'contract-admin',role:'admin'},key='11111111-1111-4111-a111-111111111111',next='22222222-2222-4222-a222-222222222222';
  const payload=Buffer.from('%PDF-synthetic'),input={revision:1,filename:'contract.pdf',bytes:payload.length},session=uploads.start(actor,target,input,key);
  const fill=()=>uploads.part(actor,target,session.id,{token:session.token,index:0,base64:payload.toString('base64')});
  return{uploads,actor,key,next,input,session,fill};
}
for(const message of ['PDF无法解析或已加密，请换用普通PDF','PDF须为1至300页','PDF包含活动内容或附件，请导出普通PDF','PDF格式不正确'])test('real session save rejection releases active before response: '+message,async()=>{
  const{uploads,actor,key,next,input,session,fill}=preparedSession();fill();
  await assert.rejects(uploads.complete(actor,target,session.id,{token:session.token},key,async()=>{throw Object.assign(Error(message),{status:400});}),error=>error.status===400&&error.message===message);
  const fresh=uploads.start(actor,target,input,next);assert.notEqual(fresh.id,session.id);uploads.close();
});
test('real session invalid part 400 does not release active',()=>{
  const{uploads,actor,key,next,input,session}=preparedSession();assert.throws(()=>uploads.part(actor,target,session.id,{token:session.token,index:0,base64:'!'}),error=>error.status===400);
  assert.equal(uploads.start(actor,target,input,key).id,session.id);assert.throws(()=>uploads.start(actor,target,input,next),error=>error.status===409);uploads.close();
});
test('real session key 409 does not invoke save or release active',async()=>{
  const{uploads,actor,key,next,input,session,fill}=preparedSession();fill();let saved=false;
  await assert.rejects(uploads.complete(actor,target,session.id,{token:session.token},next,async()=>{saved=true;}),error=>error.status===409);assert.equal(saved,false);
  assert.equal(uploads.start(actor,target,input,key).id,session.id);assert.throws(()=>uploads.start(actor,target,input,next),error=>error.status===409);uploads.close();
});
test('real session processing 409 does not end in-flight completion',async()=>{
  const{uploads,actor,key,next,input,session,fill}=preparedSession();fill();let release;
  const completing=uploads.complete(actor,target,session.id,{token:session.token},key,()=>new Promise(resolve=>{release=resolve;}));
  await assert.rejects(uploads.complete(actor,target,session.id,{token:session.token},key,async()=>{}),error=>error.status===409);
  assert.throws(()=>uploads.start(actor,target,input,next),error=>error.status===409);assert.throws(()=>uploads.abort(actor,target,session.id,{token:session.token}),error=>error.status===409);
  release({synthetic:true});await completing;assert.notEqual(uploads.start(actor,target,input,next).id,session.id);uploads.close();
});
