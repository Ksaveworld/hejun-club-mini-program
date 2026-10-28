import {readExtra,normalizeOfficialArticleUrl} from './article-placement-extra.mjs';
import {randomUUID} from 'node:crypto';
import {readFile} from 'node:fs/promises';
import {readFileSync} from 'node:fs';
import {postgresTransaction,safeInteger} from './postgres.mjs';
import {requireRule,nowISO,validateKey,textField,digest} from './domain.mjs';
import {canRead as canReadResource,prepareResourceContent,resourceAccessPolicy,resourceAction} from './resources.mjs';
import {canRead as canReadArticle,accessPolicy,prepareArticleContent} from './articles.mjs';
import {prepareActivity} from './activities.mjs';
import {sendDocumentRow} from './article-documents.mjs';
import {sendPostgresReport} from './postgres-report-store.mjs';
import {isOperationalAccount} from './collaboration/grant-identity.mjs';

export const postVersionMigrationMarker={key:'_club_post_versions_migration',value:'004-post-versions-v1'};
export const postVersionTables=['_club_post_versions','_club_post_revision_heads','_club_post_review_receipts'];
const postVersionSql=readFileSync(new URL('./migrations/postgres/004-post-versions.sql',import.meta.url),'utf8');
function postVersionSchema(schema){requireRule(/^club_migration_[a-z0-9_]{1,40}$/.test(schema||''),'需要指定迁移隔离区');}
export async function postVersionMigrationTables(client,schema){
  postVersionSchema(schema);
  const marker=(await client.query('SELECT value FROM settings WHERE key=$1',[postVersionMigrationMarker.key])).rows[0];
  const names=(await client.query('SELECT tablename FROM pg_tables WHERE schemaname=$1',[schema])).rows.map(row=>row.tablename),found=postVersionTables.filter(name=>names.includes(name));
  requireRule(!marker?found.length===0:marker.value===postVersionMigrationMarker.value&&found.length===postVersionTables.length,'投稿版本迁移标记或表集合不一致',503);
  return marker?[...postVersionTables]:[];
}
export async function initializePostgresPostVersions(pool,{schema}={}){
  postVersionSchema(schema);
  return postgresTransaction(pool,async c=>{
    await c.query(`SET LOCAL search_path TO "${schema}"`);await c.query('LOCK TABLE settings IN SHARE ROW EXCLUSIVE MODE');
    const existing=await postVersionMigrationTables(c,schema);
    if(existing.length)return {initialized:false,version:postVersionMigrationMarker.value};
    await c.query('LOCK TABLE posts IN SHARE ROW EXCLUSIVE MODE');await c.query(postVersionSql);
    return {initialized:true,version:postVersionMigrationMarker.value,tables:[...postVersionTables],legacyPostsPreserved:true};
  });
}

