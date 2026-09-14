import {readFileSync,openSync,closeSync,readSync,fstatSync,constants} from 'node:fs';
import {join,resolve} from 'node:path';
import {fileURLToPath} from 'node:url';
import {createHash,randomUUID} from 'node:crypto';
import {openDatabase,transaction,audit} from '../server/db.mjs';
import {requireRule,textField,nowISO,digest} from '../server/domain.mjs';

export function verifyReportFile(path,expected){
 const fd=openSync(path,constants.O_RDONLY|(constants.O_NOFOLLOW||0));
 try{const st=fstatSync(fd);requireRule(st.isFile()&&st.size===expected.bytes,'报告大小不符');const hash=createHash('sha256'),buffer=Buffer.alloc(65536);let size=0,n;
 while((n=readSync(fd,buffer,0,buffer.length,null))>0){if(size===0)requireRule(buffer.subarray(0,5).toString()==='%PDF-','报告不是 PDF');size+=n;hash.update(buffer.subarray(0,n));}
 requireRule(hash.digest('hex')===expected.sha256,'报告摘要校验失败');
 }finally{closeSync(fd);}
}
export function importReports(db,{manifest,filesDirectory,adminUsername}){
 const actor=db.prepare("SELECT id,role FROM users WHERE username=? AND role='admin'").get(adminUsername);requireRule(actor,'导入需要管理员账号');
 requireRule(manifest.version===1&&Array.isArray(manifest.reports)&&manifest.reports.length>0&&manifest.reports.length<=1000,'导入清单不正确');
 const rows=manifest.reports.map(r=>{requireRule(/^[a-f0-9]{64}$/.test(r.sha256)&&Number.isSafeInteger(r.bytes)&&r.bytes>0&&r.bytes<=256000000&&Number.isSafeInteger(r.pages)&&r.pages>0,'文件参数不正确');
  const row={...r,title:textField(r.title,'标题',80,true),filename:textField(r.filename,'文件名',120,true)};
  requireRule(!/[\\/\r\n]/.test(row.filename)&&row.filename.toLowerCase().endsWith('.pdf'),'文件名不正确');
  verifyReportFile(join(filesDirectory,row.sha256+'.pdf'),row);return row;
 });
 return transaction(db,()=>{const result={created:0,skipped:0,ids:[]};for(const r of rows){
  const prior=db.prepare('SELECT article_id FROM article_documents WHERE sha256=?').get(r.sha256);
  if(prior){result.skipped++;result.ids.push(prior.article_id);continue;}
  const id=randomUUID(),now=nowISO(),summary=`行业研究报告 · PDF · ${r.pages} 页 · ${(r.bytes/1048576).toFixed(1)} MB`;
  const body=`${r.title}\n\n资料来源：项目方提供的行业研究报告。\n文件格式：PDF，共 ${r.pages} 页。\n请打开报告原件阅读；标题沿用所提供文件名，未自动生成报告结论。`;
  db.prepare(`INSERT INTO articles(id,title,summary,body,category,access_json,status,revision,created_by,updated_by,created_at,updated_at,idempotency_key,creation_hash) VALUES (?,?,?,?,'knowledge',?,'draft',1,?,?,?,?,?,?)`).run(id,r.title,summary,body,JSON.stringify({visibility:'unconfigured',planIds:[]}),actor.id,actor.id,now,now,'report-'+r.sha256,digest(JSON.stringify(r)));
  db.prepare('INSERT INTO article_documents VALUES (?,?,?,?,?,?)').run(id,r.sha256,r.filename,r.bytes,r.pages,now);
  audit(db,actor.id,'article.imported',id,{filename:r.filename,sha256:r.sha256,bytes:r.bytes,pages:r.pages,visibility:'unconfigured'});result.created++;result.ids.push(id);
 }return result;});
}
if(process.argv[1]&&resolve(process.argv[1])===fileURLToPath(import.meta.url)){
 const [database,manifestPath,filesDirectory,adminUsername]=process.argv.slice(2);if(!database||!manifestPath||!filesDirectory||!adminUsername)throw Error('Usage: import-reports.mjs database manifest filesDirectory adminUsername');
 const db=openDatabase(database);try{console.log(JSON.stringify(importReports(db,{manifest:JSON.parse(readFileSync(manifestPath,'utf8')),filesDirectory,adminUsername})));}finally{db.close();}
}
