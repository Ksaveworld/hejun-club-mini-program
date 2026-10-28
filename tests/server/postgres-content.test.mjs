import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync,mkdtempSync,writeFileSync,rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {randomUUID,createHash} from 'node:crypto';
import {request} from 'node:http';
import {PGlite} from '@electric-sql/pglite';
import {createPostgresContent} from '../../server/postgres-content.mjs';
import {createPostgresCore} from '../../server/postgres-core.mjs';
import {createPostgresApplication} from '../../server/postgres-app.mjs';
import {createPostgresAdmin} from '../../server/postgres-admin.mjs';
import {hashPassword} from '../../server/domain.mjs';
import {campaignState} from '../../server/campaign.mjs';

async function fixture(t){
  const pg=new PGlite({parsers:{20:v=>BigInt(v)}});await pg.waitReady;
  const schema='club_migration_content',appId='wx47d5e3e20fd77f65',dir=mkdtempSync(join(tmpdir(),'pg-content-'));
  await pg.exec(`CREATE SCHEMA ${schema}; SET search_path TO ${schema};`+readFileSync(new URL('../../server/migrations/postgres/001-baseline.sql',import.meta.url),'utf8'));
  let tail=Promise.resolve();const fail={audit:false};
  const pool={connect:async()=>{const previous=tail;let release;tail=new Promise(ok=>release=ok);await previous;return {query:(s,a)=>{if(fail.audit&&s.startsWith('INSERT INTO audit_log'))throw Error('audit failure');return pg.query(s,a);},release};}};
  const core=createPostgresCore(pool,{schema,appId}),content=createPostgresContent(pool,{schema,documentsDirectory:dir});
  const adapter={configured:true,appId,exchangeCode:async code=>({appId,openId:code})};
  const session=await core.login({code:'content_member',consent:true},adapter),user=await core.authenticate(session.accessToken);
  const second=await core.login({code:'other_member',consent:true},adapter),other=await core.authenticate(second.accessToken);
  const admin={id:randomUUID(),username:'content_admin',role:'admin'};
  await pg.query('INSERT INTO users(id,username,password_hash,role,created_at,referral_code,consent_version) VALUES($1,$2,$3,$4,$5,$6,$7)',[admin.id,admin.username,await hashPassword('IsolatedAdmin123'),'admin','2026-01-01','AD0001','isolated']);
  const activate=async()=>{const order=await core.createOrder(user,{planId:'basic',consent:true,form:{name:'隔离',phone:'13800000000',city:'上海'}},randomUUID());await pg.query("UPDATE orders SET status='paid' WHERE id=$1",[order.id]);await pg.query('INSERT INTO memberships VALUES($1,$2,$3,$4,$5)',[user.id,order.id,'basic','2020-01-01','2099-01-01']);};
  const seed=async(table,access,status='published')=>{const id=randomUUID();await pg.query(`INSERT INTO ${table}(id,title,summary,body,category,access_json,status,revision,created_by,updated_by,created_at,updated_at,published_at,idempotency_key,creation_hash${table==='service_resources'?',action_json':''}) VALUES($1,'标题','摘要','受限正文',$2,$3,$4,1,$5,$5,'2026-01-01','2026-01-01','2026-01-01',$6,'fixture'${table==='service_resources'?',\'{"type":"phone","phoneNumber":"13800000000"}\'':''})`,[id,table==='articles'?'knowledge':'directory',JSON.stringify(access),status,user.id,randomUUID()]);return id;};
  t.after(async()=>{await pg.close();rmSync(dir,{recursive:true,force:true});});
  return {pg,pool,schema,core,content,user,other,admin,session,activate,seed,dir,fail};
}
test('PG content permissions preserve catalog/preview/full, expiry, unpublished state and HTTP file ranges',async t=>{
  const f=await fixture(t),{pg,content,core,user,seed}=f;
  const report=await seed('articles',{visibility:'plans',planIds:['basic'],previewPages:10});
  const hidden=await seed('articles',{visibility:'public',planIds:[]},'draft');
  const resource=await seed('service_resources',{visibility:'plans',planIds:['basic']});
  const full=Buffer.from('%PDF-full-secret'),preview=Buffer.from('%PDF-preview');
  const save=bytes=>{const hash=createHash('sha256').update(bytes).digest('hex');writeFileSync(join(f.dir,hash+'.pdf'),bytes);return hash;};
  await pg.query('INSERT INTO article_documents VALUES($1,$2,$3,$4,12,$5)',[report,save(full),'报告.pdf',full.length,'2026-01-01']);
  await pg.query('INSERT INTO report_previews VALUES($1,$2,$3,10)',[report,save(preview),preview.length]);
  assert.equal((await content.article(null,report)).body,'');assert.equal((await content.articles(null)).articles.length,1);
  await assert.rejects(content.article(null,hidden),/不可阅读/);await assert.rejects(content.resource(user,resource),/不可使用/);
  await f.activate();assert.equal((await content.article(user,report)).fullAccess,true);assert.equal((await content.resources(user)).resources.length,1);
  await pg.query("UPDATE memberships SET plan_id='star' WHERE user_id=$1",[user.id]);assert.equal((await content.article(user,report)).fullAccess,false);
  await pg.query("UPDATE memberships SET plan_id='basic' WHERE user_id=$1",[user.id]);
  const server=createPostgresApplication({core,content,hosts:['127.0.0.1']});await new Promise(ok=>server.listen(0,'127.0.0.1',ok));
  t.after(()=>new Promise(ok=>{server.closeAllConnections();server.close(ok);}));
  const get=(path,headers={})=>new Promise((resolve,reject)=>{const req=request({hostname:'127.0.0.1',port:server.address().port,path:'/api'+path,headers:{Host:'127.0.0.1',...headers}},res=>{const parts=[];res.on('data',b=>parts.push(b));res.on('end',()=>resolve({status:res.statusCode,bytes:Buffer.concat(parts)}));});req.on('error',reject);req.end();});
  const campaign=await get('/campaign');assert.equal(campaign.status,200);assert.equal(JSON.parse(campaign.bytes).campaign.id,campaignState().id);
  assert.equal((await get('/articles/'+report+'/document')).status,404);
  assert.deepEqual((await get('/articles/'+report+'/preview')).bytes,preview);
  const auth={Authorization:'Bearer '+f.session.accessToken};
  assert.deepEqual((await get('/articles/'+report+'/document',auth)).bytes,full);
  const range=await get('/articles/'+report+'/document',{...auth,Range:'bytes=0-4'});assert.equal(range.status,206);assert.equal(range.bytes.toString(),'%PDF-');
  assert.equal((await get('/articles/'+report+'/document',{...auth,Range:'bytes=999-'})).status,416);
  assert.equal((await get('/articles',{Authorization:'Bearer invalid'})).status,401);
  await pg.query("UPDATE memberships SET expires_at='2001-01-01' WHERE user_id=$1",[user.id]);assert.equal((await get('/articles/'+report+'/document',auth)).status,404);
  await pg.query("UPDATE articles SET status='draft' WHERE id=$1",[report]);assert.equal((await get('/articles/'+report+'/preview')).status,404);
});
test('PG member posts preserve ownership, idempotency, removed state and transactional rollback',async t=>{
  const {content,user,other,admin,activate,pg,fail}=await fixture(t),body={title:'标题',body:'正文'};
  await assert.rejects(content.publish(user,body,randomUUID()),/有效期/);await activate();
  fail.audit=true;await assert.rejects(content.publish(user,body,randomUUID()),/audit failure/);fail.audit=false;
  assert.equal((await content.posts(user,true)).length,0);
  const key=randomUUID(),p=await content.publish(user,body,key);assert.equal(p.status,'pending');
  assert.equal((await content.posts(user,true)).length,1);assert.equal((await content.posts(other,true)).length,0);assert.equal((await content.posts(other)).length,0);
  assert.equal((await content.publish(user,body,key)).id,p.id);
  await content.moderatePost(admin,p.id,{status:'published'});assert.equal((await content.posts(other)).length,1);
  await assert.rejects(content.publish(user,{...body,title:'不同'},key),/其他内容/);
  await pg.query("UPDATE posts SET status='rejected' WHERE id=$1",[p.id]);assert.equal((await content.publish(user,body,key)).status,'rejected');assert.equal((await content.posts(other)).length,0);
});
test('PG activities filter drafts and referral captures current state without changing pending order source',async t=>{
  const {pg,core,content,user,other}=await fixture(t);
  const id=randomUUID();await pg.query("INSERT INTO activities VALUES($1,$2,'published',1,$3,'2026','2026','2026',$4,'fixture')",[id,JSON.stringify({title:'活动',startAt:'2026-10-01',posterUrl:'images/caexpo-2026-schedule.jpg'}),user.id,randomUUID()]);
  assert.equal((await content.activities())[0].revision,1);assert.equal((await content.activity(id)).title,'活动');
  await pg.query("UPDATE activities SET status='draft' WHERE id=$1",[id]);assert.deepEqual(await content.activities(),[]);await assert.rejects(content.activity(id),/已撤下/);
  const result=await core.captureReferral(user,{code:other.referral_code});assert.equal(result.sourceCode,other.referral_code);
  await assert.rejects(core.captureReferral(other,{code:user.referral_code}),/循环/);
  await core.createOrder(user,{planId:'basic',consent:true,form:{name:'隔离',phone:'13800000000',city:'上海'}},randomUUID());
  await assert.rejects(core.captureReferral(user,{code:''}),/订单已保存/);
});

