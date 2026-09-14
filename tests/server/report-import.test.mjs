import {reportPdf} from '../fixtures/report-pdf.mjs';
import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtempSync,mkdirSync,writeFileSync,readFileSync,rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {createHash} from 'node:crypto';
import {request} from 'node:http';
import {openDatabase} from '../../server/db.mjs';
import {hashPassword,insertUser} from '../../server/domain.mjs';
import {createApplication} from '../../server/app.mjs';
import {updateArticle,transitionArticle} from '../../server/articles.mjs';
import {importReports} from '../../scripts/import-reports.mjs';
import {createBackup,verifyBackup,inspectDatabase} from '../../scripts/backup.mjs';

async function setup(t){
 const root=mkdtempSync(join(tmpdir(),'club-reports-')),directory=join(root,'report-files');mkdirSync(directory);
 const db=openDatabase(join(root,'club.sqlite')),admin=insertUser(db,'report_admin',await hashPassword('IsolatedReports1'),'admin');
 // Original one-page PDF fixture; supplied PDFs are parsed separately before import.
 const pdf=reportPdf,sha256=createHash('sha256').update(pdf).digest('hex');writeFileSync(join(directory,sha256+'.pdf'),pdf);
 const manifest={version:1,reports:[{title:'隔离报告',filename:'隔离报告.pdf',sha256,bytes:pdf.length,pages:1}]};
 t.after(()=>{db.close();rmSync(root,{recursive:true,force:true});});return {root,directory,db,admin,pdf,sha256,manifest,load:m=>importReports(db,{manifest:m||manifest,filesDirectory:directory,adminUsername:'report_admin'})};
}
test('report import is repeatable, preserves originals and rejects incomplete batches before writing',async t=>{
 const e=await setup(t);const first=e.load();assert.equal(first.created,1);assert.equal(e.load().skipped,1);
 const row=e.db.prepare('SELECT * FROM articles').get();assert.equal(row.status,'draft');assert.equal(JSON.parse(row.access_json).visibility,'unconfigured');
 assert.deepEqual(readFileSync(join(e.directory,e.sha256+'.pdf')),e.pdf);assert.equal(e.db.prepare('SELECT COUNT(*) n FROM audit_log').get().n,1);
 const before=inspectDatabase(join(e.root,'club.sqlite')).contentDigest;
 assert.throws(()=>e.load({version:1,reports:[...e.manifest.reports,{...e.manifest.reports[0],sha256:'a'.repeat(64)}]}));
 assert.equal(inspectDatabase(join(e.root,'club.sqlite')).contentDigest,before);
});
test('PDF downloads enforce article visibility on every range request and support browser byte ranges',async t=>{
 const e=await setup(t),id=e.load().ids[0];const server=createApplication(e.db,{documentsDirectory:e.directory,hosts:['127.0.0.1'],origins:['http://127.0.0.1']});await new Promise(r=>server.listen(0,'127.0.0.1',r));
 t.after(()=>new Promise(r=>{server.closeAllConnections();server.close(r);}));
 const get=(path,body,headers={})=>new Promise((resolve,reject)=>{const req=request({host:'127.0.0.1',port:server.address().port,path:'/api'+path,method:body?'POST':'GET',headers:{Host:'127.0.0.1','Content-Type':'application/json','X-Club-Request':'1',...headers}},res=>{const chunks=[];res.on('data',c=>chunks.push(c));res.on('end',()=>resolve({status:res.statusCode,headers:res.headers,body:Buffer.concat(chunks)}));});req.on('error',reject);req.end(body?JSON.stringify(body):undefined);});
 assert.equal((await get('/articles/'+id+'/document')).status,404);assert.equal((await get('/admin/articles/'+id+'/document')).status,403);
 const login=await get('/auth/login',{username:'report_admin',password:'IsolatedReports1'}),cookie=login.headers['set-cookie'][0].split(';')[0];
 const original=await get('/admin/articles/'+id+'/document',null,{Cookie:cookie});assert.equal(original.status,200);assert.deepEqual(original.body,e.pdf);assert.equal(original.headers['content-type'],'application/pdf');
 const range=await get('/admin/articles/'+id+'/document',null,{Cookie:cookie,Range:'bytes=0-4'});assert.equal(range.status,206);assert.equal(range.body.toString(),'%PDF-');
 assert.equal((await get('/admin/articles/'+id+'/document',null,{Cookie:cookie,Range:'bytes=999999-'})).status,416);
 const saved=updateArticle(e.db,e.admin,id,{title:'隔离报告',summary:'',body:'附件阅读',category:'knowledge',access:{visibility:'public',planIds:[]},revision:1});
 const published=transitionArticle(e.db,e.admin,id,'publish',saved.revision);assert.equal((await get('/articles/'+id+'/document')).status,200);
 transitionArticle(e.db,e.admin,id,'unpublish',published.revision);assert.equal((await get('/articles/'+id+'/document',null,{Range:'bytes=5-10'})).status,404);
 e.db.prepare('DELETE FROM sessions').run();assert.equal((await get('/admin/articles/'+id+'/document',null,{Cookie:cookie})).status,403);
});
test('backup and restore verify PDF originals as well as the database',async t=>{
 const e=await setup(t);e.load();const backup=createBackup({sourcePath:join(e.root,'club.sqlite'),outputRoot:join(e.root,'backups')});assert.equal(backup.documentCount,1);
 const verified=verifyBackup({backupPath:backup.backupPath,restoreRoot:join(e.root,'restored')});assert.equal(verified.documentCount,1);assert.equal(verified.contentDigest,backup.contentDigest);
 writeFileSync(join(backup.backupPath+'.files',e.sha256+'.pdf'),'%PDF-broken');assert.throws(()=>verifyBackup({backupPath:backup.backupPath,restoreRoot:join(e.root,'bad-restore')}));
});
