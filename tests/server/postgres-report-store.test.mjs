import test from 'node:test';
import assert from 'node:assert/strict';
import {PGlite} from '@electric-sql/pglite';
import {createHash} from 'node:crypto';
import {mkdtempSync,writeFileSync,rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {createServer} from 'node:http';
import {freshDatabaseSql,verifyFreshDatabase} from '../../server/postgres-fresh.mjs';
import {initializeReportStore,importReportBatch,sendPostgresReport} from '../../server/postgres-report-store.mjs';
import {seedPublishedContent} from '../../server/postgres-published-content.mjs';

async function fixture(t){
 const db=new PGlite({parsers:{20:v=>BigInt(v)}});await db.waitReady;
 const schema='club_migration_private_reports',directory=mkdtempSync(join(tmpdir(),'club-report-store-'));
 await db.exec(freshDatabaseSql(schema));let tail=Promise.resolve();
 const pool={connect:async()=>{const previous=tail;let release;tail=new Promise(ok=>release=ok);await previous;return{query:(s,a)=>db.query(s,a),release};}};
 t.after(async()=>{await db.close();rmSync(directory,{recursive:true,force:true});});
 return{db,pool,schema,directory};
}
test('private PG files import in bounded chunks, roll back corruption, survive reuse and support immutable byte ranges',async t=>{
 const f=await fixture(t),bytes=Buffer.alloc(1024*1024+7,65);bytes.write('%PDF-');
 const sha256=createHash('sha256').update(bytes).digest('hex'),file={sha256,bytes:bytes.length};
 writeFileSync(join(f.directory,sha256+'.pdf'),bytes);await initializeReportStore(f.pool,f);
 assert.equal((await verifyFreshDatabase(f.pool,f)).initialized,true);
 assert.deepEqual(await importReportBatch(f.pool,{...f,files:[file]}),{stored:1,reused:0});
 assert.deepEqual(await importReportBatch(f.pool,{...f,files:[file]}),{stored:0,reused:1});
 const broken={sha256:'b'.repeat(64),bytes:bytes.length};writeFileSync(join(f.directory,broken.sha256+'.pdf'),bytes);
 await assert.rejects(importReportBatch(f.pool,{...f,files:[broken]}),/指纹/);
 assert.equal(Number((await f.db.query(`SELECT count(*) AS n FROM ${f.schema}._club_report_files`)).rows[0].n),1);
 const server=createServer((req,res)=>sendPostgresReport(f.pool,f,{sha256,byte_size:bytes.length,filename:'隔离报告.pdf'},req,res).catch(e=>{if(res.headersSent)res.destroy();else{res.writeHead(e.status||500);res.end();}}));
 await new Promise(ok=>server.listen(0,'127.0.0.1',ok));t.after(()=>new Promise(ok=>server.close(ok)));
 const url='http://127.0.0.1:'+server.address().port;
 const r=await fetch(url,{headers:{Range:'bytes=1048574-1048582'}});
 assert.equal(r.status,206);assert.equal(r.headers.get('etag'),'"'+sha256+'"');assert.deepEqual(Buffer.from(await r.arrayBuffer()),bytes.subarray(1048574));
 assert.match(r.headers.get('content-disposition'),/^inline;/);
 const download=await fetch(url+'?download=1',{headers:{Range:'bytes=0-4'}});
 assert.equal(download.status,206);assert.match(download.headers.get('content-disposition'),/^attachment;/);
 assert.ok(download.headers.get('content-disposition').includes(encodeURIComponent('隔离报告.pdf')));
 assert.equal(download.headers.get('cache-control'),'private, no-store');assert.equal(download.headers.get('etag'),'"'+sha256+'"');
 assert.equal(await download.text(),'%PDF-');
 const changed=await fetch(url,{headers:{'If-Match':'"'+'c'.repeat(64)+'"'}});assert.equal(changed.status,412);
 const outside=await fetch(url,{headers:{Range:'bytes=99999999-'}});assert.equal(outside.status,416);
});
test('published-content seed accepts only content tables, refuses overwrite and never imports client/history records',async t=>{
 const f=await fixture(t),seed={version:1,origin:'u51-published-content-only',tables:{articles:[],activities:[],article_documents:[],report_previews:[]}};
 const invalid={...seed,tables:{...seed.tables,users:[]}};await assert.rejects(seedPublishedContent(f.pool,f,invalid),/只允许/);
 assert.equal((await seedPublishedContent(f.pool,f,seed)).legacyCustomersImported,false);
 assert.equal((await seedPublishedContent(f.pool,f,seed)).alreadySeeded,true);
 for(const table of ['orders','memberships','wechat_identities','survey_submissions'])assert.equal(Number((await f.db.query(`SELECT count(*) AS n FROM ${f.schema}.${table}`)).rows[0].n),0);
 assert.equal((await f.db.query(`SELECT username,consent_version FROM ${f.schema}.users`)).rows[0].consent_version,'system-content-only');
 await assert.rejects(seedPublishedContent(f.pool,f,{...seed,other:true}),/来源指纹/);
});
