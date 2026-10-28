import test from 'node:test';
import assert from 'node:assert/strict';
import {createServer} from 'node:http';
import {randomUUID} from 'node:crypto';
import {PGlite} from '@electric-sql/pglite';
import {freshDatabaseSql,verifyFreshDatabase} from '../../server/postgres-fresh.mjs';
import {initializeGrantDatabase} from '../../server/collaboration/grant-migration.mjs';
import {initializeGrantEvidenceDatabase,createGrantEvidenceStore} from '../../server/collaboration/grant-evidence-store.mjs';
import {prepareGrantHost} from '../../server/collaboration/grant-host.mjs';
import {digest} from '../../server/domain.mjs';
import pgDriver from 'pg';
import {postgresTypes} from '../../server/postgres.mjs';

async function setup(t){
 const connectionString=process.env.GRANT_TEST_DATABASE_URL;
 const schema='club_migration_evidence_'+randomUUID().replaceAll('-','').slice(0,12);
 let pg,pool;
 if(connectionString){
  const url=new URL(connectionString);
  assert.ok(['postgres:','postgresql:'].includes(url.protocol));
  assert.ok(['localhost','127.0.0.1'].includes(url.hostname));assert.equal(url.pathname,'/grant_test');assert.equal(url.search,'');assert.equal(url.hash,'');
  pool=new pgDriver.Pool({connectionString,max:4,types:postgresTypes,ssl:false,connectionTimeoutMillis:5000,statement_timeout:10000});
  assert.equal((await pool.query('SELECT current_database() AS name')).rows[0].name,'grant_test');
  await pool.query(freshDatabaseSql(schema));
  t.after(async()=>{await pool.query(`DROP SCHEMA "${schema}" CASCADE`);await pool.end();});
  const query=async(sql,args)=>{const c=await pool.connect();try{await c.query(`SET search_path TO "${schema}"`);return await c.query(sql,args);}finally{c.release();}};
  pg={query,exec:query};
 } else {
  pg=new PGlite({parsers:{20:v=>BigInt(v)}});await pg.waitReady;t.after(()=>pg.close());await pg.exec(freshDatabaseSql(schema));
  let tail=Promise.resolve();pool={connect:async()=>{const prev=tail;let release;tail=new Promise(r=>release=r);await prev;return {query:(sql,args)=>args===undefined?pg.exec(sql).then(r=>r.at(-1)??{rows:[]}):pg.query(sql,args),release};}};
 }
 await pg.exec(`SET search_path TO "${schema}";INSERT INTO users(id,username,password_hash,role,created_at,referral_code,consent_version) VALUES
 ('admin','synthetic_admin','synthetic','admin','2026','ADMIN','fixture'),('member','synthetic_member','synthetic','member','2026','MEMBER','fixture');
 INSERT INTO wechat_identities VALUES('wx0000000000000000','synthetic-openid','member','2026')`);
 await pg.query('INSERT INTO sessions VALUES($1,$2,$3)',[digest('pg-admin:'+'a'.repeat(64)),'admin','2099-01-01T00:00:00.000Z']);
 await initializeGrantDatabase(pool,{schema});await verifyFreshDatabase(pool,{schema});
 await initializeGrantEvidenceDatabase(pool,{schema});await verifyFreshDatabase(pool,{schema});
 let handler;const server=createServer((req,res)=>{void handler(req,res);});await new Promise(r=>server.listen(0,'127.0.0.1',r));
 t.after(()=>new Promise(r=>{server.closeAllConnections();server.close(r);}));
 const origin='http://127.0.0.1:'+server.address().port,clock=()=> '2026-10-28T10:00:00.000Z';let access,store;
 const host=await prepareGrantHost(pool,{schema,adminOrigin:origin,clock,writesEnabled:true,confirmationSecret:'SYNTHETIC-ONLY-HOST-SECRET-32-BYTES',
 policy:{approved:true,startRule:'confirmation-time',timeZone:'Asia/Shanghai',yearRule:'calendar-anniversary-clamp',overlap:'block-active',version:'synthetic-v1'},
 evidenceFactory:a=>{access=a;store=createGrantEvidenceStore(a,{clock,writesEnabled:true});return {identityVerifier:store.identityVerifier,approvalResolver:store.approvalResolver,phoneResolver:store.phoneResolver};}});
 handler=host.http;const actor=await access.authenticate({headers:{cookie:'club_pg_admin='+'a'.repeat(64)}});
 await store.recordIdentity(actor,{userId:'member',appId:'wx0000000000000000',openId:'synthetic-openid',evidenceReference:'SYNTHETIC-CHECK',expiresAt:'2026-11-28T10:00:00.000Z',expectedRevision:0});
 await store.recordApproval(actor,{userId:'member',level:'basic',reference:'SYNTHETIC-APPROVAL',expiresAt:'2026-11-28T10:00:00.000Z',expectedRevision:0});
 const request=async(path,input)=>{const r=await fetch(origin+'/api/admin/membership-grants'+path,{method:input===undefined?'GET':'POST',headers:{cookie:'club_pg_admin='+'a'.repeat(64),origin,'content-type':'application/json','x-club-request':'1','x-club-actor':'admin'},...(input===undefined?{}:{body:JSON.stringify(input)})});return {status:r.status,body:await r.json()};};
 return {pg,pool,schema,request,origin};
}
test('persisted evidence shares real host HTTP actor; basic issue/recovery works, phone remains unavailable and fresh schema validates',async t=>{
 const f=await setup(t),draft={userId:'member',level:'basic',reason:'SYNTHETIC',approvalReference:'SYNTHETIC-APPROVAL'};
 assert.equal((await f.request('/lookup',{type:'userId',value:'member'})).body.verified,true);
 assert.equal((await f.request('/lookup',{type:'phone',value:'+99900000001'})).body.blockers[0].code,'PHONE_VERIFICATION_UNAVAILABLE');
 assert.equal((await f.request('/preflight',{...draft,level:'star'})).body.ready,false);
 const pre=await f.request('/preflight',draft);assert.equal(pre.status,200);assert.equal(pre.body.ready,true);
 const key=randomUUID(),input={...draft,confirmationToken:pre.body.confirmationToken,idempotencyKey:key};
 const issued=await f.request('',input);assert.equal(issued.status,200);assert.equal(issued.body.level,'basic');assert.equal(issued.body.duplicate,false);
 assert.equal((await f.request('/operations/'+key)).body.grant.grantId,issued.body.grantId);
 assert.equal((await f.request('',input)).body.duplicate,true);
 const closed=await prepareGrantHost(f.pool,{schema:f.schema,adminOrigin:f.origin});assert.equal(closed.writesEnabled,false);
 await f.pg.query('ALTER TABLE grant_person_evidence ADD COLUMN unexpected TEXT');
 await assert.rejects(verifyFreshDatabase(f.pool,{schema:f.schema}),e=>e.code==='EVIDENCE_MIGRATION_INCONSISTENT');
});
test('evidence factory cannot enable writes or inject service policy through resolver configuration',async t=>{
 const f=await setup(t);
 await assert.rejects(prepareGrantHost(f.pool,{schema:f.schema,evidenceFactory:()=>({writesEnabled:true})}),e=>e.code==='INVALID_REQUEST');
});