test('PG managed content preserves drafts, shared validation, revisions, retry and rollback across all three kinds',async t=>{
  const {pg,content,user,admin,fail}=await fixture(t);
  const inputs={
    articles:{title:'资讯',summary:'摘要',body:'正文',category:'news',access:{visibility:'public',planIds:[]}},
    resources:{title:'服务',summary:'摘要',body:'说明',category:'directory',access:{visibility:'public',planIds:[]},action:{type:'phone',phoneNumber:'13800000000'}},
    activities:{title:'活动',mode:'offline',body:'议程',startAt:'2099-01-01T09:00:00+08:00',endAt:'2099-01-01T11:00:00+08:00',location:'上海',organizer:'俱乐部'}
  };
  for(const [kind,input] of Object.entries(inputs)){
    await assert.rejects(content.managed(user,kind),/管理员/);
    await assert.rejects(content.saveManaged({...user,role:'admin'},kind,input,randomUUID()),/管理员/);
    fail.audit=true;await assert.rejects(content.saveManaged(admin,kind,input,randomUUID()),/audit failure/);fail.audit=false;
    assert.equal((await content.managed(admin,kind)).length,0);
    const key=randomUUID(),created=await content.saveManaged(admin,kind,input,key);
    assert.equal((await content.saveManaged(admin,kind,input,key)).id,created.id);
    await assert.rejects(content.saveManaged(admin,kind,{...input,title:'其他'},key),/其他/);
    const updated=await content.saveManaged(admin,kind,{...input,title:'修改后',revision:1},undefined,created.id);assert.equal(updated.revision,2);
    await assert.rejects(content.transitionManaged(admin,kind,created.id,'publish',1),/已变化/);
    fail.audit=true;await assert.rejects(content.transitionManaged(admin,kind,created.id,'publish',2),/audit failure/);fail.audit=false;
    assert.equal((await content.managed(admin,kind))[0].status,'draft');
    const published=await content.transitionManaged(admin,kind,created.id,'publish',2);assert.equal(published.status,'published');
    const visible=kind==='articles'?(await content.articles(null)).articles:kind==='resources'?(await content.resources(null)).resources:await content.activities();assert.equal(visible.length,1);
    await assert.rejects(content.saveManaged(admin,kind,{...input,revision:published.revision},undefined,created.id),/撤下/);
    await content.transitionManaged(admin,kind,created.id,'unpublish',published.revision);
    const hidden=kind==='articles'?(await content.articles(null)).articles:kind==='resources'?(await content.resources(null)).resources:await content.activities();assert.equal(hidden.length,0);
  }
  const preview=await content.saveManaged(admin,'articles',{...inputs.articles,access:{visibility:'plans',planIds:['basic'],previewPages:10}},randomUUID());
  await assert.rejects(content.transitionManaged(admin,'articles',preview.id,'publish',1),/试看文件/);
  const noEntry=await content.saveManaged(admin,'resources',{...inputs.resources,action:{type:'unconfigured'}},randomUUID());
  await assert.rejects(content.transitionManaged(admin,'resources',noEntry.id,'publish',1),/使用入口/);
  const expired=await content.saveManaged(admin,'activities',{...inputs.activities,startAt:'2000-01-01T01:00:00Z',endAt:'2000-01-01T02:00:00Z'},randomUUID());
  await assert.rejects(content.transitionManaged(admin,'activities',expired.id,'publish',1),/已结束/);
  await pg.query("UPDATE users SET role='member' WHERE id=$1",[admin.id]);
  await assert.rejects(content.managed(admin,'articles'),/管理员/);
});

