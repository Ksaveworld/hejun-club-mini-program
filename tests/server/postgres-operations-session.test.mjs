import test from 'node:test';
import assert from 'node:assert/strict';
import {request} from 'node:http';
import {PGlite} from '@electric-sql/pglite';
import {freshDatabaseSql} from '../../server/postgres-fresh.mjs';
import {initializeOperationsAdmin} from '../../server/postgres-admin-setup.mjs';
import {createPostgresAdmin} from '../../server/postgres-admin.mjs';
import {createPostgresCore} from '../../server/postgres-core.mjs';
import {createPostgresForms} from '../../server/postgres-forms.mjs';
import {createPostgresContent} from '../../server/postgres-content.mjs';
import {createPostgresSupport} from '../../server/postgres-support.mjs';
import {createPostgresApplication} from '../../server/postgres-app.mjs';
import {hashPassword} from '../../server/domain.mjs';

test('operations HTTP session reaches empty business lists, isolates native identity and expires on logout',async t=>{
  const config={schema:'club_migration_operations_http',mode:'fresh',appId:'wx47d5e3e20fd77f65',adminOrigin:'https://admin.example.test',legal:{id:'isolated-native-v1',status:'approved',requireHongKongConsent:false,documents:[]}};
  const pg=new PGlite({parsers:{20:value=>BigInt(value)}});await pg.waitReady;
  await pg.exec(freshDatabaseSql(config.schema));let tail=Promise.resolve();
  const pool={connect:async()=>{const previous=tail;let release;tail=new Promise(ok=>{release=ok;});await previous;return{query:(sql,params)=>pg.query(sql,params),release};}};
  await initializeOperationsAdmin(pool,config,{version:1,schema:config.schema,appId:config.appId,username:'isolated_operator',passwordHash:await hashPassword('IsolatedOperator123')});
  const server=createPostgresApplication({core:createPostgresCore(pool,config),forms:createPostgresForms(pool,config),content:createPostgresContent(pool,config),support:createPostgresSupport(pool,config),admin:createPostgresAdmin(pool,config),hosts:['admin.example.test','sdk.example.test'],mode:'fresh'});
  await new Promise(ok=>server.listen(0,'127.0.0.1',ok));
  t.after(async()=>{server.closeAllConnections();await new Promise(ok=>server.close(ok));await pg.close();});
  const call=(path,body,headers={})=>new Promise((resolve,reject)=>{
    const req=request({hostname:'127.0.0.1',port:server.address().port,path:'/api'+path,method:body===undefined?'GET':'POST',headers:{Host:'admin.example.test','Content-Type':'application/json','X-Club-Request':'1',...(body===undefined?{}:{Origin:config.adminOrigin}),...headers}},res=>{
      const parts=[];res.on('data',part=>parts.push(part));res.on('end',()=>resolve({status:res.statusCode,headers:res.headers,data:JSON.parse(Buffer.concat(parts))}));
    });req.on('error',reject);req.end(body===undefined?undefined:JSON.stringify(body));
  });
  assert.equal((await call('/me')).data.user,null);
  assert.equal((await call('/admin/members')).status,401);
  const staleCollaboration='club_pg_collab='+'b'.repeat(64)+'; cloudbase_confirm_domain_access=1';
  const rejected=await call('/auth/login',{username:'isolated_operator',password:'IncorrectPass123'},{Cookie:staleCollaboration});
  assert.equal(rejected.status,401);assert.equal(rejected.headers['set-cookie'],undefined);
  const logged=await call('/auth/login',{username:'isolated_operator',password:'IsolatedOperator123'},{Cookie:staleCollaboration});
  assert.equal(logged.status,200);
  const setCookie=logged.headers['set-cookie'][0],cookie=setCookie.split(';')[0],actor=logged.data.user.id;
  assert.match(setCookie,/HttpOnly; Secure; SameSite=Strict/);
  assert.equal(logged.headers['set-cookie'][1],'club_pg_collab=; HttpOnly; Secure; SameSite=Strict; Path=/; Max-Age=0');
  assert.equal((await call('/me',undefined,{Cookie:cookie+'; '+staleCollaboration})).data.user.id,actor);
  assert.equal((await call('/admin/members',undefined,{Cookie:staleCollaboration})).status,401);
  assert.equal((await call('/auth/login',{username:'isolated_operator',password:'IsolatedOperator123'},{Cookie:staleCollaboration,Origin:'https://foreign.example.test'})).status,403);
  assert.equal((await call('/me',undefined,{Cookie:cookie})).data.user.id,actor);
  for(const path of ['/admin/orders','/admin/members','/admin/articles','/admin/activities','/admin/resources','/admin/posts','/admin/surveys','/admin/enterprise-intake','/admin/feedback','/admin/ambassadors','/admin/audit']) {
    const response=await call(path,undefined,{Cookie:cookie});assert.equal(response.status,200,path+': '+JSON.stringify(response.data));
  }
  assert.equal((await call('/admin/members',undefined,{Cookie:cookie,Host:'sdk.example.test'})).status,403);
  // Current release resolves invalid bearer credentials before admin cookie routing.
  // Both identities must remain isolated; an invalid bearer is rejected as 401.
  assert.equal((await call('/admin/members',undefined,{Cookie:cookie,Authorization:'Bearer '+'a'.repeat(64)})).status,401);
  assert.equal((await call('/admin/members',undefined,{Cookie:cookie,Origin:'https://foreign.example.test'})).status,403);
  assert.equal((await call('/admin/members',undefined,{Cookie:'club_session='+cookie.split('=')[1]})).status,401);
  assert.equal((await call('/auth/logout',{}, {Cookie:cookie,'X-Club-Actor':'stale-actor'})).status,409);
  assert.equal((await call('/me',undefined,{Cookie:cookie})).data.user.id,actor);
  const logout=await call('/auth/logout',{}, {Cookie:cookie,'X-Club-Actor':actor});assert.equal(logout.status,200);
  assert.match(logout.headers['set-cookie'][0],/Max-Age=0/);
  assert.equal((await call('/me',undefined,{Cookie:cookie})).data.user,null);
  assert.equal((await call('/admin/members',undefined,{Cookie:cookie})).status,401);
  for(const table of ['orders','memberships','native_sessions','wechat_identities','enterprise_intakes','survey_submissions'])
    assert.equal(Number((await pg.query(`SELECT count(*) AS n FROM ${config.schema}.${table}`)).rows[0].n),0,table);
});
