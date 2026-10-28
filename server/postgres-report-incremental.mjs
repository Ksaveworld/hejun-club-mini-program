import {createHash,randomUUID} from 'node:crypto';
import {createReadStream} from 'node:fs';
import {join} from 'node:path';
import {postgresTransaction} from './postgres.mjs';
import {importReportBatch} from './postgres-report-store.mjs';
import {requireRule} from './domain.mjs';

const actor='fe228ed9-3364-497a-b376-b0ca4d717805';
const sha=/^[a-f0-9]{64}$/;
const exact=(o,keys)=>o&&Object.keys(o).sort().join(',')===keys.slice().sort().join(',');
const json=o=>JSON.stringify(o,(_,v)=>typeof v==='bigint'?v.toString():v);
const hash=b=>createHash('sha256').update(b).digest('hex');
const key=m=>'_club_report_batch_v1:'+m.batchId;
export function parseIncrementalManifest(raw){
  const m=JSON.parse(raw);
  requireRule(exact(m,['version','batchId','reports'])&&m.version===1&&/^[a-z0-9][a-z0-9-]{1,60}$/.test(m.batchId)&&Array.isArray(m.reports)&&m.reports.length>0&&m.reports.length<=1000,'增量清单格式不正确');
  const seen=new Set();
  for(const r of m.reports){
    requireRule(exact(r,['title','filename','sha256','bytes','pages','preview'])&&typeof r.title==='string'&&r.title.trim()===r.title&&r.title.length>0&&r.title.length<=80&&typeof r.filename==='string'&&r.filename.length<=120&&!/[\\/\x00-\x1f]/.test(r.filename)&&r.filename.toLowerCase().endsWith('.pdf'),'报告标题或文件名不正确');
    requireRule(Number.isSafeInteger(r.pages)&&r.pages>10&&exact(r.preview,['sha256','bytes','pages'])&&r.preview.pages===10&&r.sha256!==r.preview.sha256,'报告必须有独立10页试看');
    for(const f of [r,r.preview]){requireRule(sha.test(f.sha256)&&Number.isSafeInteger(f.bytes)&&f.bytes>0&&f.bytes<=128*1024*1024&&!seen.has(f.sha256),'文件大小或指纹重复/不正确');seen.add(f.sha256);}
  }
  return {manifest:m,manifestSha256:hash(raw)};
}
function options(o){
  requireRule(/^club_migration_[a-z0-9_]{1,40}$/.test(o.schema||''),'必须明确目标schema');
  const parsed=parseIncrementalManifest(o.manifestRaw);
  requireRule(o.expectedManifestSha256===parsed.manifestSha256,'清单摘要未确认或不匹配');
  return parsed;
}
async function run(pool,o,write,fn){return postgresTransaction(pool,async c=>{
  if(!write)await c.query('SET TRANSACTION ISOLATION LEVEL REPEATABLE READ READ ONLY');
  await c.query(`SET LOCAL search_path TO "${o.schema}"`);
  if(write)await c.query('LOCK TABLE settings IN SHARE ROW EXCLUSIVE MODE');
  requireRule((await c.query("SELECT value FROM settings WHERE key='private-report-store-v1'")).rows[0]?.value==='pg-chunks-1048576','需要现有私有报告存储');
  requireRule((await c.query("SELECT id FROM users WHERE id=$1 AND username='system_content_seed' AND consent_version='system-content-only'",[actor])).rows.length===1,'现有归因账号不存在；不会创建账号');
  return fn(c);
});}
async function ledger(c,m){const r=(await c.query('SELECT value FROM settings WHERE key=$1',[key(m)])).rows[0];return r?JSON.parse(r.value):null;}
async function save(c,m,v){await c.query('INSERT INTO settings(key,value) VALUES($1,$2) ON CONFLICT(key) DO UPDATE SET value=excluded.value',[key(m),json(v)]);}
async function audit(c,m,action,detail){await c.query('INSERT INTO audit_log(actor_id,action,target_id,detail,created_at) VALUES($1,$2,$3,$4,$5)',[actor,'report-batch.'+action,m.batchId,json(detail),new Date().toISOString()]);}
async function matches(c,m){const rows=(await c.query('SELECT article_id,sha256 FROM article_documents WHERE sha256=ANY($1::text[])',[m.reports.map(r=>r.sha256)])).rows;return new Map(rows.map(r=>[r.sha256,r.article_id]));}
async function publishedCount(c){return Number((await c.query("SELECT count(*) AS n FROM articles WHERE status='published'")).rows[0].n);}
async function snapshot(c,id){return (await c.query('SELECT row_to_json(a)::text AS article,row_to_json(d)::text AS document,row_to_json(p)::text AS preview FROM articles a JOIN article_documents d ON d.article_id=a.id JOIN report_previews p ON p.article_id=a.id WHERE a.id=$1',[id])).rows[0];}
export async function preflightIncrementalReports(pool,o){
  const {manifest:m,manifestSha256}=options(o);
  return run(pool,o,false,async c=>{const prior=await ledger(c,m);requireRule(!prior||prior.manifestSha256===manifestSha256,'批次已绑定其他清单');const duplicates=await matches(c,m),publishedArticles=await publishedCount(c),newReports=m.reports.filter(r=>!duplicates.has(r.sha256)).map(r=>r.sha256);return {schema:o.schema,batchId:m.batchId,manifestSha256,state:prior?.state||'new',publishedArticles,catalogLimit:100,publishable:publishedArticles+newReports.length<=100,duplicates:[...duplicates].map(([sha256,articleId])=>({sha256,articleId})),newReports};});
}
export async function verifyIncrementalFiles(o){
  const {manifest:m}=options(o);
  for(const r of m.reports)for(const [directory,f]of [[o.originalsDirectory,r],[o.previewsDirectory,r.preview]]){
    let bytes=0;const h=createHash('sha256');
    for await(const b of createReadStream(join(directory,f.sha256+'.pdf'))){if(bytes===0)requireRule(b.subarray(0,5).toString()==='%PDF-','文件不是PDF');bytes+=b.length;h.update(b);}
    requireRule(bytes===f.bytes&&h.digest('hex')===f.sha256,'本地PDF指纹或大小不符');
  }
}
async function verifyStored(c,f){
  const row=(await c.query('SELECT * FROM _club_report_files WHERE sha256=$1',[f.sha256])).rows[0];
  requireRule(row&&Number(row.byte_size)===f.bytes&&Number(row.parts)===Math.ceil(f.bytes/1048576),'存储元数据不完整');
  const h=createHash('sha256');let bytes=0;
  for(let i=0;i<Number(row.parts);i++){
    const part=(await c.query('SELECT data FROM _club_report_chunks WHERE sha256=$1 AND part=$2',[f.sha256,i])).rows[0];
    requireRule(part&&part.data.length===Math.min(1048576,f.bytes-bytes),'存储分块不完整');bytes+=part.data.length;h.update(part.data);
  }
  requireRule(bytes===f.bytes&&h.digest('hex')===f.sha256,'存储内容指纹不符');
}
export async function applyIncrementalReports(pool,o){
  const {manifest:m,manifestSha256}=options(o);
  const before=await preflightIncrementalReports(pool,o);
  // A committed/withdrawn batch is immutable. Container restarts must not reread
  // hundreds of MB or require the private payload to remain mounted forever.
  if(['published','withdrawn'].includes(before.state))return run(pool,o,false,async c=>{
    const l=await ledger(c,m);requireRule(l&&l.manifestSha256===manifestSha256,'批次摘要改变');return l;
  });
  if(['new','staging'].includes(before.state))requireRule(before.publishable,'发布后超过现有100篇目录上限，停止新增');
  await verifyIncrementalFiles(o);
  const initial=await run(pool,o,true,async c=>{
    let l=await ledger(c,m);requireRule(!l||l.manifestSha256===manifestSha256,'批次已绑定其他清单');
    if(!l){l={version:1,manifestSha256,state:'staging',created:[],skipped:[]};await save(c,m,l);await audit(c,m,'staging',{manifestSha256,schema:o.schema});}
    return l;
  });
  if(initial.state!=='staging')return initial;
  const plan=await preflightIncrementalReports(pool,o),wanted=new Set(plan.newReports);
  const rows=m.reports.filter(r=>wanted.has(r.sha256));
  await importReportBatch(pool,{schema:o.schema,directory:o.originalsDirectory,files:rows});
  await importReportBatch(pool,{schema:o.schema,directory:o.previewsDirectory,files:rows.map(r=>r.preview)});
  return run(pool,o,true,async c=>{
    const l=await ledger(c,m);requireRule(l.manifestSha256===manifestSha256,'批次摘要改变');if(l.state!=='staging')return l;
    await c.query('LOCK TABLE articles,article_documents,report_previews IN SHARE ROW EXCLUSIVE MODE');
    const duplicates=await matches(c,m),now=new Date().toISOString();
    requireRule(await publishedCount(c)+m.reports.filter(r=>!duplicates.has(r.sha256)).length<=100,'发布后超过现有100篇目录上限，停止新增');
    for(const r of m.reports){
      if(duplicates.has(r.sha256)){l.skipped.push({sha256:r.sha256,articleId:duplicates.get(r.sha256)});continue;}
      await verifyStored(c,r);await verifyStored(c,r.preview);
      const id=randomUUID(),summary=`行业研究报告 · PDF · ${r.pages} 页 · ${(r.bytes/1048576).toFixed(1)} MB`,body=`${r.title}\n\n资料来源：项目方提供的行业研究报告。\n文件格式：PDF，共 ${r.pages} 页。\n请打开报告原件阅读；标题沿用所提供文件名，未自动生成报告结论。`;
      await c.query("INSERT INTO articles(id,title,summary,body,category,access_json,status,revision,created_by,updated_by,created_at,updated_at,published_at,idempotency_key,creation_hash) VALUES($1,$2,$3,$4,'knowledge',$5,'published',1,$6,$6,$7,$7,$7,$8,$9)",[id,r.title,summary,body,JSON.stringify({visibility:'plans',planIds:['basic','organization','star'],previewPages:10}),actor,now,'incremental-report-'+r.sha256,hash(JSON.stringify(r))]);
      await c.query('INSERT INTO article_documents VALUES($1,$2,$3,$4,$5,$6)',[id,r.sha256,r.filename,r.bytes,r.pages,now]);
      await c.query('INSERT INTO report_previews VALUES($1,$2,$3,$4)',[id,r.preview.sha256,r.preview.bytes,r.preview.pages]);
      l.created.push({articleId:id,sha256:r.sha256,snapshot:await snapshot(c,id)});
    }
    l.state='published';l.publishedAt=now;await save(c,m,l);await audit(c,m,'published',{manifestSha256,created:l.created.map(r=>r.articleId),skipped:l.skipped});return l;
  });
}
export async function withdrawIncrementalReports(pool,o){
  const {manifest:m,manifestSha256}=options(o);
  return run(pool,o,true,async c=>{
    const l=await ledger(c,m);requireRule(l&&l.manifestSha256===manifestSha256,'批次不存在或摘要不同');if(l.state==='withdrawn')return l;
    await c.query('LOCK TABLE articles,article_documents,report_previews IN SHARE ROW EXCLUSIVE MODE');
    const conflicts=[];for(const r of l.created)if(json(await snapshot(c,r.articleId))!==json(r.snapshot))conflicts.push(r.articleId);
    requireRule(!conflicts.length,'运营已修改文章，整批撤下已停止：'+conflicts.join(','));
    for(const r of l.created)await c.query("UPDATE articles SET status='draft',revision=revision+1,updated_at=$2 WHERE id=$1",[r.articleId,new Date().toISOString()]);
    l.state='withdrawn';l.withdrawnAt=new Date().toISOString();await save(c,m,l);await audit(c,m,'withdrawn',{manifestSha256,ids:l.created.map(r=>r.articleId)});return l;
  });
}
