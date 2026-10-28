import {extraKey,parseExtra,readExtra,normalizeOfficialArticleUrl} from './article-placement-extra.mjs';
import {randomUUID,createHash} from 'node:crypto';
import {readFileSync} from 'node:fs';
import {postgresTransaction,safeInteger} from './postgres.mjs';
import {requireRule,textField,validateKey,nowISO,digest} from './domain.mjs';
export const batch2Tables=['_club_content_placement','_club_public_enterprises','_club_batch2_receipts'];
export const batch2Marker={key:'_club_batch2_migration',value:'014-batch2-v1'};
const migration=readFileSync(new URL('./migrations/postgres/014-batch2-content.sql',import.meta.url),'utf8');
const schemaName=s=>{requireRule(/^club_migration_[a-z0-9_]{1,40}$/.test(s||''),'数据区不正确');return '"'+s+'"';};
export async function verifyBatch2(c,schema){
 schemaName(schema);const mark=(await c.query('SELECT value FROM settings WHERE key=$1',[batch2Marker.key])).rows[0];
 const names=(await c.query('SELECT tablename FROM pg_tables WHERE schemaname=$1',[schema])).rows.map(r=>r.tablename),found=batch2Tables.filter(t=>names.includes(t));
 requireRule(mark?mark.value===batch2Marker.value&&found.length===batch2Tables.length:found.length===0,'运营维护迁移标记或表集合不一致',503);
 if(mark){
  const expected={_club_content_placement:{article_id:'text',section:'text',topic:'text',updated_at:'text'},_club_public_enterprises:{id:'text',name:'text',summary:'text',body:'text',logo_data_url:'text',publication_consent:'boolean',status:'text',revision:'bigint',created_by:'text',updated_at:'text',published_at:'text'},_club_batch2_receipts:{actor_id:'text',idempotency_key:'text',request_hash:'text',result_json:'jsonb',created_at:'text'}};
  const columns=(await c.query('SELECT table_name,column_name,data_type,is_nullable FROM information_schema.columns WHERE table_schema=$1 AND table_name=ANY($2::text[])',[schema,batch2Tables])).rows;
  for(const [table,fields] of Object.entries(expected)){const cols=columns.filter(x=>x.table_name===table);requireRule(cols.length===Object.keys(fields).length&&cols.every(x=>fields[x.column_name]===x.data_type&&x.is_nullable===(x.column_name==='published_at'?'YES':'NO')),'运营维护表字段结构不一致',503);}
  const constraints=(await c.query('SELECT t.relname AS table_name,k.contype,pg_get_constraintdef(k.oid) AS definition FROM pg_constraint k JOIN pg_class t ON t.oid=k.conrelid JOIN pg_namespace n ON n.oid=t.relnamespace WHERE n.nspname=$1 AND t.relname=ANY($2::text[])',[schema,batch2Tables])).rows;
  for(const [table,pk] of [['_club_content_placement','PRIMARY KEY (article_id)'],['_club_public_enterprises','PRIMARY KEY (id)'],['_club_batch2_receipts','PRIMARY KEY (actor_id, idempotency_key)']])requireRule(constraints.some(x=>x.table_name===table&&x.contype==='p'&&x.definition===pk)&&constraints.some(x=>x.table_name===table&&x.contype==='f'),'运营维护表主键或引用约束缺失',503);
  for(const [table,parts] of [['_club_content_placement',['section','launch','landing','professional']],['_club_content_placement',['topic','unclassified','policy','practice']],['_club_public_enterprises',['status','draft','published']],['_club_public_enterprises',['revision','> 0']]])requireRule(constraints.some(x=>x.table_name===table&&x.contype==='c'&&parts.every(p=>x.definition.includes(p))),'运营维护表约束不一致',503);
 }return !!mark;
}
export async function batch2MigrationTables(c,schema){return await verifyBatch2(c,schema)?[...batch2Tables]:[];}
export async function initializeBatch2(pool,{schema,targetSchema}){requireRule(targetSchema===schema,'必须显式指定本次迁移目标数据区');return postgresTransaction(pool,async c=>{await c.query(`SET LOCAL search_path TO ${schemaName(schema)}`);await c.query('LOCK TABLE settings IN SHARE ROW EXCLUSIVE MODE');if(await verifyBatch2(c,schema))return {initialized:false};await c.query(migration);return {initialized:true,tables:batch2Tables};});}
const sha=b=>createHash('sha256').update(b).digest('hex');
const one=async(c,sql,args=[])=>(await c.query(sql,args)).rows[0];
async function logo(value,imageLoader){
 requireRule(typeof value==='string','请选择企业LOGO');const m=/^data:image\/(png|jpeg);base64,([A-Za-z0-9+/]+={0,2})$/.exec(value);requireRule(m&&m[2].length<=175000,'LOGO仅支持128KB以内PNG或JPEG');const b=Buffer.from(m[2],'base64');requireRule(b.length>16&&b.length<=128*1024&&b.toString('base64')===m[2],'LOGO数据不正确');requireRule(m[1]==='png'?b.subarray(0,8).equals(Buffer.from([137,80,78,71,13,10,26,10])):b[0]===255&&b[1]===216&&b[b.length-2]===255&&b[b.length-1]===217,'LOGO文件格式不正确');let output;try{const sharp=(await imageLoader()).default;const pipeline=sharp(b,{limitInputPixels:4096*4096,failOn:'warning'});const metadata=await pipeline.metadata();requireRule(metadata.width>0&&metadata.height>0&&metadata.width<=4096&&metadata.height<=4096&&(!metadata.pages||metadata.pages===1),'LOGO尺寸过大或格式不支持');output=await pipeline.resize({width:512,height:512,fit:'inside',withoutEnlargement:true}).png().toBuffer();}catch{requireRule(false,'LOGO图片无法解析，请重新导出PNG或JPEG');}requireRule(output.length<=128*1024,'请使用更小的LOGO图片');return 'data:image/png;base64,'+output.toString('base64');
}
const enterprise=r=>({id:r.id,name:r.name,summary:r.summary,body:r.body,logoDataUrl:r.logo_data_url,publicationConsent:r.publication_consent,status:r.status,revision:safeInteger(r.revision),updatedAt:r.updated_at,publishedAt:r.published_at});
const publicEnterprise=r=>({id:r.id,name:r.name,summary:r.summary,body:r.body,logoUrl:`/api/enterprises/${encodeURIComponent(r.id)}/logo`,publishedAt:r.published_at});
let pdfBusy=false;
export function createBatch2Content(pool,{schema,pdfLoader=()=>import('pdf-lib'),imageLoader=()=>import('sharp')}={}){
 schemaName(schema);
 // Strict catalog verification once per factory; no failed verification is cached.
 let readyPromise;
 const ready=()=>{
  if(!readyPromise){
   readyPromise=postgresTransaction(pool,async c=>{await c.query(`SET LOCAL search_path TO ${schemaName(schema)}`);requireRule(await verifyBatch2(c,schema),'运营维护尚未初始化',503);});
   readyPromise.catch(()=>{readyPromise=undefined;});
  }
  return readyPromise;
 };
 const run=async fn=>{await ready();return postgresTransaction(pool,async c=>{await c.query(`SET LOCAL search_path TO ${schemaName(schema)}`);const marker=await one(c,'SELECT value FROM settings WHERE key=$1',[batch2Marker.key]);requireRule(marker?.value===batch2Marker.value,'运营维护迁移标记不一致',503);return fn(c);});};
 async function editor(c,a){requireRule(a?.role==='admin'&&await one(c,"SELECT 1 FROM users WHERE id=$1 AND role='admin'",[a.id]),'需要管理员权限',403);}
 async function mutation(a,key,input,fn){validateKey(key);const hash=digest(JSON.stringify(input));return run(async c=>{await editor(c,a);await c.query('SELECT id FROM users WHERE id=$1 FOR UPDATE',[a.id]);const prior=await one(c,'SELECT * FROM _club_batch2_receipts WHERE actor_id=$1 AND idempotency_key=$2',[a.id,key]);if(prior){requireRule(prior.request_hash===hash,'操作编号已用于不同内容',409);return prior.result_json;}const result=await fn(c);await c.query('INSERT INTO _club_batch2_receipts VALUES($1,$2,$3,$4,$5)',[a.id,key,hash,JSON.stringify(result),nowISO()]);return result;});}
 const audit=(c,a,action,id,detail)=>c.query('INSERT INTO audit_log(actor_id,action,target_id,detail,created_at) VALUES($1,$2,$3,$4,$5)',[a.id,action,id,JSON.stringify(detail),nowISO()]);
 async function article(c,id,revision){const r=await one(c,'SELECT * FROM articles WHERE id=$1 FOR UPDATE',[id]);requireRule(r,'内容不存在',404);requireRule(!await one(c,'SELECT 1 FROM settings WHERE key=$1',['_club_deleted:articles:'+id]),'草稿已删除',410);if(revision!==undefined)requireRule(Number.isSafeInteger(revision)&&safeInteger(r.revision)===revision,'内容已变化，请刷新',409);return r;}
 const meta=async(c,id)=>{const a=await article(c,id),m=await one(c,'SELECT * FROM _club_content_placement WHERE article_id=$1',[id]);const inferred=/投资指南|出海指引|政策法规|法律法规|国别指南/.test(a.title)?{section:'landing',topic:'policy'}:/案例|经营实务|业务实务|操作实务/.test(a.title)?{section:'landing',topic:'practice'}:{section:'launch',topic:'unclassified'};return {...await readExtra(c,id),articleId:id,revision:safeInteger(a.revision),section:m?m.section:inferred.section,topic:m?m.topic:inferred.topic};};
 return {
 metadata:(a,id)=>run(async c=>{await editor(c,a);return meta(c,id);}),
 saveMetadata:(a,id,b,key)=>mutation(a,key,{op:'metadata',id,...b},async c=>{requireRule(['launch','landing','professional'].includes(b.section)&&['unclassified','policy','practice'].includes(b.topic),'请选择有效板块和主题');requireRule(Number.isSafeInteger(b.revision),'缺少内容版本');const row=await article(c,id,b.revision);requireRule(row.status==='draft','请先撤下内容再修改归属',409);
 const before=await readExtra(c,id),extra={...before};
 for(const field of ['activityGroup','originalUrl','policyCategory','practiceCategory','supportCategory','isRecap','displayScope'])if(Object.hasOwn(b,field))extra[field]=b[field];
 // Old callers omit displayScope: infer it from the submitted activity placement.
 if(!Object.hasOwn(b,'displayScope'))extra.displayScope=extra.activityGroup?'both':'info';
 requireRule(['info','activity','both'].includes(extra.displayScope),'请选择有效展示位置');
 if(extra.displayScope==='info')extra.activityGroup='';
 requireRule(['','salon','expo','online'].includes(extra.activityGroup),'请选择有效活动栏目');
 requireRule(extra.displayScope==='info'||!!extra.activityGroup,'请先选择活动栏目');
 requireRule(['','investment','compliance','guides'].includes(extra.policyCategory),'请选择有效政策分类');
 requireRule(['','cases','methods','library'].includes(extra.practiceCategory),'请选择有效实务分类');
 requireRule(!extra.practiceCategory||(b.section==='landing'&&b.topic==='practice'),'实务分类须归入落地加速的经营实务');
 requireRule(['','parks','associations','opportunities'].includes(extra.supportCategory),'请选择有效落地配套分类');
 requireRule(!extra.supportCategory||(b.section==='landing'&&b.topic==='unclassified'),'落地配套分类须归入落地加速的落地配套');
 requireRule(typeof extra.isRecap==='boolean','活动回顾标记不正确');
 requireRule(typeof extra.originalUrl==='string','公众号链接格式不正确');extra.originalUrl=extra.originalUrl.trim();
 if(extra.originalUrl){extra.originalUrl=normalizeOfficialArticleUrl(extra.originalUrl);requireRule(extra.originalUrl,'请填写有效的微信公众号文章链接');requireRule(JSON.parse(row.access_json).visibility==='public','公众号原文为公开文章，请确认阅读范围为所有访客');requireRule(!await one(c,'SELECT 1 FROM article_documents WHERE article_id=$1',[id]),'一条内容只使用PDF或公众号原文，请另建草稿');}
 requireRule(!extra.policyCategory||(b.section==='landing'&&b.topic==='policy'),'政策分类须归入落地加速的政策法规');
 await c.query('INSERT INTO settings(key,value) VALUES($1,$2) ON CONFLICT(key) DO UPDATE SET value=$2',[extraKey(id),JSON.stringify(extra)]);
 await c.query('INSERT INTO _club_content_placement VALUES($1,$2,$3,$4) ON CONFLICT(article_id) DO UPDATE SET section=$2,topic=$3,updated_at=$4',[id,b.section,b.topic,nowISO()]);await c.query('UPDATE articles SET revision=revision+1,updated_at=$1,updated_by=$2 WHERE id=$3',[nowISO(),a.id,id]);await audit(c,a,'article.placement',id,{section:b.section,topic:b.topic,...extra});return meta(c,id);}),
 publicTopics:()=>run(async c=>{
 const rows=(await c.query("SELECT p.article_id,p.section,p.topic,a.access_json,s.value,EXISTS(SELECT 1 FROM article_documents d WHERE d.article_id=a.id) AS has_document FROM _club_content_placement p JOIN articles a ON a.id=p.article_id LEFT JOIN settings s ON s.key='_club_activity_article:'||a.id WHERE a.status='published'")).rows;
 return rows.map(r=>{const e=parseExtra(r.value);return {articleId:r.article_id,section:r.section,topic:r.topic,...e,originalUrl:JSON.parse(r.access_json).visibility==='public'&&!r.has_document?(normalizeOfficialArticleUrl(e.originalUrl)||''):''};});
 }),
 enterprises:a=>run(async c=>{await editor(c,a);return (await c.query('SELECT * FROM _club_public_enterprises ORDER BY updated_at DESC,id')).rows.map(enterprise);}),
 publicEnterprises:()=>run(async c=>(await c.query("SELECT * FROM _club_public_enterprises WHERE status='published' AND publication_consent=TRUE ORDER BY published_at DESC,id LIMIT 50")).rows.map(publicEnterprise)),
 publicLogo:id=>run(async c=>{const r=await one(c,"SELECT logo_data_url FROM _club_public_enterprises WHERE id=$1 AND status='published' AND publication_consent=TRUE",[id]);requireRule(r,'企业不存在或已撤下',404);return {bytes:Buffer.from(r.logo_data_url.split(',')[1],'base64'),contentType:'image/png'};}),
 publicEnterprise:id=>run(async c=>{const r=await one(c,"SELECT * FROM _club_public_enterprises WHERE id=$1 AND status='published' AND publication_consent=TRUE",[id]);requireRule(r,'企业不存在或已撤下',404);return publicEnterprise(r);}),
 saveEnterprise:(a,b,key,id)=>mutation(a,key,{op:'enterprise',id,...b},async c=>{
 const fields={name:textField(b.name,'企业名称',80,true),summary:textField(b.summary,'简介',180,true),body:textField(b.body,'产品与服务介绍',4000,true),logo:await logo(b.logoDataUrl,imageLoader)};requireRule(typeof b.publicationConsent==='boolean','请确认公开展示授权');
 if(id){const r=await one(c,'SELECT * FROM _club_public_enterprises WHERE id=$1 FOR UPDATE',[id]);requireRule(r,'企业不存在',404);requireRule(r.status==='draft'&&Number.isSafeInteger(b.revision)&&safeInteger(r.revision)===b.revision,'请先撤下企业并刷新版本后修改',409);await c.query('UPDATE _club_public_enterprises SET name=$1,summary=$2,body=$3,logo_data_url=$4,publication_consent=$5,revision=revision+1,updated_at=$6 WHERE id=$7',[fields.name,fields.summary,fields.body,fields.logo,b.publicationConsent,nowISO(),id]);}
 else{id=randomUUID();await c.query("INSERT INTO _club_public_enterprises VALUES($1,$2,$3,$4,$5,$6,'draft',1,$7,$8,NULL)",[id,fields.name,fields.summary,fields.body,fields.logo,b.publicationConsent,a.id,nowISO()]);}await audit(c,a,'enterprise.saved',id,{public:false});return enterprise(await one(c,'SELECT * FROM _club_public_enterprises WHERE id=$1',[id]));}),
 transitionEnterprise:(a,id,action,revision,key)=>mutation(a,key,{op:'enterprise.transition',id,action,revision},async c=>{requireRule(['publish','unpublish'].includes(action),'操作不正确');const r=await one(c,'SELECT * FROM _club_public_enterprises WHERE id=$1 FOR UPDATE',[id]);requireRule(r,'企业不存在',404);requireRule(Number.isSafeInteger(revision)&&safeInteger(r.revision)===revision&&r.status===(action==='publish'?'draft':'published'),'企业状态或版本已变化，请刷新',409);if(action==='publish')requireRule(r.publication_consent&&r.name&&r.body&&r.logo_data_url,'发布前请确认企业公开授权并补齐内容');await c.query('UPDATE _club_public_enterprises SET status=$1,revision=revision+1,updated_at=$2,published_at=$3 WHERE id=$4',[action==='publish'?'published':'draft',nowISO(),action==='publish'?nowISO():r.published_at,id]);await audit(c,a,'enterprise.'+action,id,{revision:revision+1});return enterprise(await one(c,'SELECT * FROM _club_public_enterprises WHERE id=$1',[id]));}),
 uploadPdf:async(a,id,b,key)=>{
 // Authorize before invoking a parser. Only one PDF is processed per instance.
 await run(async c=>{await editor(c,a);const r=await article(c,id);const prior=await one(c,'SELECT 1 FROM _club_batch2_receipts WHERE actor_id=$1 AND idempotency_key=$2',[a.id,key]);if(!prior){requireRule(r.status==='draft','请先撤下报告后上传',409);requireRule(!await one(c,'SELECT 1 FROM article_documents WHERE article_id=$1',[id]),'已有报告原件保留；请新建草稿上传，不能覆盖原件',409);}});validateKey(key);requireRule(Number.isSafeInteger(b.revision),'缺少内容版本');
 const filename=textField(b.filename,'PDF文件名',120,true);requireRule(/\.pdf$/i.test(filename)&&!/[\\/\r\n]/.test(filename),'仅支持PDF文件');
 requireRule(typeof b.base64==='string'&&b.base64.length<=20*1024*1024&&/^[A-Za-z0-9+/]+={0,2}$/.test(b.base64),'PDF超过15MB或格式错误',413);const bytes=Buffer.from(b.base64,'base64');requireRule(bytes.length>8&&bytes.length<=15*1024*1024&&bytes.toString('base64')===b.base64&&bytes.subarray(0,5).toString()==='%PDF-','PDF格式不正确');
 requireRule(!pdfBusy,'另一个PDF正在处理，请稍后重试',429);pdfBusy=true;
 try{const {PDFDocument,PDFDict,PDFName}=await pdfLoader();let doc;
 try{doc=await PDFDocument.load(bytes,{ignoreEncryption:false,throwOnInvalidObject:true});}catch{requireRule(false,'PDF无法解析或已加密，请换用普通PDF');}
 const pages=doc.getPageCount();requireRule(pages>0&&pages<=300,'PDF须为1至300页');
 for(const [,o] of doc.context.enumerateIndirectObjects())if(o instanceof PDFDict)for(const n of ['JavaScript','JS','OpenAction','AA','EmbeddedFiles','Launch','RichMedia'])requireRule(!o.has(PDFName.of(n)),'PDF包含活动内容或附件，请导出普通PDF');
 const preview=await PDFDocument.create();for(const page of await preview.copyPages(doc,Array.from({length:Math.min(10,pages)},(_,i)=>i)))preview.addPage(page);const previewBytes=Buffer.from(await preview.save());const fullSha=sha(bytes),previewSha=sha(previewBytes);
 return await mutation(a,key,{op:'pdf',id,revision:b.revision,filename,sha256:fullSha},async c=>{
 const r=await article(c,id,b.revision);requireRule(r.status==='draft','请先撤下报告后上传',409);requireRule(!(await readExtra(c,id)).originalUrl,'此内容已有公众号原文链接，请另建草稿上传PDF');const old=await one(c,'SELECT * FROM article_documents WHERE article_id=$1',[id]);requireRule(!old,'已有报告原件保留；请新建草稿上传，不能覆盖原件',409);requireRule(!await one(c,'SELECT 1 FROM article_documents WHERE sha256=$1',[fullSha]),'该PDF已上传，请使用已有报告',409);
 requireRule((await one(c,"SELECT value FROM settings WHERE key='private-report-store-v1'"))?.value==='pg-chunks-1048576','私有报告存储尚未初始化',503);
 for(const [data,hash] of [[bytes,fullSha],[previewBytes,previewSha]]){const existing=await one(c,'SELECT * FROM _club_report_files WHERE sha256=$1',[hash]);if(existing){requireRule(safeInteger(existing.byte_size)===data.length,'报告存储不一致',503);continue;}await c.query('INSERT INTO _club_report_files VALUES($1,$2,$3)',[hash,data.length,Math.ceil(data.length/1048576)]);for(let pos=0,part=0;pos<data.length;pos+=1048576,part++)await c.query('INSERT INTO _club_report_chunks VALUES($1,$2,$3)',[hash,part,data.subarray(pos,pos+1048576)]);}
 await c.query('INSERT INTO article_documents VALUES($1,$2,$3,$4,$5,$6)',[id,fullSha,filename,bytes.length,pages,nowISO()]);await c.query('INSERT INTO report_previews VALUES($1,$2,$3,$4)',[id,previewSha,previewBytes.length,Math.min(10,pages)]);const access={visibility:'plans',planIds:['organization','star'],previewPages:10};await c.query('UPDATE articles SET access_json=$4,revision=revision+1,updated_at=$1,updated_by=$2 WHERE id=$3',[nowISO(),a.id,id,JSON.stringify(access)]);await audit(c,a,'article.pdf_uploaded',id,{sha256:fullSha,bytes:bytes.length,pages,previousAccess:JSON.parse(r.access_json),access,policy:'new-pdf-default-v1'});return {articleId:id,revision:b.revision+1,document:{filename,bytes:bytes.length,pages,previewPages:Math.min(10,pages)}};
 });}finally{pdfBusy=false;}
 }
 };
}
