import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtempSync,mkdirSync,writeFileSync,rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {createHash,randomUUID} from 'node:crypto';
import {request} from 'node:http';
import {pagedReportPdf} from '../fixtures/report-pdf.mjs';
import {openDatabase} from '../../server/db.mjs';
import {hashPassword,insertUser,createOrder,applyVerifiedPayment} from '../../server/domain.mjs';
import {createApplication} from '../../server/app.mjs';
import {transitionArticle} from '../../server/articles.mjs';
import {importReports} from '../../scripts/import-reports.mjs';
import {publishReportPreviews} from '../../scripts/publish-report-previews.mjs';
import {createBackup,verifyBackup} from '../../scripts/backup.mjs';

test('standalone preview permissions cover guests, unpaid, all active plans, expiry, withdrawal, ranges and backup',async t=>{
 const root=mkdtempSync(join(tmpdir(),'club-preview-')),filesDirectory=join(root,'report-files');mkdirSync(filesDirectory);
 const db=openDatabase(join(root,'club.sqlite')),password='IsolatedReports1',admin=insertUser(db,'preview_admin',await hashPassword(password),'admin');
 const save=pdf=>{const sha256=createHash('sha256').update(pdf).digest('hex');writeFileSync(join(filesDirectory,sha256+'.pdf'),pdf);return {sha256,bytes:pdf.length};};
 const original=save(pagedReportPdf(11)),preview=save(pagedReportPdf(10));
 const id=importReports(db,{filesDirectory,adminUsername:admin.username,manifest:{version:1,reports:[{...original,pages:11,title:'隔离试看报告',filename:'隔离试看报告.pdf'}]}}).ids[0];
 const manifest={version:1,previewLimit:10,reports:[{...preview,pages:10,originalSha256:original.sha256}]};
 const publish=()=>publishReportPreviews(db,{manifest,filesDirectory,adminUsername:admin.username});
 const server=createApplication(db,{documentsDirectory:filesDirectory,localTrial:true,hosts:['127.0.0.1'],origins:['http://127.0.0.1']});await new Promise(r=>server.listen(0,'127.0.0.1',r));
 t.after(async()=>{await new Promise(r=>{server.closeAllConnections();server.close(r);});db.close();rmSync(root,{recursive:true,force:true});});
 const get=(path,body,headers={})=>new Promise((resolve,reject)=>{const req=request({host:'127.0.0.1',port:server.address().port,path:'/api'+path,method:body?'POST':'GET',headers:{Host:'127.0.0.1','Content-Type':'application/json','X-Club-Request':'1',...headers}},res=>{const chunks=[];res.on('data',c=>chunks.push(c));res.on('end',()=>resolve({status:res.statusCode,body:Buffer.concat(chunks),headers:res.headers}));});req.on('error',reject);req.end(body?JSON.stringify(body):undefined);});
 assert.equal((await get('/articles/'+id+'/preview')).status,404);
 assert.equal(publish().published,1);assert.equal(publish().skipped,1);
 const read=()=>get('/articles/'+id);
 const detail=JSON.parse((await read()).body).article;assert.equal(detail.fullAccess,false);assert.equal(detail.body,'');assert.equal(detail.document.previewPages,10);
 const shown=await get('/articles/'+id+'/preview');assert.equal(shown.status,200);assert.deepEqual(shown.body,pagedReportPdf(10));assert.equal(shown.body.includes('Isolated page 11'),false);
 for(const suffix of ['/document','/document?preview=true','/document?download=1'])assert.equal((await get('/articles/'+id+suffix,null,{Range:'bytes=0-4'})).status,404);
 assert.equal((await get('/articles/'+id+'/preview',null,{Range:'bytes=-20'})).status,206);
 const paid=[];
 for(const planId of [null,'basic','star','organization']){
  const user=insertUser(db,'reader_'+(planId||'unpaid'),await hashPassword(password),'member');
  const login=await get('/auth/login',{username:user.username,password});const headers={Cookie:login.headers['set-cookie'][0].split(';')[0]};
  if(planId){const order=createOrder(db,user.id,{planId,consent:true,form:{name:'隔离会员',phone:'13800000000',city:'隔离',company:'隔离机构',organizationType:'机构会员'}},randomUUID());if(order.status==='review')db.prepare("UPDATE orders SET status='pending' WHERE id=?").run(order.id);
    const expected={appId:'ISOLATED_PREVIEW',merchantId:'ISOLATED_PREVIEW'};applyVerifiedPayment(db,{...expected,transactionId:randomUUID(),orderId:order.id,currency:'CNY',amountCents:order.amountCents,status:'SUCCESS',paidAt:new Date().toISOString()},expected);if(planId==='organization'){const start=new Date().toISOString(),end='2099-01-01T00:00:00.000Z';db.prepare("UPDATE orders SET status='paid',paid_at=?,expires_at=? WHERE id=?").run(start,end,order.id);db.prepare('INSERT INTO memberships VALUES (?,?,?,?,?)').run(user.id,order.id,planId,start,end);}paid.push({user,headers});}
  assert.equal(JSON.parse((await get('/articles/'+id,null,headers)).body).article.fullAccess,!!planId);
  const full=await get('/articles/'+id+'/document',null,headers);assert.equal(full.status,planId?200:404);if(planId)assert.ok(full.body.includes('Isolated page 11'));
 }
 for(const {user,headers} of paid){db.prepare("UPDATE memberships SET expires_at='2000-01-01T00:00:00.000Z' WHERE user_id=?").run(user.id);assert.equal((await get('/articles/'+id+'/document',null,headers)).status,404);assert.equal((await get('/articles/'+id+'/preview',null,headers)).status,200);}
 const backup=createBackup({sourcePath:join(root,'club.sqlite'),outputRoot:join(root,'backups')});assert.equal(backup.documentCount,2);assert.equal(verifyBackup({backupPath:backup.backupPath,restoreRoot:join(root,'restored')}).documentCount,2);
 transitionArticle(db,admin,id,'unpublish',2);assert.equal(publish().skipped,1);assert.equal((await get('/articles/'+id+'/preview')).status,404);assert.equal((await read()).status,404);
});
