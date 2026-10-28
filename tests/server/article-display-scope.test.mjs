import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {randomUUID} from 'node:crypto';
import {PGlite} from '@electric-sql/pglite';
import {createPostgresContent} from '../../server/postgres-content.mjs';
import {createBatch2Content} from '../../server/batch2-content.mjs';
import {parseExtra,extraKey} from '../../server/article-placement-extra.mjs';

async function fixture(t){
 const pg=new PGlite({parsers:{20:v=>BigInt(v)}});await pg.waitReady;
 const schema='club_migration_placement_scope';await pg.exec(`CREATE SCHEMA ${schema}; SET search_path TO ${schema};`+readFileSync(new URL('../../server/migrations/postgres/001-baseline.sql',import.meta.url),'utf8'));
 let tail=Promise.resolve();const pool={connect:async()=>{const previous=tail;let release;tail=new Promise(r=>release=r);await previous;return {query:(s,a)=>pg.query(s,a),release};}};
 const admin={id:randomUUID(),role:'admin'};await pg.query("INSERT INTO users(id,username,password_hash,role,created_at,referral_code,consent_version) VALUES($1,'scope_admin','unused','admin','2026','SC0001','test')",[admin.id]);
 await pg.exec(readFileSync(new URL('../../server/migrations/postgres/014-batch2-content.sql',import.meta.url),'utf8'));
 const content=createPostgresContent(pool,{schema}),batch=createBatch2Content(pool,{schema});
 const article=await content.saveManaged(admin,'articles',{title:'范围测试',summary:'摘要',body:'正文',category:'news',access:{visibility:'public',planIds:[]}},randomUUID());
 t.after(()=>pg.close());return {pg,pool,schema,admin,content,batch,article};
}
const url='https://mp.weixin.qq.com/s/test_scope';
const placement={section:'launch',topic:'unclassified',activityGroup:'',originalUrl:url,policyCategory:'',practiceCategory:'',supportCategory:'',isRecap:false};

test('legacy placement scope is inferred without changing persisted fields',()=>{
 assert.equal(parseExtra(null).displayScope,'info');assert.equal(parseExtra('{"activityGroup":"salon"}').displayScope,'both');assert.equal(parseExtra('{"activityGroup":"salon","displayScope":"activity"}').displayScope,'activity');
});

test('scope save supports info original links, activity-only and both with validation and revisions',async t=>{
 const {batch,admin,article,content,pg}=await fixture(t);let revision=article.revision;
 const save=async fields=>{const value=await batch.saveMetadata(admin,article.id,{...placement,revision,...fields},randomUUID());revision=value.revision;return value;};
 await assert.rejects(save({displayScope:'invalid'}),/展示位置/);
 await assert.rejects(save({displayScope:'activity'}),/活动栏目/);
 await assert.rejects(save({displayScope:'both'}),/活动栏目/);
 const info=await save({displayScope:'info',activityGroup:'salon'});assert.equal(info.displayScope,'info');assert.equal(info.activityGroup,'');assert.equal(info.originalUrl,url);
 await assert.rejects(content.article(null,article.id),/不可阅读/);
 const activity=await save({displayScope:'activity',activityGroup:'expo'});assert.equal(activity.displayScope,'activity');assert.equal(activity.activityGroup,'expo');
 const legacy=await save({activityGroup:'salon'});assert.equal(legacy.displayScope,'both');
 const key=randomUUID(),input={...placement,revision,displayScope:'both',activityGroup:'online'};const both=await batch.saveMetadata(admin,article.id,input,key);revision=both.revision;assert.equal(both.displayScope,'both');assert.deepEqual(await batch.saveMetadata(admin,article.id,input,key),both);
 await assert.rejects(batch.saveMetadata(admin,article.id,{...input,displayScope:'activity'},key),/不同内容/);
 await assert.rejects(batch.saveMetadata(admin,article.id,{...placement,revision:1,displayScope:'info'},randomUUID()),/变化/);
 await assert.rejects(batch.saveMetadata({id:admin.id,role:'member'},article.id,{...placement,revision,displayScope:'info'},randomUUID()),/管理员/);
 await assert.rejects(save({displayScope:'info',originalUrl:'https://example.com/article'}),/公众号/);
 await content.transitionManaged(admin,'articles',article.id,'publish',revision);
 const topics=await batch.publicTopics();assert.equal(topics[0].displayScope,'both');assert.equal(topics[0].originalUrl,url);
 assert.equal((await content.article(null,article.id)).originalUrl,url);
 await assert.rejects(save({displayScope:'info'}),/变化|撤下/);
 // An invalid historic URL cannot become an externally navigable detail link.
 await pg.query('UPDATE settings SET value=$1 WHERE key=$2',[JSON.stringify({...both,originalUrl:'https://example.com/redirect'}),extraKey(article.id)]);
 assert.equal((await content.article(null,article.id)).originalUrl,'');assert.equal((await batch.publicTopics())[0].originalUrl,'');
});

test('original links retain public-only and PDF exclusion rules',async t=>{
 const {pg,batch,content,admin,article}=await fixture(t);
 await pg.query('UPDATE articles SET access_json=$1 WHERE id=$2',[JSON.stringify({visibility:'plans',planIds:['basic']}),article.id]);
 await assert.rejects(batch.saveMetadata(admin,article.id,{...placement,revision:1,displayScope:'info'},randomUUID()),/所有访客/);
 await pg.query('UPDATE articles SET access_json=$1 WHERE id=$2',[JSON.stringify({visibility:'public',planIds:[]}),article.id]);
 await pg.query("INSERT INTO article_documents VALUES($1,$2,'测试.pdf',20,1,'2026')",[article.id,'a'.repeat(64)]);
 await assert.rejects(batch.saveMetadata(admin,article.id,{...placement,revision:1,displayScope:'info'},randomUUID()),/PDF/);
 // Even malformed legacy combinations must not bypass the original-document path.
 await pg.query('INSERT INTO settings(key,value) VALUES($1,$2)',[extraKey(article.id),JSON.stringify({originalUrl:url})]);
 await pg.query("UPDATE articles SET status='published' WHERE id=$1",[article.id]);assert.equal((await content.article(null,article.id)).originalUrl,'');
 await pg.query("UPDATE articles SET status='draft' WHERE id=$1",[article.id]);await assert.rejects(content.article(null,article.id),/不可阅读/);
});
