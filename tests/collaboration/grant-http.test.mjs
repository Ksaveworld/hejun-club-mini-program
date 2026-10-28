import test from 'node:test';
import assert from 'node:assert/strict';
import {createServer,request as httpRequest} from 'node:http';
import {randomUUID} from 'node:crypto';
import {fixture} from './fixture.mjs';
import {createSingleGrants} from '../../server/collaboration/single-grants.mjs';
import {createGrantIdentityVerifier} from '../../server/collaboration/grant-identity.mjs';
import {createGrantHttpHandler} from '../../server/collaboration/grant-http.mjs';
import {digest} from '../../server/domain.mjs';

const prefix='/api/admin/membership-grants';
const grantInput={userId:'http-person',level:'star',reason:'SYNTHETIC HTTP verification',approvalReference:'SYNTHETIC-HTTP-APPROVAL'};
async function setup(t,{serviceOverride}={}) {
  const f=await fixture(t);
  await f.pg.exec("INSERT INTO users(id,username,password_hash,role,created_at,referral_code,consent_version) VALUES('http-person','synthetic_http_person','synthetic','member','2026','HTTP-REF','fixture'); INSERT INTO wechat_identities VALUES('synthetic-http-app','synthetic-http-openid','http-person','2026')");
  const serviceOptions={
    policy:{approved:true,startRule:'confirmation-time',timeZone:'Asia/Shanghai',yearRule:'calendar-anniversary-clamp',overlap:'block-active',version:'SYNTHETIC-HTTP-v1'},
    clock:()=> '2026-10-28T12:00:00.000Z',confirmationSecret:'SYNTHETIC-HTTP-ONLY-SECRET-AT-LEAST-32',writesEnabled:true,writeCoordinationReady:true,
    identityVerifier:createGrantIdentityVerifier({resolveEvidence:async(_c,{userId})=>({verified:true,userId,appId:'synthetic-http-app',openId:'synthetic-http-openid',reference:'SYNTHETIC-HTTP-IDENTITY',revision:'1'})}),
    approvalResolver:async(_c,r)=>({approved:true,userId:r.userId,level:r.level,reference:r.approvalReference,revision:'1'})
  };
  const grants=createSingleGrants(f.access,serviceOptions);
  let handler;
  const server=createServer((req,res)=>{Promise.resolve(handler(req,res)).then(handled=>{if(!handled){res.writeHead(404,{'content-type':'application/json'});res.end(JSON.stringify({fallback:true}));}}).catch(()=>{res.writeHead(500);res.end();});});
  await new Promise((resolve,reject)=>{server.once('error',reject);server.listen(0,'127.0.0.1',resolve);});
  const origin=`http://127.0.0.1:${server.address().port}`;
  handler=createGrantHttpHandler({access:f.access,grants:serviceOverride??grants,adminOrigin:origin});
  t.after(()=>new Promise(resolve=>{server.closeAllConnections();server.close(resolve);}));
  const request=(path='',{method='GET',data,raw,headers:extra={}}={})=>new Promise((resolve,reject)=>{
    const headers={cookie:'club_pg_admin='+'a'.repeat(64),connection:'close',...(method==='POST'?{origin,'x-club-request':'1','x-club-actor':'admin','content-type':'application/json'}:{}),...extra};
    for(const key of Object.keys(headers))if(headers[key]===null)delete headers[key];
    const req=httpRequest(origin+(path.startsWith('/api/')?path:prefix+path),{method,headers},res=>{
      const chunks=[];res.on('data',chunk=>chunks.push(chunk));res.on('end',()=>{
        const text=Buffer.concat(chunks).toString('utf8');
        try{resolve({status:res.statusCode,headers:res.headers,body:JSON.parse(text),text});}catch(error){reject(error);}
      });
    });
    req.on('error',reject);req.end(raw!==undefined?raw:data!==undefined?JSON.stringify(data):undefined);
  });
  return {...f,grants,request,origin,setWritesDisabled:()=>{
    handler=createGrantHttpHandler({access:f.access,grants:createSingleGrants(f.access,{...serviceOptions,writesEnabled:false}),adminOrigin:origin});
  }};
}

