import test from 'node:test';
import assert from 'node:assert/strict';
import {createServer} from 'node:http';
import {randomUUID} from 'node:crypto';
import {fixture} from '../collaboration/fixture.mjs';
import {createSingleGrants} from '../../server/collaboration/single-grants.mjs';
import {createGrantIdentityVerifier} from '../../server/collaboration/grant-identity.mjs';
import {createGrantHttpHandler} from '../../server/collaboration/grant-http.mjs';
import {createGrantHttpGateway} from '../../src/grants/http-gateway.ts';
import {GrantRejection} from '../../src/grants/contract.ts';

const root='/api/admin/membership-grants';
const draft={userId:'gateway-person',level:'basic',reason:'SYNTHETIC gateway grant',approvalReference:'SYNTHETIC-GATEWAY-APPROVAL'};
async function setup(t) {
  const f=await fixture(t);
  await f.pg.exec("ALTER TABLE collab_grants DROP CONSTRAINT collab_grants_level_check; ALTER TABLE collab_grants ADD CONSTRAINT collab_grants_level_check CHECK(level IN ('basic','star')); INSERT INTO users(id,username,password_hash,role,created_at,referral_code,consent_version) VALUES('gateway-person','synthetic_gateway_person','synthetic','member','2026','GATEWAY-REF','fixture'); INSERT INTO wechat_identities VALUES('synthetic-gateway-app','synthetic-gateway-openid','gateway-person','2026')");
  const control={loseIssue:false,malformedIssue:false,changeAfterIssue:false,phoneTrusted:false,requests:[],actorId:'admin'};
  const options={policy:{approved:true,startRule:'confirmation-time',timeZone:'Asia/Shanghai',yearRule:'calendar-anniversary-clamp',overlap:'block-active',version:'SYNTHETIC-GATEWAY-v1'},
    clock:()=>new Date().toISOString(),confirmationSecret:'SYNTHETIC-GATEWAY-SECRET-AT-LEAST-32',writesEnabled:true,writeCoordinationReady:true,
    identityVerifier:createGrantIdentityVerifier({resolveEvidence:async(_c,{userId})=>({verified:true,userId,appId:'synthetic-gateway-app',openId:'synthetic-gateway-openid',reference:'SYNTHETIC-GATEWAY-IDENTITY',revision:'1'})}),
    phoneResolver:async(_c,{phone})=>({available:control.phoneTrusted,matches:[{verified:true,phone,userId:'gateway-person',reference:'SYNTHETIC-PHONE',revision:'1'}]}),
    approvalResolver:async(_c,r)=>({approved:true,userId:r.userId,level:r.level,reference:r.approvalReference,revision:'1'})};
  let handler;
  const server=createServer((req,res)=>{void (async()=>{
    if(req.url==='/api/test/current-admin'){
      try{const actor=await f.access.authenticate(req);await f.access.run(c=>f.access.platform(c,actor));res.writeHead(200,{'content-type':'application/json'});res.end(JSON.stringify({actorId:control.actorId,canGrant:actor.role==='admin'}));}
      catch{res.writeHead(401,{'content-type':'application/json'});res.end(JSON.stringify({actorId:'',canGrant:false}));}return;
    }
    if(!await handler(req,res)){res.writeHead(404,{'content-type':'application/json'});res.end('{}');}
  })().catch(()=>{res.writeHead(500,{'content-type':'application/json'});res.end('{}');});});
  await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));
  const origin='http://127.0.0.1:'+server.address().port;
  const mount=overrides=>{handler=createGrantHttpHandler({access:f.access,grants:createSingleGrants(f.access,{...options,...overrides}),adminOrigin:origin});};mount({});
  t.after(()=>new Promise(resolve=>{server.closeAllConnections();server.close(resolve);}));
  const authenticatedFetch=async(path,init={})=>{
    const headers=new Headers(init.headers);headers.set('cookie','club_pg_admin='+'a'.repeat(64));
    if(init.method==='POST')headers.set('origin',origin);
    if(path.startsWith(root))control.requests.push({path,method:init.method??'GET',body:init.body?JSON.parse(init.body):null});
    const response=await fetch(origin+path,{...init,headers});
    if(path===root&&init.method==='POST'){
      if(control.loseIssue){control.loseIssue=false;await response.text();throw Error('SYNTHETIC reply lost after commit');}
      if(control.malformedIssue){control.malformedIssue=false;await response.text();return new Response('{broken',{status:200,headers:{'content-type':'application/json'}});}
      if(control.changeAfterIssue){control.changeAfterIssue=false;control.actorId='different-admin';}
    }
    return response;
  };
  const checkSession=async()=>{const response=await authenticatedFetch('/api/test/current-admin');return response.json();};
  const gateway=createGrantHttpGateway({actorId:'admin',checkSession,fetchImpl:authenticatedFetch});
  return {...f,gateway,control,disableWrites:()=>mount({writesEnabled:false})};
}