export function createPostgresContent(pool,{schema,documentsDirectory,reportStorage,postVersions=false,entitlementResolver}={}){
  requireRule(/^club_migration_[a-z0-9_]{1,40}$/.test(schema||''),'需要指定迁移隔离区');
  requireRule(entitlementResolver===undefined||typeof entitlementResolver==='function','会员权益解析器配置不正确',503);
  const run=(fn,write=false)=>postgresTransaction(pool,async c=>{
    // Read related access, membership and file metadata from one consistent snapshot.
    if(!write)await c.query('SET TRANSACTION ISOLATION LEVEL REPEATABLE READ READ ONLY');
    await c.query(`SET LOCAL search_path TO "${schema}"`);
    if(write)await c.query('LOCK TABLE users IN SHARE ROW EXCLUSIVE MODE');
    return fn(c);
  });
  const one=async(c,sql,args=[])=>(await c.query(sql,args)).rows[0];
  async function member(c,user){
    if(!user)return null;
    if(entitlementResolver){
      const current=user.role==='member'&&await one(c,"SELECT id FROM users WHERE id=$1 AND role='member'",[user.id]);
      if(!current||await isOperationalAccount(c,user.id))return null;
      const entitlement=await entitlementResolver(c,user.id,nowISO());
      requireRule(entitlement&&typeof entitlement.active==='boolean'&&Array.isArray(entitlement.planIds),'会员权益暂时不可读取',503);
      return {active:entitlement.active,planIds:entitlement.planIds,consumerVerified:true};
    }
    const row=await one(c,'SELECT * FROM memberships WHERE user_id=$1',[user.id]),now=nowISO();
    return row?{planId:row.plan_id,active:row.starts_at<=now&&row.expires_at>now}:null;
  }
  function canConsume(row,user,membership,parsePolicy,legacy){
    if(!entitlementResolver)return legacy(row,user,membership);
    if(row?.status!=='published')return false;
    let policy;try{policy=parsePolicy(JSON.parse(row.access_json));}catch{return false;}
    return policy.visibility==='public'||policy.visibility==='plans'&&user?.role==='member'&&membership?.consumerVerified===true&&
      membership.active===true&&policy.planIds.some(id=>membership.planIds.includes(id));
  }
  const canConsumeArticle=(row,user,membership)=>canConsume(row,user,membership,accessPolicy,canReadArticle);
  const canConsumeResource=(row,user,membership)=>canConsume(row,user,membership,resourceAccessPolicy,canReadResource);
  const summary=r=>({id:r.id,title:r.title,summary:r.summary,category:r.category,publishedAt:r.published_at});
  const activity=r=>({id:r.id,...JSON.parse(r.content_json),status:r.status,revision:safeInteger(r.revision),publishedAt:r.published_at});
  const post=r=>({id:r.id,userId:r.user_id,title:r.title,body:r.body,status:r.status,reason:r.reason,createdAt:r.created_at,reviewedAt:r.reviewed_at});
  async function versioning(c){
    if(!postVersions)return false;
    const marker=await one(c,'SELECT value FROM settings WHERE key=$1',[postVersionMigrationMarker.key]);
    if(!marker)return false;
    requireRule(marker.value===postVersionMigrationMarker.value,'投稿版本迁移标记不一致',503);return true;
  }
  async function activeAuthor(c,user){
    requireRule(user?.role==='member'&&await one(c,"SELECT 1 FROM users WHERE id=$1 AND role='member'",[user.id])&&(await member(c,user))?.active,'开通且在有效期内的会员才能新增或修改投稿',403);
  }
  const versionView=r=>({revision:safeInteger(r.revision),title:r.title,body:r.body,status:r.status,reason:r.reason,createdAt:r.created_at,reviewedAt:r.reviewed_at,reviewedBy:r.reviewed_by});
  async function versionedPost(c,row,{canEdit=false,receiptVersion}={}){
    const head=await one(c,'SELECT * FROM _club_post_revision_heads WHERE post_id=$1',[row.id]);
    if(!head)return {...post(row),versioning:false,canEdit:false};
    const versions=(await c.query('SELECT * FROM _club_post_versions WHERE post_id=$1 ORDER BY revision',[row.id])).rows;
    const current=versions.find(v=>safeInteger(v.revision)===(receiptVersion??safeInteger(head.latest_revision)));
    requireRule(current,'稿件版本不完整，请核对后重试',503);
    const published= row.status==='published'&&versions.find(v=>safeInteger(v.revision)===Number(head.published_revision));
    return {...post(row),...versionView(current),id:row.id,userId:row.user_id,createdAt:row.created_at,updatedAt:current.created_at,versioning:true,canEdit,
      latestRevision:safeInteger(head.latest_revision),publishedRevision:head.published_revision===null?null:safeInteger(head.published_revision),
      publishedVersion:published?versionView(published):null,removalReason:head.removal_reason,removedAt:head.removed_at,
      versions:versions.map(v=>({...versionView(v),current:safeInteger(v.revision)===safeInteger(head.latest_revision)}))};
  }
  async function ownedPosts(c,user,rows){
    const canEdit=user?.role==='member'&&(await member(c,user))?.active===true;
    return Promise.all(rows.map(row=>versionedPost(c,row,{canEdit})));
  }
  async function submitVersion(c,row,title,content,key,hash,revision,now){
    await c.query("INSERT INTO _club_post_versions(post_id,revision,user_id,title,body,status,created_at,idempotency_key,request_hash) VALUES($1,$2,$3,$4,$5,'pending',$6,$7,$8)",[row.id,revision,row.user_id,title,content,now,key,hash]);
  }
  const managedKinds={
    articles:{table:'articles',label:'内容',action:'article',prepare:prepareArticleContent},
    resources:{table:'service_resources',label:'服务',action:'resource',prepare:prepareResourceContent},
    activities:{table:'activities',label:'活动',action:'activity',prepare:prepareActivity}
  };
  function managedKind(kind){requireRule(Object.hasOwn(managedKinds,kind),'管理分类不正确');return managedKinds[kind];}
  async function editor(c,actor){
    requireRule(actor?.role==='admin'&&await one(c,"SELECT 1 FROM users WHERE id=$1 AND role='admin'",[actor.id]),'需要管理员权限',403);
  }
  const audit=(c,actor,action,id,detail)=>c.query('INSERT INTO audit_log(actor_id,action,target_id,detail,created_at) VALUES($1,$2,$3,$4,$5)',[actor.id,action,id,JSON.stringify(detail),nowISO()]);
  async function documentInfo(c,id){
    const doc=await one(c,'SELECT * FROM article_documents WHERE article_id=$1',[id]);
    if(!doc)return null;
    const preview=await one(c,'SELECT pages FROM report_previews WHERE article_id=$1',[id]);
    return {filename:doc.filename,bytes:safeInteger(doc.byte_size),pages:safeInteger(doc.pages),previewPages:preview?safeInteger(preview.pages):0};
  }
  async function managedView(c,kind,row){
    if(kind==='activities')return activity(row);
    return {...summary(row),body:row.body,access:JSON.parse(row.access_json),status:row.status,revision:safeInteger(row.revision),
      createdAt:row.created_at,updatedAt:row.updated_at,...(kind==='articles'?{document:await documentInfo(c,row.id)}:{action:JSON.parse(row.action_json)})};
  }
  async function managedRow(c,kind,id,revision){
    const descriptor=managedKind(kind),row=await one(c,`SELECT * FROM ${descriptor.table} WHERE id=$1 FOR UPDATE`,[id]);
    requireRule(row,descriptor.label+'不存在',404);
    requireRule(!await one(c,'SELECT 1 FROM settings WHERE key=$1',['_club_deleted:'+kind+':'+id]),'草稿已删除',410);
    requireRule(Number.isSafeInteger(revision)&&safeInteger(row.revision)===revision,descriptor.label+'已变化，请刷新后重新操作',409);return row;
  }
  async function articleState(c,user,row,membership){
    if(!row)return null;
    const doc=await one(c,'SELECT * FROM article_documents WHERE article_id=$1',[row.id]);
    const preview=doc?await one(c,'SELECT * FROM report_previews WHERE article_id=$1',[row.id]):null;
    return assembleArticleState(user,row,membership,doc,preview);
  }
  function assembleArticleState(user,row,membership,doc,preview){
    let policy;try{policy=accessPolicy(JSON.parse(row.access_json));}catch{policy=null;}
    const published=row.status==='published';
    const full=canConsumeArticle(row,user,membership);
    const catalog=published&&!!doc&&policy?.visibility==='plans';
    const canPreview=catalog&&policy.previewPages===10&&Number(preview?.pages)>0;
    return {row,doc,preview,full,canPreview,visible:full||catalog||canPreview,
      info:doc?{filename:doc.filename,bytes:safeInteger(doc.byte_size),pages:safeInteger(doc.pages),previewPages:canPreview&&preview?safeInteger(preview.pages):0}:null};
  }
  const api={
    activities:()=>run(async c=>(await c.query("SELECT * FROM activities WHERE status='published' ORDER BY content_json::jsonb->>'startAt' DESC NULLS LAST,id")).rows.map(activity)),
    activity:id=>run(async c=>{const r=await one(c,"SELECT * FROM activities WHERE id=$1 AND status='published'",[id]);requireRule(r,'活动不存在或已撤下',404);return activity(r);}),
    async poster(id,res){
      const row=await api.activity(id);requireRule(/^images\/[a-z0-9-]+\.(jpg|png|webp)$/.test(row.posterUrl||''),'此活动没有已发布原图',404);
      let bytes;try{bytes=await readFile(new URL('../public/'+row.posterUrl,import.meta.url));}catch{requireRule(false,'文件暂时不可读取，请稍后重试',503);}
      res.writeHead(200,{'Content-Type':{jpg:'image/jpeg',png:'image/png',webp:'image/webp'}[row.posterUrl.split('.').at(-1)],'Content-Length':bytes.length,'Cache-Control':'no-store','X-Content-Type-Options':'nosniff'});res.end(bytes);
    },
    resources:user=>run(async c=>{const m=await member(c,user),rows=(await c.query("SELECT * FROM service_resources WHERE status='published' ORDER BY published_at DESC,id")).rows.filter(r=>canConsumeResource(r,user,m));return {resources:rows.slice(0,100).map(summary),hasMore:rows.length>100};}),
    resource:(user,id)=>run(async c=>{const r=await one(c,'SELECT * FROM service_resources WHERE id=$1',[id]);requireRule(r&&canConsumeResource(r,user,await member(c,user)),'服务不存在或当前不可使用',404);return {...summary(r),body:r.body,action:JSON.parse(r.action_json),revision:safeInteger(r.revision)};}),
    articles:(user,after)=>run(async c=>{
      requireRule(after===undefined||/^[a-f0-9-]{36}$/.test(after),'资料翻页标记不正确');
      const m=await member(c,user),rows=(await c.query("SELECT * FROM articles WHERE status='published' ORDER BY published_at DESC,id")).rows,result=[];
      // Read only catalog metadata in batches, within the same permission snapshot.
      const ids=rows.map(row=>row.id);
      const docs=new Map((ids.length?(await c.query('SELECT article_id,filename,byte_size,pages FROM article_documents WHERE article_id = ANY($1::text[])',[ids])).rows:[]).map(row=>[row.article_id,row]));
      const previews=new Map((ids.length?(await c.query('SELECT article_id,pages FROM report_previews WHERE article_id = ANY($1::text[])',[ids])).rows:[]).map(row=>[row.article_id,row]));
      let cursorFound=after===undefined;
      for(const r of rows){const doc=docs.get(r.id),state=assembleArticleState(user,r,m,doc,doc?previews.get(r.id):null);
        if(!state.visible)continue;
        if(!cursorFound){if(r.id===after)cursorFound=true;continue;}
        result.push({...summary(r),fullAccess:state.full,document:state.info});if(result.length>100)break;
      }
      requireRule(cursorFound,'资料目录已变化，请刷新后重试',409);
      const articles=result.slice(0,100),hasMore=result.length>100;
      return {articles,hasMore,nextCursor:hasMore?articles.at(-1).id:null};
    }),
    article:(user,id)=>run(async c=>{const s=await articleState(c,user,await one(c,'SELECT * FROM articles WHERE id=$1',[id]),await member(c,user));requireRule(s?.visible,'内容不存在或当前不可阅读',404);const extra=await readExtra(c,id);const originalUrl=s.row.status==='published'&&s.full&&!s.doc&&JSON.parse(s.row.access_json).visibility==='public'?(normalizeOfficialArticleUrl(extra.originalUrl)||''):'';return {...summary(s.row),body:s.full?s.row.body:'',fullAccess:s.full,document:s.info,originalUrl};}),
    async document(user,id,preview,req,res){
      const row=await run(async c=>{
        const s=await articleState(c,user,await one(c,'SELECT * FROM articles WHERE id=$1',[id]),await member(c,user));
        requireRule(preview?s?.canPreview:s?.full,'内容不存在或当前不可阅读',404);
        const r=preview?s.preview:s.doc;requireRule(r,'报告原件不存在',404);
        return {...r,filename:preview?'试看-'+s.doc.filename:r.filename,byte_size:safeInteger(r.byte_size)};
      });
      return reportStorage==='postgres'?sendPostgresReport(pool,{schema},row,req,res):sendDocumentRow(row,documentsDirectory,req,res);
    },
    publicationPolicy:'manual-review-v1',
    posts:(user,own=false)=>run(async c=>{
      requireRule(user,'请先登录',401);const rows=await c.query(own?'SELECT * FROM posts WHERE user_id=$1 ORDER BY created_at DESC':"SELECT * FROM posts WHERE status='published' ORDER BY created_at DESC LIMIT 100",own?[user.id]:[]);
      const enabled=await versioning(c);
      if(own&&enabled)return ownedPosts(c,user,rows.rows);
      if(!enabled)return rows.rows.map(r=>({...post(r),versioning:false,canEdit:false}));
      const results=[];
      for(const row of rows.rows){const head=await one(c,'SELECT published_revision FROM _club_post_revision_heads WHERE post_id=$1',[row.id]);results.push({...post(row),revision:head?.published_revision===null?undefined:head?safeInteger(head.published_revision):undefined});}
      return results;
    }),
    publish:(user,body,key)=>run(async c=>{
      await activeAuthor(c,user);validateKey(key);
      const title=textField(body.title,'标题',60,true),content=textField(body.body,'正文',2000,true);
      const enabled=await versioning(c);
      if(enabled){
        const saved=await one(c,'SELECT * FROM _club_post_versions WHERE user_id=$1 AND idempotency_key=$2',[user.id,key]);
        if(saved){requireRule(safeInteger(saved.revision)===1&&saved.title===title&&saved.body===content,'提交编号已用于其他内容',409);return versionedPost(c,await one(c,'SELECT * FROM posts WHERE id=$1',[saved.post_id]),{canEdit:true});}
      }
      const previous=await one(c,'SELECT * FROM posts WHERE user_id=$1 AND idempotency_key=$2',[user.id,key]);
      if(previous){requireRule(previous.title===title&&previous.body===content,'提交编号已用于其他内容',409);return post(previous);}
      const id=randomUUID(),now=nowISO();
      const row=await one(c,"INSERT INTO posts(id,user_id,title,body,status,created_at,idempotency_key) VALUES($1,$2,$3,$4,'pending',$5,$6) RETURNING *",[id,user.id,title,content,now,key]);
      if(enabled){await submitVersion(c,row,title,content,key,digest(JSON.stringify({title,body:content})),1,now);await c.query('INSERT INTO _club_post_revision_heads(post_id,latest_revision,updated_at) VALUES($1,1,$2)',[id,now]);}
      await c.query('INSERT INTO audit_log(actor_id,action,target_id,detail,created_at) VALUES($1,$2,$3,$4,$5)',[user.id,'post.submitted',id,JSON.stringify({policy:'member-review-v1'}),now]);return enabled?versionedPost(c,row,{canEdit:true}):post(row);
    },true),
    editPost:(user,id,body,key)=>run(async c=>{
      await activeAuthor(c,user);validateKey(key);requireRule(await versioning(c),'修改复审尚未初始化，原投稿与公开版本继续保留',503);
      requireRule(body&&Object.keys(body).every(name=>['title','body','revision'].includes(name)),'修改稿不能改变作者、审核或公开状态',400);
      const title=textField(body.title,'标题',60,true),content=textField(body.body,'正文',2000,true);requireRule(Number.isSafeInteger(body.revision)&&body.revision>0,'缺少当前稿件版本，请刷新后修改',400);
      const row=await one(c,'SELECT * FROM posts WHERE id=$1 AND user_id=$2 FOR UPDATE',[id,user.id]);requireRule(row,'本人稿件不存在',404);
      const hash=digest(JSON.stringify({id,title,body:content,revision:body.revision}));
      const saved=await one(c,'SELECT * FROM _club_post_versions WHERE user_id=$1 AND idempotency_key=$2',[user.id,key]);
      if(saved){requireRule(saved.post_id===id&&saved.request_hash===hash,'提交编号已用于其他修改稿',409);return versionedPost(c,row,{canEdit:true,receiptVersion:safeInteger(saved.revision)});}
      const head=await one(c,'SELECT * FROM _club_post_revision_heads WHERE post_id=$1 FOR UPDATE',[id]);requireRule(head,'此稿件版本尚未初始化，请由运营核对',503);
      requireRule(safeInteger(head.latest_revision)===body.revision,'稿件已变化，请重新读取最新版本再修改',409);
      const revision=body.revision+1;requireRule(Number.isSafeInteger(revision),'稿件版本超出安全范围',409);const now=nowISO();
      await submitVersion(c,row,title,content,key,hash,revision,now);await c.query('UPDATE _club_post_revision_heads SET latest_revision=$1,updated_at=$2 WHERE post_id=$3',[revision,now,id]);
      await audit(c,user,'post.revision_submitted',id,{revision,previousRevision:body.revision,policy:'member-edit-review-v1'});
      return versionedPost(c,row,{canEdit:true});
    },true),
    managed:(actor,kind)=>run(async c=>{
      const descriptor=managedKind(kind);await editor(c,actor);
      const rows=(await c.query(`SELECT * FROM ${descriptor.table} t WHERE NOT EXISTS (SELECT 1 FROM settings s WHERE s.key='_club_deleted:${kind}:'||t.id) ORDER BY updated_at DESC,id`)).rows;
      return Promise.all(rows.map(row=>managedView(c,kind,row)));
    }),
    saveManaged:(actor,kind,input,key,id)=>run(async c=>{
      const descriptor=managedKind(kind);await editor(c,actor);
      const fields=descriptor.prepare(input),hash=digest(JSON.stringify(fields));
      if(!id){
        validateKey(key);const previous=await one(c,`SELECT * FROM ${descriptor.table} WHERE created_by=$1 AND idempotency_key=$2`,[actor.id,key]);
        if(previous){requireRule(!await one(c,'SELECT 1 FROM settings WHERE key=$1',['_club_deleted:'+kind+':'+previous.id]),'原草稿已删除，请新建草稿',410);requireRule(previous.creation_hash===hash,'提交编号已用于其他'+descriptor.label,409);return managedView(c,kind,previous);}
      }
      const now=nowISO();let row;
      if(id){
        row=await managedRow(c,kind,id,input.revision);requireRule(row.status==='draft','请先撤下'+descriptor.label+'，再修改并重新发布',409);
        if(kind==='articles'&&(await readExtra(c,id)).originalUrl)requireRule(fields.access.visibility==='public','请先清空公众号原文链接，再调整阅读范围');
        if(kind==='articles'&&fields.access.previewPages)requireRule((await documentInfo(c,id))?.previewPages>0,'请先生成报告试看文件');
        if(kind==='activities')await c.query('UPDATE activities SET content_json=$1,revision=revision+1,updated_at=$2 WHERE id=$3',[JSON.stringify(fields),now,id]);
        else await c.query(`UPDATE ${descriptor.table} SET title=$1,summary=$2,body=$3,category=$4,access_json=$5,revision=revision+1,updated_by=$6,updated_at=$7${kind==='resources'?',action_json=$9':''} WHERE id=$8`,
          [fields.title,fields.summary,fields.body,fields.category,JSON.stringify(fields.access),actor.id,now,id,...(kind==='resources'?[JSON.stringify(fields.action)]:[])]);
      }else{
        id=randomUUID();
        if(kind==='activities')await c.query("INSERT INTO activities(id,content_json,status,revision,created_by,created_at,updated_at,idempotency_key,creation_hash) VALUES($1,$2,'draft',1,$3,$4,$4,$5,$6)",[id,JSON.stringify(fields),actor.id,now,key,hash]);
        else await c.query(`INSERT INTO ${descriptor.table}(id,title,summary,body,category,access_json,status,revision,created_by,updated_by,created_at,updated_at,idempotency_key,creation_hash${kind==='resources'?',action_json':''}) VALUES($1,$2,$3,$4,$5,$6,'draft',1,$7,$7,$8,$8,$9,$10${kind==='resources'?',$11':''})`,
          [id,fields.title,fields.summary,fields.body,fields.category,JSON.stringify(fields.access),actor.id,now,key,hash,...(kind==='resources'?[JSON.stringify(fields.action)]:[])]);
      }
      const result=await managedView(c,kind,await one(c,`SELECT * FROM ${descriptor.table} WHERE id=$1`,[id]));
      await audit(c,actor,descriptor.action+(kind==='activities'?'.saved':row?'.updated':'.created'),id,{revision:result.revision,...(!row&&kind!=='activities'?{category:fields.category}:{})});return result;
    },true),
    deleteDraft:(actor,kind,id,revision)=>run(async c=>{
      requireRule(['articles','activities'].includes(kind),'此分类不支持删除');await editor(c,actor);
      const row=await managedRow(c,kind,id,revision);requireRule(row.status==='draft','已发布内容不能删除，请先撤下',409);
      await c.query('INSERT INTO settings(key,value) VALUES($1,$2)',['_club_deleted:'+kind+':'+id,JSON.stringify({at:nowISO(),actorId:actor.id,revision})]);
      await audit(c,actor,managedKind(kind).action+'.draft_deleted',id,{revision,originalRetained:true});return {id,deleted:true};
    },true),
    transitionManaged:(actor,kind,id,action,revision)=>run(async c=>{
      const descriptor=managedKind(kind);await editor(c,actor);requireRule(['publish','unpublish'].includes(action),'操作不正确');
      const row=await managedRow(c,kind,id,revision);requireRule(row.status===(action==='publish'?'draft':'published'),descriptor.label+'状态已变化，请刷新',409);
      if(action==='publish'){
        if(kind==='activities'){
          const fields=prepareActivity(JSON.parse(row.content_json));requireRule(fields.body&&fields.startAt&&fields.endAt&&fields.location&&fields.organizer,'发布前请补齐时间、地点、主办方及活动详情');requireRule(Date.parse(fields.endAt)>Date.now(),'已结束的活动不能新发布');
        }else{
          const access=JSON.parse(row.access_json),policy=kind==='articles'?accessPolicy(access):resourceAccessPolicy(access);
          requireRule(policy.visibility!=='unconfigured','请先明确'+(kind==='articles'?'阅读':'使用')+'范围');requireRule(row.body.trim().length>0,'请先填写'+(kind==='articles'?'正文':'服务说明'));
          if(kind==='articles'&&(await readExtra(c,id)).originalUrl)requireRule(policy.visibility==='public','公众号原文内容须公开，不能改变为会员限定');
          if(kind==='articles'&&policy.previewPages)requireRule((await documentInfo(c,id))?.previewPages>0,'报告试看文件未准备好');
          if(kind==='resources')requireRule(resourceAction(JSON.parse(row.action_json)).type!=='unconfigured','请先配置使用入口');
        }
      }
      const now=nowISO();await c.query(`UPDATE ${descriptor.table} SET status=$1,revision=revision+1,updated_at=$2,published_at=$3${kind==='activities'?'':',updated_by=$5'} WHERE id=$4`,
        [action==='publish'?'published':'draft',now,action==='publish'?now:row.published_at,id,...(kind==='activities'?[]:[actor.id])]);
      await audit(c,actor,descriptor.action+'.'+action,id,{revision:safeInteger(row.revision)+1,...(kind==='activities'?{}:{access:JSON.parse(row.access_json)})});
      return managedView(c,kind,await one(c,`SELECT * FROM ${descriptor.table} WHERE id=$1`,[id]));
    },true),
    async managedDocument(actor,id,req,res){
      const row=await run(async c=>{await editor(c,actor);const doc=await one(c,'SELECT * FROM article_documents WHERE article_id=$1',[id]);requireRule(doc,'报告原件不存在',404);return {...doc,byte_size:safeInteger(doc.byte_size)};});
      if(reportStorage==='postgres')return sendPostgresReport(pool,{schema},row,req,res);
      return sendDocumentRow(row,documentsDirectory,req,res);
    },
    managedPosts:actor=>run(async c=>{await editor(c,actor);const rows=(await c.query('SELECT * FROM posts ORDER BY created_at DESC,id')).rows;return await versioning(c)?Promise.all(rows.map(row=>versionedPost(c,row))):rows.map(row=>({...post(row),versioning:false,canEdit:false}));}),
    moderatePost:(actor,id,body,key)=>run(async c=>{
      await editor(c,actor);
      if(await versioning(c)){
        requireRule(body&&Object.keys(body).every(name=>['status','reason','revision','action','publishedRevision'].includes(name)),'审核参数不正确',400);
        const removing=body.action==='remove';requireRule(removing||['published','rejected'].includes(body.status),'审核状态不正确');
        requireRule(body.action===undefined||removing,'审核操作不正确');
        const reason=textField(body.reason??'','审核说明',500,removing||body.status==='rejected');
        const row=await one(c,'SELECT * FROM posts WHERE id=$1 FOR UPDATE',[id]);requireRule(row,'投稿不存在',404);
        const head=await one(c,'SELECT * FROM _club_post_revision_heads WHERE post_id=$1 FOR UPDATE',[id]);requireRule(head,'稿件版本未初始化，请核对',503);
        const revision=safeInteger(head.latest_revision),expected=body.revision??(revision===1?1:undefined);
        requireRule(Number.isSafeInteger(expected)&&expected>0,'缺少待审稿件版本，请刷新后审核',400);
        const hash=digest(JSON.stringify({id,status:body.status,reason,revision:expected,action:body.action,publishedRevision:body.publishedRevision}));
        if(key){validateKey(key);const saved=await one(c,'SELECT * FROM _club_post_review_receipts WHERE actor_id=$1 AND idempotency_key=$2',[actor.id,key]);if(saved){requireRule(saved.request_hash===hash,'审核编号已用于其他操作',409);return saved.result_json;}}
        requireRule(expected===revision,'稿件版本已变化，请重新读取待审版本',409);
        const version=await one(c,'SELECT * FROM _club_post_versions WHERE post_id=$1 AND revision=$2 FOR UPDATE',[id,revision]);requireRule(version,'稿件版本不完整',503);
        const legacyRemoval=!removing&&body.status==='rejected'&&version.status==='published';
        if(removing||legacyRemoval){
          requireRule(row.status==='published'&&head.published_revision!==null,'稿件没有正在公开的版本',409);
          if(body.publishedRevision!==undefined)requireRule(body.publishedRevision===safeInteger(head.published_revision),'公开版本已变化，请重新读取',409);
          const now=nowISO();await c.query("UPDATE posts SET status='rejected',reason=$1,reviewed_by=$2,reviewed_at=$3 WHERE id=$4",[reason,actor.id,now,id]);
          await c.query('UPDATE _club_post_revision_heads SET removal_reason=$1,removed_by=$2,removed_at=$3,updated_at=$3 WHERE post_id=$4',[reason,actor.id,now,id]);
          await audit(c,actor,'post.removed',id,{reason,revision,publishedRevision:safeInteger(head.published_revision)});
        }else if(version.status===body.status&&(version.reason||'')===reason){
          // A repeated completed review has no second audit entry.
        }else{
          requireRule(version.status==='pending','该修改版本已审核，请重新读取',409);const now=nowISO();
          await c.query('UPDATE _club_post_versions SET status=$1,reason=$2,reviewed_by=$3,reviewed_at=$4 WHERE post_id=$5 AND revision=$6',[body.status,reason,actor.id,now,id,revision]);
          if(body.status==='published'){
            await c.query("UPDATE posts SET title=$1,body=$2,status='published',reason=$3,reviewed_by=$4,reviewed_at=$5 WHERE id=$6",[version.title,version.body,reason,actor.id,now,id]);
            await c.query('UPDATE _club_post_revision_heads SET published_revision=$1,updated_at=$2,removal_reason=NULL,removed_by=NULL,removed_at=NULL WHERE post_id=$3',[revision,now,id]);
          }else if(head.published_revision===null){await c.query("UPDATE posts SET title=$1,body=$2,status='rejected',reason=$3,reviewed_by=$4,reviewed_at=$5 WHERE id=$6",[version.title,version.body,reason,actor.id,now,id]);}
          await audit(c,actor,body.status==='published'?'post.published':'post.rejected',id,{reason,revision});
        }
        const result={ok:true,post:await versionedPost(c,await one(c,'SELECT * FROM posts WHERE id=$1',[id]))};
        if(key)await c.query('INSERT INTO _club_post_review_receipts(actor_id,idempotency_key,request_hash,post_id,result_json,created_at) VALUES($1,$2,$3,$4,$5,$6)',[actor.id,key,hash,id,JSON.stringify(result),nowISO()]);
        return result;
      }
      await editor(c,actor);requireRule(['published','rejected'].includes(body.status),'审核状态不正确');const reason=textField(body.reason??'','审核说明',500,body.status==='rejected');
      const row=await one(c,'SELECT * FROM posts WHERE id=$1 FOR UPDATE',[id]);requireRule(row,'投稿不存在',404);
      if(row.status===body.status&&(row.reason||'')===reason)return {ok:true};
      requireRule(row.status==='pending'||(row.status==='published'&&body.status==='rejected'),'稿件状态已变化，请刷新查看',409);
      await c.query('UPDATE posts SET status=$1,reason=$2,reviewed_by=$3,reviewed_at=$4 WHERE id=$5',[body.status,reason,actor.id,nowISO(),id]);await audit(c,actor,body.status==='rejected'?(row.status==='pending'?'post.rejected':'post.removed'):'post.published',id,{reason});return {ok:true};
    },true)
  };
  return api;
}
