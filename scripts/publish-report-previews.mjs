import {join,resolve} from 'node:path';
import {readFileSync} from 'node:fs';
import {fileURLToPath} from 'node:url';
import {openDatabase,transaction,audit} from '../server/db.mjs';
import {verifyReportFile} from './import-reports.mjs';

export function publishReportPreviews(db,{manifest,filesDirectory,adminUsername}){
  const admin=db.prepare("SELECT * FROM users WHERE username=? AND role='admin'").get(adminUsername);
  if(!admin||manifest.version!==1||manifest.previewLimit!==10||!Array.isArray(manifest.reports)||!manifest.reports.length)throw new Error('管理员或试看清单不正确');
  const seen=new Set();
  const reports=manifest.reports.map(report=>{
    if(!/^[a-f0-9]{64}$/.test(report.originalSha256)||!/^[a-f0-9]{64}$/.test(report.sha256)||seen.has(report.originalSha256)||report.sha256===report.originalSha256)throw new Error('试看校验值不正确或重复');
    seen.add(report.originalSha256);
    const original=db.prepare('SELECT * FROM article_documents WHERE sha256=?').get(report.originalSha256);
    if(!original||report.pages!==Math.min(10,original.pages))throw new Error('试看页数或原件不匹配');
    verifyReportFile(join(filesDirectory,report.sha256+'.pdf'),report);
    return {...report,id:original.article_id};
  });
  return transaction(db,()=>{
    let published=0,skipped=0;
    for(const report of reports){
      const row=db.prepare('SELECT * FROM articles WHERE id=?').get(report.id);
      const access={visibility:'plans',planIds:['basic','organization','star'],previewPages:10};
      const preview=db.prepare('SELECT * FROM report_previews WHERE article_id=?').get(report.id);
      if(preview){
        if(preview.sha256!==report.sha256||preview.byte_size!==report.bytes||preview.pages!==report.pages)throw new Error('现有试看文件不一致');
        // Re-running never re-publishes a subsequently withdrawn or edited report.
        skipped++;continue;
      }
      if(row.status!=='draft'||JSON.parse(row.access_json).visibility!=='unconfigured')throw new Error('报告已被运营修改，请核对后单独处理');
      db.prepare('INSERT INTO report_previews VALUES (?,?,?,?)').run(report.id,report.sha256,report.bytes,report.pages);
      const now=new Date().toISOString();
      db.prepare("UPDATE articles SET status='published',access_json=?,revision=revision+1,updated_by=?,updated_at=?,published_at=? WHERE id=?").run(JSON.stringify(access),admin.id,now,now,report.id);
      audit(db,admin.id,'article.publish',report.id,{revision:row.revision+1,access,previewSha256:report.sha256});published++;
    }
    return {published,skipped,total:reports.length};
  });
}
if(process.argv[1]&&resolve(process.argv[1])===fileURLToPath(import.meta.url)){
 const [dbPath,manifestPath,filesDirectory,adminUsername]=process.argv.slice(2);
 const db=openDatabase(dbPath);try{console.log(JSON.stringify(publishReportPreviews(db,{manifest:JSON.parse(readFileSync(manifestPath,'utf8')),filesDirectory,adminUsername})));}finally{db.close();}
}
