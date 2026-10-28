import {request} from 'node:http';
import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {randomUUID} from 'node:crypto';
import {PGlite} from '@electric-sql/pglite';
import {createPostgresForms} from '../../server/postgres-forms.mjs';
import {createApplication} from '../../server/app.mjs';
import {openDatabase} from '../../server/db.mjs';
import {insertUser,digest} from '../../server/domain.mjs';
import {surveys} from '../../server/surveys.mjs';
import {intakeVersion} from '../../server/enterprise-intake.mjs';
import {reportPdf} from '../fixtures/report-pdf.mjs';
import definition from '../../shared/enterprise-fields.json' with {type:'json'};

async function fixture(t){
  const pg=new PGlite({parsers:{20:v=>BigInt(v)}});await pg.waitReady;
  const schema='club_migration_forms';
  await pg.exec(`CREATE SCHEMA ${schema}; SET search_path TO ${schema};`+readFileSync(new URL('../../server/migrations/postgres/001-baseline.sql',import.meta.url),'utf8'));
  const db=openDatabase(':memory:'),admin=insertUser(db,'forms_admin','unused','admin');
  await pg.query('INSERT INTO users(id,username,password_hash,role,created_at,referral_code,consent_version) VALUES($1,$2,$3,$4,$5,$6,$7)',[admin.id,admin.username,admin.password_hash,admin.role,admin.created_at,admin.referral_code,admin.consent_version]);
  const state={failAudit:false};
  const pool={connect:async()=>({query:async(sql,values)=>{
    if(state.failAudit&&sql.startsWith('INSERT INTO audit_log'))throw new Error('injected audit failure');
    return pg.query(sql,values);
  },release(){}})};
  const forms=createPostgresForms(pool,{schema});
  t.after(async()=>{db.close();await pg.close();});
  return {pg,db,admin,forms,state};
}
function fetch(url,options={}){
  return new Promise((resolve,reject)=>{
    const req=request(url,{method:options.method||'GET',headers:options.headers},res=>{
      const chunks=[];res.on('data',chunk=>chunks.push(chunk));
      res.on('end',()=>resolve(new Response(Buffer.concat(chunks),{status:res.statusCode,headers:res.headers})));
      res.on('error',reject);
    });req.on('error',reject);req.end(options.body);
  });
}
const survey=()=>({version:surveys.singapore.version,consent:true,answers:{q1:'隔离企业',q2:'测试联系人',q3:'+65 8123 4567'}});
const intake=()=>({company:'隔离企业',contact:'测试联系人',phone:'+65 8123 4567',note:'测试',answers:Object.fromEntries(definition.fields.map(f=>[f.id,f.type==='multi'?f.options.slice(0,2):f.type==='single'?f.options[0]:'隔离答案'])),filename:'已填材料.pdf',fileBase64:reportPdf.toString('base64'),templateVersion:intakeVersion,consent:true});

test('PG forms retain receipts, reject conflicting retries and roll back audit failures',async t=>{
  const {pg,forms,state}=await fixture(t),key=randomUUID();
  const first=await forms.submitSurvey('singapore',survey(),key);
  assert.deepEqual(await forms.submitSurvey('singapore',survey(),key),{...first,duplicate:true});
  await assert.rejects(forms.submitSurvey('singapore',{...survey(),answers:{...survey().answers,q1:'changed'}},key),/已变化/);
  state.failAudit=true;
  await assert.rejects(forms.submitSurvey('singapore',survey(),randomUUID()),/injected/);
  await assert.rejects(forms.saveEnterpriseIntake(intake(),randomUUID()),/injected/);
  assert.equal((await pg.query('SELECT count(*) AS n FROM survey_submissions')).rows[0].n,1n);
  assert.equal((await pg.query('SELECT count(*) AS n FROM enterprise_intakes')).rows[0].n,0n);
});

test('PG attachment access, exact bytes, quota and region-specific consent are enforced',async t=>{
  const {pg,forms,admin}=await fixture(t),key=randomUUID();
  const legal={id:'isolated-shanghai',requireHongKongConsent:false,documents:[]};
  const body={...intake(),legalConsent:{accepted:true,releaseId:legal.id}};
  const first=await forms.saveEnterpriseIntake(body,key,legal);
  assert.deepEqual(await forms.saveEnterpriseIntake(body,key,legal),{...first,duplicate:true});
  await assert.rejects(forms.saveEnterpriseIntake({...body,note:'changed'},key,legal),/已变化/);
  await assert.rejects(forms.saveEnterpriseIntake(body,randomUUID(),{...legal,requireHongKongConsent:true}),/存储安排/);
  await assert.rejects(forms.listEnterpriseIntakes({id:admin.id,role:'member'}),/管理员/);
  await assert.rejects(forms.downloadEnterpriseUpload(null,first.id,{}),/管理员/);
  const listed=await forms.listEnterpriseIntakes(admin);
  assert.deepEqual(listed.submissions[0].answers,body.answers);
  assert.equal(listed.submissions[0].byte_size,reportPdf.length);
  let received;
  await forms.downloadEnterpriseUpload(admin,first.id,{writeHead(status){assert.equal(status,200);},end(bytes){received=bytes;}});
  assert.deepEqual(received,reportPdf);
  await pg.query('UPDATE enterprise_intakes SET byte_size=$1',[256*1024*1024]);
  await assert.rejects(forms.saveEnterpriseIntake(intake(),randomUUID()),/空间已满/);
  await pg.query("UPDATE enterprise_intakes SET file_data=$1",[Buffer.from('corrupt')]);
  await assert.rejects(forms.downloadEnterpriseUpload(admin,first.id,{}),/校验失败/);
});

test('HTTP submissions and admin reads use PG without writing SQLite forms',async t=>{
  const {forms,db,admin}=await fixture(t);
  const server=createApplication(db,{formsRepository:forms,enterpriseIntake:true,hosts:['127.0.0.1']});
  await new Promise(ok=>server.listen(0,'127.0.0.1',ok));
  t.after(()=>new Promise(ok=>{server.closeAllConnections();server.close(ok);}));
  const base=`http://127.0.0.1:${server.address().port}/api`;
  const token='a'.repeat(64);db.prepare('INSERT INTO sessions VALUES(?,?,?)').run(digest(token),admin.id,'2099-01-01');
  const send=(path,body,key)=>fetch(base+path,{method:'POST',headers:{'Content-Type':'application/json','X-Club-Request':'1','Idempotency-Key':key,Host:'127.0.0.1'},body:JSON.stringify(body)});
  const response=await send('/surveys/singapore',survey(),randomUUID());assert.equal(response.status,201,await response.clone().text());
  const uploaded=await send('/enterprise-intake',intake(),randomUUID());assert.equal(uploaded.status,201,await uploaded.clone().text());
  const {receipt}=await uploaded.json();
  const headers={Cookie:`club_session=${token}`,Host:'127.0.0.1'};
  for(const path of ['/admin/surveys','/admin/enterprise-intake']){
    const response=await fetch(base+path,{headers});assert.equal(response.status,200);
    assert.equal((await response.json()).submissions.length,1);
  }
  const file=await fetch(base+'/admin/enterprise-intake/'+receipt.id+'/file',{headers});
  assert.equal(file.status,200);assert.deepEqual(Buffer.from(await file.arrayBuffer()),reportPdf);
  assert.equal(db.prepare('SELECT count(*) AS n FROM survey_submissions').get().n,0);
  assert.equal(db.prepare('SELECT count(*) AS n FROM enterprise_intakes').get().n,0);
});