test('real HTTP gateway maps identity, explicit level, preflight, issue, list and revoke DTOs',async t=>{
  const f=await setup(t);assert.equal((await f.gateway.checkSession()).actorId,'admin');
  const user=await f.gateway.lookup({type:'userId',value:draft.userId});assert.equal(user.matches.length,1);assert.equal(user.matches[0].displayName,draft.userId);
  assert.ok(!JSON.stringify(user).includes('synthetic-gateway-openid'));
  const pre=await f.gateway.preflight(draft);assert.equal(pre.userId,draft.userId);assert.equal(pre.level,'basic');assert.equal(pre.ready,true);assert.ok(pre.confirmationExpiresAt);
  const input={...draft,confirmationToken:pre.confirmationToken,idempotencyKey:randomUUID()},issued=await f.gateway.issue(input);
  assert.equal(issued.grant.level,'basic');assert.equal(issued.grant.actor,'admin');assert.equal(issued.duplicate,false);
  const history=await f.gateway.list({userId:draft.userId});assert.equal(history.items.length,1);assert.equal(history.nextCursor,undefined);
  const revokeInput={grantId:issued.grant.grantId,userId:draft.userId,reason:'SYNTHETIC revoke',idempotencyKey:randomUUID()};
  const revoked=await f.gateway.revoke(revokeInput);assert.equal(revoked.grant.status,'revoked');
  const request=f.control.requests.find(x=>x.path.endsWith('/revoke'));assert.deepEqual(Object.keys(request.body),['reason']);
  f.disableWrites();const recovered=await f.gateway.recover({kind:'revoke',input:revokeInput});assert.equal(recovered.grant.grantId,issued.grant.grantId);assert.equal(recovered.duplicate,true);
});

test('lost HTTP response preserves original key and operation lookup recovers without issuing again',async t=>{
  const f=await setup(t),pre=await f.gateway.preflight(draft),input={...draft,confirmationToken:pre.confirmationToken,idempotencyKey:randomUUID()};
  f.control.loseIssue=true;await assert.rejects(f.gateway.issue(input),e=>!(e instanceof GrantRejection));
  assert.equal((await f.pg.query('SELECT * FROM collab_grants')).rows.length,1);
  f.disableWrites();const recovered=await f.gateway.recover({kind:'issue',input});
  assert.equal(recovered.duplicate,true);assert.equal(recovered.grant.userId,draft.userId);
  assert.equal(f.control.requests.filter(x=>x.path===root&&x.method==='POST').length,1);
  assert.ok(f.control.requests.some(x=>x.path.endsWith('/operations/'+input.idempotencyKey)));
  const unknown=await f.gateway.recover({kind:'issue',input:{...input,idempotencyKey:randomUUID()}});assert.equal(unknown,null);
});

test('malformed success and actor switch after commit are ambiguous, while real pre-commit rejection is definite',async t=>{
  const f=await setup(t),pre=await f.gateway.preflight(draft),input={...draft,confirmationToken:pre.confirmationToken,idempotencyKey:randomUUID()};
  f.control.malformedIssue=true;await assert.rejects(f.gateway.issue(input),e=>!(e instanceof GrantRejection));
  const recovered=await f.gateway.recover({kind:'issue',input});assert.ok(recovered.grant.grantId);
  f.control.changeAfterIssue=true;await assert.rejects(f.gateway.issue(input),e=>!(e instanceof GrantRejection));
  f.control.actorId='admin';
  await assert.rejects(f.gateway.issue({...input,reason:'SYNTHETIC conflicting reason'}),e=>e instanceof GrantRejection&&e.code==='IDEMPOTENCY_CONFLICT');
  assert.equal((await f.pg.query('SELECT * FROM collab_grants')).rows.length,1);
});

test('phone lookup is blocked without trusted source; approved binding is masked; session loss prevents dispatch',async t=>{
  const f=await setup(t),phone={type:'phone',value:'+99900000001'};
  const blocked=await f.gateway.lookup(phone);assert.equal(blocked.matches.length,0);assert.ok(blocked.blockers[0].includes('可信手机号'));
  f.control.phoneTrusted=true;const found=await f.gateway.lookup(phone);assert.equal(found.matches.length,1);assert.ok(found.matches[0].maskedContact.includes('****'));assert.ok(!JSON.stringify(found).includes(phone.value));
  await f.pg.query("DELETE FROM sessions WHERE user_id='admin'");const before=f.control.requests.length;
  await assert.rejects(f.gateway.lookup({type:'userId',value:draft.userId}),e=>e instanceof GrantRejection);assert.equal(f.control.requests.length,before);
});

test('unresponsive session verification times out without dispatching a business request',async()=>{
  let calls=0;
  const gateway=createGrantHttpGateway({actorId:'admin',timeoutMs:20,checkSession:()=>new Promise(()=>{}),fetchImpl:async()=>{calls++;throw Error('must not dispatch');}});
  await assert.rejects(gateway.lookup({type:'userId',value:'synthetic'}),e=>!(e instanceof GrantRejection));
  assert.equal(calls,0);
});
