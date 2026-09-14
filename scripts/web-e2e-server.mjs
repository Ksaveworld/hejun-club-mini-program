import {reportPdf,pagedReportPdf} from '../tests/fixtures/report-pdf.mjs';
import {publishReportPreviews} from './publish-report-previews.mjs';
import {importReports} from './import-reports.mjs';
import {createHash} from 'node:crypto';
// Isolated HTTPS harness; never reads deployed data or real administrator credentials.
import {createServer} from 'node:https';
import {request} from 'node:http';
import {readFileSync,mkdtempSync,writeFileSync,mkdirSync} from 'node:fs';
import {readFile,stat} from 'node:fs/promises';
import {resolve,extname,join} from 'node:path';
import {openDatabase} from '../server/db.mjs';
import {createApplication} from '../server/app.mjs';
import {hashPassword,insertUser} from '../server/domain.mjs';
const directory=mkdtempSync(resolve('work/web-experience/e2e-'));
const db=openDatabase(join(directory,'isolated.sqlite'));insertUser(db,'test_admin',await hashPassword('OnlyInIsolatedTests1'),'admin');
const documents=join(directory,'report-files');mkdirSync(documents);const sha=createHash('sha256').update(reportPdf).digest('hex');writeFileSync(join(documents,sha+'.pdf'),reportPdf);importReports(db,{filesDirectory:documents,adminUsername:'test_admin',manifest:{version:1,reports:[{title:'隔离PDF导入报告',filename:'隔离PDF导入报告.pdf',bytes:reportPdf.length,sha256:sha,pages:1}]}});
const api=createApplication(db,{documentsDirectory:documents,webTrial:{mode:'web-trial',origin:'https://example.com'}});await new Promise(r=>api.listen(0,'127.0.0.1',r));
const previewOriginal=pagedReportPdf(11),previewPdf=pagedReportPdf(10),originalSha=createHash('sha256').update(previewOriginal).digest('hex'),previewSha=createHash('sha256').update(previewPdf).digest('hex');
writeFileSync(join(documents,originalSha+'.pdf'),previewOriginal);writeFileSync(join(documents,previewSha+'.pdf'),previewPdf);
importReports(db,{filesDirectory:documents,adminUsername:'test_admin',manifest:{version:1,reports:[{title:'隔离会员试看报告',filename:'隔离会员试看报告.pdf',bytes:previewOriginal.length,sha256:originalSha,pages:11}]}});
publishReportPreviews(db,{filesDirectory:documents,adminUsername:'test_admin',manifest:{version:1,previewLimit:10,reports:[{originalSha256:originalSha,sha256:previewSha,bytes:previewPdf.length,pages:10}]}});
const root=resolve('work/deploy/cabc-club-app');
const server=createServer({key:readFileSync('work/web-experience/test-key.pem'),cert:readFileSync('work/web-experience/test-cert.pem')},async(req,res)=>{
 const url=new URL(req.url,'https://127.0.0.1:5228');
 if(url.pathname.startsWith('/hejun-club/api/')){
  const headers={...req.headers,host:'example.com','x-forwarded-proto':'https','x-real-ip':'127.0.0.1'};
  if(headers.origin==='https://127.0.0.1:5228')headers.origin='https://example.com';
  const upstream=request({host:'127.0.0.1',port:api.address().port,path:req.url.replace('/hejun-club/api/','/api/'),method:req.method,headers},response=>{res.writeHead(response.statusCode,response.headers);response.pipe(res);});upstream.on('error',()=>{res.writeHead(502);res.end();});req.pipe(upstream);return;
 }
 try{if(!url.pathname.startsWith('/hejun-club/'))throw Error();let path=resolve(root,'.'+decodeURIComponent(url.pathname.slice('/hejun-club'.length)));if(!path.startsWith(root))throw Error();if((await stat(path)).isDirectory())path=join(path,'index.html');res.setHeader('Content-Type',({'.html':'text/html; charset=utf-8','.js':'text/javascript','.css':'text/css','.svg':'image/svg+xml','.png':'image/png','.woff2':'font/woff2','.webp':'image/webp'})[extname(path)]||'application/octet-stream');res.end(await readFile(path));}catch{res.writeHead(404);res.end();}
});server.listen(5228,'127.0.0.1',()=>console.log('Isolated business web HTTPS harness ready'));
for(const signal of ['SIGINT','SIGTERM'])process.once(signal,()=>server.close(()=>api.close(()=>{db.close();process.exit(0);})));