test('real HTTP single-user flow: lookup, preflight, confirm, duplicate, history and revoke',async t=>{
  const f=await setup(t);
  const lookup=await f.request('/lookup',{method:'POST',data:{type:'userId',value:'http-person'}});
  assert.equal(lookup.status,200);assert.equal(lookup.body.verified,true);assert.ok(!lookup.text.includes('synthetic-http-openid'));
  const pre=await f.request('/preflight',{method:'POST',data:grantInput});assert.equal(pre.status,200);assert.equal(pre.body.ready,true);
  const data={...grantInput,idempotencyKey:randomUUID(),confirmationToken:pre.body.confirmationToken};
  const created=await f.request('',{method:'POST',data});assert.equal(created.status,200);assert.equal(created.body.level,'star');assert.equal(created.body.duplicate,false);
  assert.equal(created.body.effectiveEntitlements.active,true);
  const duplicate=await f.request('',{method:'POST',data});assert.equal(duplicate.body.duplicate,true);assert.equal(duplicate.body.grantId,created.body.grantId);
  assert.equal(duplicate.body.startsAt,created.body.startsAt);
  const listed=await f.request('?userId=http-person&status=active&limit=25');assert.equal(listed.status,200);assert.equal(listed.body.items.length,1);
  const revoked=await f.request('/'+created.body.grantId+'/revoke',{method:'POST',data:{reason:'SYNTHETIC revoke'}});
  assert.equal(revoked.status,200);assert.equal(revoked.body.status,'revoked');assert.equal(revoked.body.effectiveEntitlements.active,false);
  const retry=await f.request('/'+created.body.grantId+'/revoke',{method:'POST',data:{reason:'SYNTHETIC retry'}});assert.equal(retry.body.duplicate,true);
  assert.equal((await f.request('?status=revoked')).body.items.length,1);
  for(const response of [lookup,pre,created,duplicate,listed,revoked,retry]){
    assert.equal(response.headers['cache-control'],'no-store');assert.equal(response.headers['x-content-type-options'],'nosniff');
    assert.ok(!response.text.includes('synthetic-http-openid'));assert.ok(!response.text.includes('password_hash'));
  }
});

test('HTTP rejects unauthenticated, association, bearer, cross-origin and stale actor/session requests',async t=>{
  const f=await setup(t);
  assert.equal((await f.request('',{headers:{cookie:null}})).status,401);
  const association=await f.account('SYNTHETIC-HTTP-org','synthetic_http_operator');
  assert.equal((await f.request('',{headers:{cookie:association.req.headers.cookie}})).status,403);
  assert.equal((await f.request('',{headers:{authorization:'Bearer SYNTHETIC-member-token'}})).status,403);
  for(const headers of [{host:'attacker.invalid'},{origin:'https://attacker.invalid'},{'sec-fetch-site':'cross-site'}])assert.equal((await f.request('',{headers})).status,403);
  for(const headers of [{origin:null},{'x-club-request':null},{origin:'http://127.0.0.1:1'}])assert.equal((await f.request('/preflight',{method:'POST',data:grantInput,headers})).status,403);
  const spoof=await f.request('/preflight',{method:'POST',data:grantInput,headers:{'x-club-actor':'someone-else'}});assert.equal(spoof.status,409);assert.equal(spoof.body.code,'ACTOR_CHANGED');
  const pre=await f.request('/preflight',{method:'POST',data:grantInput});
  await f.pg.query("DELETE FROM sessions WHERE user_id='admin'");
  const expired=await f.request('',{method:'POST',data:{...grantInput,idempotencyKey:randomUUID(),confirmationToken:pre.body.confirmationToken}});
  assert.equal(expired.status,401);assert.equal((await f.pg.query('SELECT * FROM collab_grants')).rows.length,0);
});

test('HTTP validates JSON size and shape, methods, query uniqueness and routing',async t=>{
  const f=await setup(t);
  const cases=[
    ['/preflight',{method:'POST',raw:'not-json'},400],
    ['/preflight',{method:'POST',data:[]},400],
    ['/preflight',{method:'POST',data:null},400],
    ['/preflight',{method:'POST',data:'scalar'},400],
    ['/preflight',{method:'POST',data:{...grantInput,actor:{role:'admin'}}},400],
    ['/preflight',{method:'POST',data:grantInput,headers:{'content-type':'text/plain'}},415],
    ['/preflight',{method:'POST',raw:JSON.stringify({...grantInput,reason:'x'.repeat(17000)})},413],
    ['/preflight',{method:'POST',raw:'x'.repeat(17000),headers:{'transfer-encoding':'chunked'}},413],
    ['',{method:'PATCH'},405],['/lookup',{},405],['/unknown',{},404],
    ['?limit=1&limit=2',{},400],['?userId=http-person&role=admin',{},400],
    ['/preflight?userId=http-person',{method:'POST',data:grantInput},400]
  ];
  for(const [path,options,status] of cases){const response=await f.request(path,options);assert.equal(response.status,status,JSON.stringify({path,options,response}));assert.ok(response.body.requestId);}
  const outside=await f.request('/api/admin/membership-grants-other');assert.equal(outside.body.fallback,true);
  assert.equal((await f.pg.query('SELECT * FROM collab_grants')).rows.length,0);
});

test('HTTP errors expose only fixed messages and a request ID',async t=>{
  const f=await setup(t,{serviceOverride:{list:async()=>{throw Object.assign(new Error('SELECT password_hash FROM users; SECRET_TOKEN_123'),{code:'XX000'});}}});
  const response=await f.request('');assert.equal(response.status,500);assert.equal(response.body.code,'INTERNAL_ERROR');
  assert.deepEqual(Object.keys(response.body).sort(),['code','message','requestId']);assert.ok(response.body.requestId);
  assert.ok(!response.text.includes('SELECT'));assert.ok(!response.text.includes('SECRET_TOKEN'));assert.ok(!response.text.includes('password_hash'));
});