test('PG post moderation cannot republish removed content or bypass current administrator status',async t=>{
  const {content,user,admin,activate,fail,pg}=await fixture(t);await activate();const key=randomUUID(),input={title:'会员稿',body:'正文'},post=await content.publish(user,input,key);
  await assert.rejects(content.moderatePost(user,post.id,{status:'rejected',reason:'说明'}),/管理员/);
  fail.audit=true;await assert.rejects(content.moderatePost(admin,post.id,{status:'rejected',reason:'说明'}),/audit failure/);fail.audit=false;
  assert.equal((await content.posts(user)).length,0);assert.equal((await content.posts(user,true))[0].status,'pending');
  await content.moderatePost(admin,post.id,{status:'rejected',reason:'说明'});assert.equal((await content.posts(user)).length,0);
  assert.deepEqual(await content.moderatePost(admin,post.id,{status:'rejected',reason:'说明'}),{ok:true});
  await assert.rejects(content.moderatePost(admin,post.id,{status:'published'}),/状态已变化/);
  assert.equal((await content.publish(user,input,key)).status,'rejected');assert.equal((await content.managedPosts(admin))[0].reason,'说明');
  assert.equal((await pg.query("SELECT COUNT(*) n FROM audit_log WHERE target_id=$1 AND action='post.rejected'",[post.id])).rows[0].n,1n);
  assert.equal((await pg.query("SELECT COUNT(*) n FROM audit_log WHERE target_id=$1 AND action='post.published'",[post.id])).rows[0].n,0n);
});

