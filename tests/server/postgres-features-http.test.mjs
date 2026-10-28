import test from 'node:test';
import assert from 'node:assert/strict';
import {createPostgresApplication} from '../../server/postgres-app.mjs';
import {validatePhaseOneFeatures,initializePostVersionRuntime,createPostgresInviteCode} from '../../server/postgres-feature-runtime.mjs';
const user={id:'member-current',role:'member'},token='a'.repeat(64),postId='11111111-1111-4111-8111-111111111111';
async function fixture(extra){
  const hosts=['127.0.0.1'];
  const core={appId:'wx47d5e3e20fd77f65',authenticate:async value=>value===token?user:null};
  const server=createPostgresApplication({core,forms:{},hosts,autoRecover:false,...extra});
  await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));
  hosts[0]='127.0.0.1:'+server.address().port;const base='http://'+hosts[0];
  return {async request(path,{body,key,authenticated=true,headers={}}={}){
    const response=await fetch(base+path,{method:body===undefined?'GET':'POST',headers:{'Content-Type':'application/json','X-Club-Request':'1',...(authenticated?{Authorization:'Bearer '+token}:{}),...(key?{'Idempotency-Key':key}:{}),...headers},body:body===undefined?undefined:JSON.stringify(body)});
    return {status:response.status,data:await response.json()};
  },async close(){server.closeIdleConnections();await new Promise(resolve=>server.close(resolve));}};
}
test('invite HTTP requires the current native actor and refuses injected source/environment',async()=>{
  let count=0;const env=await fixture({inviteCode:{configured:true,generate:async actor=>{assert.equal(actor,user);count++;return {code:'OWN123',contentType:'image/png',imageBase64:'fixture'};}}});
  try{
    assert.equal((await env.request('/api/invite-code',{authenticated:false})).status,401);
    assert.equal((await env.request('/api/invite-code?code=OTHER1&env=release')).status,400);assert.equal(count,0);
    const result=await env.request('/api/invite-code');assert.equal(result.status,200);assert.equal(result.data.code,'OWN123');assert.equal(count,1);
    assert.equal((await env.request('/api/invite-code',{headers:{Cookie:'another-web-session'}})).status,400);assert.equal(count,1);
  }finally{await env.close();}
});
test('missing invite configuration is explicit and does not fabricate an image',async()=>{
  const env=await fixture({inviteCode:{configured:false}});
  try{const result=await env.request('/api/invite-code');assert.equal(result.status,503);assert.equal(Object.hasOwn(result.data,'imageBase64'),false);}finally{await env.close();}
});
test('post revision HTTP retains the authenticated owner, original revision, and retry key',async()=>{
  let calls=0;const env=await fixture({content:{editPost:async(actor,id,input,key)=>{calls++;assert.equal(actor,user);assert.equal(id,postId);assert.deepEqual(input,{title:'新稿',body:'待客户复审',revision:2});assert.equal(key,'original-edit-key');return {id,revision:3,status:'pending'};}}});
  try{
    const path='/api/posts/'+postId+'/revisions',body={title:'新稿',body:'待客户复审',revision:2};
    assert.equal((await env.request(path,{body,authenticated:false})).status,401);assert.equal(calls,0);
    const result=await env.request(path,{body,key:'original-edit-key'});assert.equal(result.status,200);assert.equal(result.data.post.revision,3);assert.equal(calls,1);
    assert.equal((await env.request('/api/posts/------------------------------------/revisions',{body,key:'original-edit-key'})).status,404);assert.equal(calls,1);
  }finally{await env.close();}
});
test('optional feature runtime performs no implicit migration or old-release QR generation',async()=>{
  const pool={query(){throw Error('unexpected DB call');},connect(){throw Error('unexpected DB call');}},config={schema:'club_migration_fixture',mode:'fresh',appId:'wx47d5e3e20fd77f65'};
  await initializePostVersionRuntime(pool,config,undefined);
  await assert.rejects(initializePostVersionRuntime(pool,config,config.schema),/明确开启/);
  await assert.rejects(initializePostVersionRuntime(pool,{...config,postVersions:true},'club_migration_other'),/精确/);
  assert.equal(createPostgresInviteCode(pool,config,{}).configured,false);
  assert.equal(createPostgresInviteCode(pool,{...config,wechat:{},nativeInviteCode:{enabled:true,envVersion:'release',checkPath:true}},{}).configured,false);
  assert.throws(()=>validatePhaseOneFeatures({...config,nativeInviteCode:{enabled:true,envVersion:'someone-elses-app',checkPath:true}}),/环境/);
  assert.throws(()=>validatePhaseOneFeatures({...config,postVersions:'true'}),/配置/);
});