test('HTTP recognizes known service failures without forwarding their messages',async t=>{
  const f=await setup(t,{serviceOverride:{list:async()=>{throw Object.assign(new Error('INTERNAL PRIVATE SQL'),{code:'PREFLIGHT_BLOCKED',status:500});}}});
  const response=await f.request('');assert.equal(response.status,409);assert.equal(response.body.code,'PREFLIGHT_BLOCKED');assert.ok(!response.text.includes('PRIVATE'));
});

test('HTTP administrator origin permits HTTPS and loopback HTTP only',()=>{
  const access={run:()=>{},authenticateInTransaction:()=>{}},grants={};
  for(const adminOrigin of ['http://ops.example.com','http://192.168.1.8','http://localhost.attacker.example','https://ops.example.com/path','ftp://localhost'])assert.throws(()=>createGrantHttpHandler({access,grants,adminOrigin}),/origin/);
  for(const adminOrigin of ['https://ops.example.com','http://localhost:1234','http://127.0.0.1:1234'])assert.equal(typeof createGrantHttpHandler({access,grants,adminOrigin}),'function');
});

test('HTTP database transient and migration failures return sanitized 503 without retrying',async t=>{
  let failure,calls=0;
  const f=await setup(t,{serviceOverride:{list:async()=>{calls++;throw failure;}}});
  const codes=['40001','40P01','55P03','57014','57P01','57P02','57P03','08006','ECONNRESET','ECONNREFUSED','EPIPE','ETIMEDOUT','GRANT_MIGRATION_INCONSISTENT','42P01'];
  for(const dbCode of codes){
    failure=Object.assign(new Error('PRIVATE CONNECTION STRING SELECT SECRET'),{code:dbCode});
    const before=calls,response=await f.request('');assert.equal(response.status,503);assert.equal(calls,before+1);
    assert.ok(!response.text.includes('PRIVATE'));assert.ok(!response.text.includes('SECRET'));assert.ok(!response.text.includes('SELECT'));
    assert.equal(response.body.code,dbCode==='GRANT_MIGRATION_INCONSISTENT'?dbCode:dbCode==='42P01'?'MIGRATION_NOT_READY':'DATABASE_UNAVAILABLE');
  }
  failure=new Error('Connection terminated unexpectedly');assert.equal((await f.request('')).body.code,'DATABASE_UNAVAILABLE');
});

test('HTTP operation lookup recovers a committed result for another admin with writes disabled',async t=>{
  const f=await setup(t),key=randomUUID();
  const pre=await f.request('/preflight',{method:'POST',data:grantInput});
  const created=await f.request('',{method:'POST',data:{...grantInput,idempotencyKey:key,confirmationToken:pre.body.confirmationToken}});assert.equal(created.status,200);
  await f.pg.query("INSERT INTO users(id,username,password_hash,role,created_at,referral_code,consent_version) VALUES('admin-two','synthetic_admin_two','synthetic','admin','2026','HTTP-ADMIN-2','fixture')");
  await f.pg.query('INSERT INTO sessions VALUES($1,$2,$3)',[digest('pg-admin:'+'b'.repeat(64)),'admin-two','2099-01-01T00:00:00.000Z']);
  f.setWritesDisabled();
  const recovered=await f.request('/operations/'+key,{headers:{cookie:'club_pg_admin='+'b'.repeat(64)}});
  assert.equal(recovered.status,200);assert.equal(recovered.body.found,true);assert.equal(recovered.body.outcome,'committed');
  assert.equal(recovered.body.grant.grantId,created.body.grantId);assert.equal(recovered.body.grant.startsAt,created.body.startsAt);
  const unknown=await f.request('/operations/'+randomUUID());assert.equal(unknown.status,200);assert.deepEqual(unknown.body,{found:false,outcome:'unknown',grant:null});
  assert.equal((await f.request('/operations/'+key,{headers:{cookie:null}})).status,401);
  assert.equal((await f.request('/operations/'+key+'?limit=1')).status,400);
  assert.equal((await f.request('/operations/'+key,{method:'POST',data:{}})).status,405);
  assert.equal((await f.request('/operations/short')).status,400);
  assert.equal((await f.request('',{method:'POST',data:{...grantInput,idempotencyKey:key,confirmationToken:pre.body.confirmationToken}})).status,503);
});

test('HTTP phone lookup without a trusted phone source returns a blocked result',async t=>{
  const f=await setup(t),response=await f.request('/lookup',{method:'POST',data:{type:'phone',value:'13800000000'}});
  assert.equal(response.status,200);assert.equal(response.body.verified,false);
  assert.ok(response.body.blockers.some(x=>x.code==='PHONE_VERIFICATION_UNAVAILABLE'));
  assert.ok(!response.text.includes('13800000000'));
});