test('PG managed HTTP routes require admin cookie and expose draft documents only to administrators',async t=>{
  const f=await fixture(t),origin='https://admin.example.test',admin=createPostgresAdmin(f.pool,{schema:f.schema,adminOrigin:origin});
  const server=createPostgresApplication({core:f.core,content:f.content,admin,hosts:['admin.example.test','127.0.0.1']});
  await new Promise(ok=>server.listen(0,'127.0.0.1',ok));t.after(()=>new Promise(ok=>{server.closeAllConnections();server.close(ok);}));
  const call=(path,input,headers={})=>new Promise((resolve,reject)=>{const req=request({hostname:'127.0.0.1',port:server.address().port,path:'/api'+path,method:input===undefined?'GET':'POST',headers:{Host:'admin.example.test','Content-Type':'application/json','X-Club-Request':'1','Idempotency-Key':randomUUID(),Origin:origin,...headers}},res=>{const parts=[];res.on('data',b=>parts.push(b));res.on('end',()=>{const bytes=Buffer.concat(parts);resolve({status:res.statusCode,headers:res.headers,bytes,data:res.headers['content-type']?.startsWith('application/json')?JSON.parse(bytes):null});});});req.on('error',reject);req.end(input===undefined?undefined:JSON.stringify(input));});
  assert.equal((await call('/health',undefined,{Origin:''})).data.memberPostPublication,'manual-review-v1');
  assert.equal((await call('/admin/articles')).status,401);
  const logged=await call('/auth/login',{username:f.admin.username,password:'IsolatedAdmin123'}),Cookie=logged.headers['set-cookie'][0].split(';')[0],auth={Cookie,'X-Club-Actor':f.admin.id};
  const input={title:'草稿报告',body:'说明',category:'knowledge',access:{visibility:'plans',planIds:['basic'],previewPages:10}},created=await call('/admin/articles',input,auth);
  assert.equal(created.status,201,JSON.stringify(created.data));const id=created.data.article.id;
  assert.equal((await call('/admin/articles',input,{Cookie})).status,409);
  assert.equal((await call('/admin/articles',undefined,{Cookie,Authorization:'Bearer '+f.session.accessToken})).status,403);
  const bytes=Buffer.from('%PDF-isolated-admin-draft'),hash=createHash('sha256').update(bytes).digest('hex');writeFileSync(join(f.dir,hash+'.pdf'),bytes);
  await f.pg.query('INSERT INTO article_documents VALUES($1,$2,$3,$4,10,$5)',[id,hash,'草稿.pdf',bytes.length,'2026']);await f.pg.query('INSERT INTO report_previews VALUES($1,$2,$3,10)',[id,hash,bytes.length]);
  assert.equal((await call('/admin/articles',undefined,auth)).data.articles[0].document.previewPages,10);
  assert.deepEqual((await call('/admin/articles/'+id+'/document',undefined,auth)).bytes,bytes);
  assert.equal((await call('/articles/'+id+'/preview',undefined,{Host:'127.0.0.1',Origin:'',Cookie:''})).status,404);
  assert.equal((await call('/admin/articles/'+id+'/publish',{revision:1},auth)).data.article.status,'published');
  for(const [kind,payload] of Object.entries({resources:{title:'服务',body:'说明',category:'directory',access:{visibility:'public',planIds:[]},action:{type:'phone',phoneNumber:'13800000000'}},activities:{title:'活动',mode:'online'}})){
    const saved=await call('/admin/'+kind,payload,auth);assert.equal(saved.status,201,JSON.stringify(saved.data));assert.equal((await call('/admin/'+kind,undefined,auth)).data[kind].length,1);
  }
  await f.activate();const p=await f.content.publish(f.user,{title:'待下架',body:'文字'},randomUUID());assert.equal((await call('/admin/posts',undefined,auth)).data.posts.length,1);
  assert.equal((await call('/admin/posts/'+p.id+'/review',{status:'rejected',reason:'下架'},auth)).data.ok,true);
  assert.equal((await call('/admin/orders',undefined,auth)).data.orders.length,1);
  assert.equal((await call('/admin/members',undefined,auth)).data.members.some(u=>u.id===f.user.id&&u.membership.active),true);
  assert.equal((await call('/admin/audit?group=post',undefined,auth)).data.records.some(r=>r.note==='下架'),true);
  assert.equal((await call('/admin/audit?group=post&group=order',undefined,auth)).status,400);
  await f.pg.query("UPDATE users SET role='member' WHERE id=$1",[f.admin.id]);assert.equal((await call('/admin/articles',undefined,auth)).status,401);
});
