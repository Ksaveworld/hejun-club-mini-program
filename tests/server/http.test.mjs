import test from 'node:test';
import assert from 'node:assert/strict';
import { request as httpRequest } from 'node:http';
import { randomUUID } from 'node:crypto';
import { openDatabase } from '../../server/db.mjs';
import { createApplication } from '../../server/app.mjs';
import { insertUser, hashPassword, applyVerifiedPayment, createOrder } from '../../server/domain.mjs';

const password='OnlyIsolatedTestPassword1';
const orderBody=(planId='basic')=>({planId,consent:true,form:{name:'测试账号',phone:'13800000000',city:'上海',company:'测试机构',organizationType:'机构会员'}});
async function setup(t) {
  const db=openDatabase(':memory:');
  const server=createApplication(db,{hosts:['127.0.0.1'],origins:['http://127.0.0.1']});
  await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));
  const url=`http://127.0.0.1:${server.address().port}`;
  t.after(async()=>{await new Promise(resolve=>server.close(resolve));db.close();});
  async function request(path,{body,cookie='',headers={},method}={}) {
    return new Promise((resolve,reject)=>{
      const req=httpRequest(`${url}/api${path}`,{method:method||(body===undefined?'GET':'POST'),headers:{Host:'127.0.0.1','Content-Type':'application/json','X-Club-Request':'1',Cookie:cookie,...headers}},res=>{
        const chunks=[];res.on('data',chunk=>chunks.push(chunk));res.on('end',()=>{
          const get=name=>res.headers[name.toLowerCase()]?.toString() ?? null;
          resolve({status:res.statusCode,body:JSON.parse(Buffer.concat(chunks).toString('utf8')),cookie:get('set-cookie')?.split(';')[0],headers:{get}});
        });
      });
      req.on('error',reject);req.end(body===undefined?undefined:JSON.stringify(body));
    });
  }
  async function register(username) {const r=await request('/auth/register',{body:{username,password,consent:true,role:'admin'}});assert.equal(r.status,201);return r;}
  return {db,request,register};
}

test('HTTP registration hashes credentials, forces member role, validates login and destroys logout session',async t=>{
  const {db,request,register}=await setup(t);
  const signup=await register('alice');
  assert.equal(signup.body.user.role,'member');
  assert.match(signup.headers.get('set-cookie'),/HttpOnly/); assert.match(signup.headers.get('set-cookie'),/SameSite=Strict/);
  assert.notEqual(db.prepare('SELECT password_hash FROM users').get().password_hash,password);
  assert.ok(!JSON.stringify(signup.body).includes('password'));
  assert.notEqual(db.prepare('SELECT token_hash FROM sessions').get().token_hash,signup.cookie.split('=')[1]);
  assert.equal((await request('/auth/login',{body:{username:'alice',password:'wrongpassword'}})).status,401);
  const login=await request('/auth/login',{body:{username:'alice',password}});assert.equal(login.status,200);
  assert.equal((await request('/me',{cookie:login.cookie})).body.user.username,'alice');
  await request('/auth/logout',{body:{},cookie:login.cookie});
  assert.equal((await request('/me',{cookie:login.cookie})).body.user,null);
  db.prepare("UPDATE sessions SET expires_at='2000-01-01T00:00:00.000Z'").run();
  assert.equal((await request('/me',{cookie:signup.cookie})).body.user,null);
});
test('HTTP isolates member orders, administrator records, CSRF origins, unauthenticated access',async t=>{
  const {db,request,register}=await setup(t);
  const a=await register('alice'),b=await register('bobby');
  const order=await request('/orders',{body:orderBody(),cookie:a.cookie,headers:{'Idempotency-Key':randomUUID()}});
  assert.equal(order.status,201);const id=order.body.order.id;
  assert.equal((await request(`/orders/${id}`,{cookie:b.cookie})).status,404);
  assert.equal((await request(`/orders/${id}/cancel`,{body:{},cookie:b.cookie})).status,404);
  assert.equal((await request('/orders',{cookie:b.cookie})).body.orders.length,0);
  assert.equal((await request('/orders')).status,401);
  assert.equal((await request('/admin/orders',{cookie:a.cookie})).status,403);
  assert.equal((await request('/admin/members',{cookie:a.cookie})).status,403);
  assert.equal((await request('/auth/logout',{body:{},cookie:a.cookie,headers:{Origin:'https://evil.example'}})).status,403);
  assert.equal((await request('/auth/logout',{body:{},cookie:a.cookie,headers:{'X-Club-Request':''}})).status,403);
  assert.equal((await request('/me',{cookie:a.cookie,headers:{Host:'evil.example'}})).status,403);
  insertUser(db,'admin',await hashPassword(password),'admin');
  const admin=await request('/auth/login',{body:{username:'admin',password}});
  assert.equal((await request('/admin/orders',{cookie:admin.cookie})).body.orders[0].id,id);
  assert.equal((await request('/admin/audit',{cookie:admin.cookie})).status,200);
});
test('HTTP payment is fail closed, success cannot be forged, repeated clicks create one record',async t=>{
  const {db,request,register}=await setup(t);const user=await register('alice');
  const headers={'Idempotency-Key':randomUUID()},body=orderBody();
  const results=await Promise.all([request('/orders',{body,cookie:user.cookie,headers}),request('/orders',{body,cookie:user.cookie,headers})]);
  assert.equal(results[0].body.order.id,results[1].body.order.id);
  const id=results[0].body.order.id;
  assert.equal((await request(`/orders/${id}/payment`,{body:{status:'paid'},cookie:user.cookie})).status,503);
  assert.equal((await request('/payments/notify',{body:{orderId:id,status:'SUCCESS'},cookie:user.cookie})).status,404);
  assert.equal((await request(`/orders/${id}`,{body:{status:'paid'},cookie:user.cookie})).status,404);
  assert.equal(db.prepare('SELECT count(*) n FROM memberships').get().n,0);
  assert.equal((await request(`/orders/${id}`,{cookie:user.cookie})).body.order.status,'pending');
});
test('HTTP rejects invalid data, malformed JSON, missing consent and excessive login attempts',async t=>{
  const {request,register}=await setup(t);
  assert.equal((await request('/auth/register',{body:{username:'validname',password}})).status,400);
  assert.equal((await request('/auth/register',{body:null})).status,400);
  const user=await register('alice');
  assert.equal((await request('/orders',{body:orderBody(),cookie:user.cookie})).status,400);
  assert.equal((await request('/orders',{body:{...orderBody(),planId:'__proto__'},cookie:user.cookie,headers:{'Idempotency-Key':randomUUID()}})).status,400);
  let response;
  for(let i=0;i<26;i++) response=await request('/auth/login',{body:{username:'alice',password:'wrongpassword'}});
  assert.equal(response.status,429);
});
test('HTTP content is member gated, owner isolated and is immediately visible to registered readers after publication',async t=>{
  const {db,request,register}=await setup(t);
  const user=await register('alice'),other=await register('bobby');
  const headers={'Idempotency-Key':randomUUID()},body={title:'测试文字',body:'仅用于独立测试数据库'};
  assert.equal((await request('/posts',{body,cookie:user.cookie,headers})).status,403);
  const order=createOrder(db,user.body.user.id,orderBody(),randomUUID());
  applyVerifiedPayment(db,{transactionId:randomUUID(),orderId:order.id,currency:'CNY',amountCents:order.amountCents,status:'SUCCESS',paidAt:new Date().toISOString(),merchantId:'TEST',appId:'TEST'}, {merchantId:'TEST',appId:'TEST'});
  const post=await request('/posts',{body,cookie:user.cookie,headers});assert.equal(post.status,201);
  assert.equal((await request('/posts',{body,cookie:user.cookie,headers})).body.post.id,post.body.post.id);
  assert.equal((await request('/content')).status,401);
  assert.equal((await request('/content',{cookie:other.cookie})).body.posts.length,1);
  assert.equal((await request('/posts',{cookie:other.cookie})).body.posts.length,0);
  insertUser(db,'admin',await hashPassword(password),'admin');
  const admin=await request('/auth/login',{body:{username:'admin',password}});
  const path=`/admin/posts/${post.body.post.id}/review`;
  assert.equal((await request(path,{body:{status:'published'},cookie:user.cookie})).status,403);
  assert.equal((await request(path,{body:{status:'rejected'},cookie:admin.cookie})).status,400);
  assert.equal((await request(path,{body:{status:'published'},cookie:admin.cookie})).status,200);
  const anonymous = await request('/content');
  assert.equal(anonymous.status,401);
  assert.equal(anonymous.body.posts,undefined);
  assert.equal((await request('/content',{cookie:other.cookie})).body.posts[0].title,body.title);
  assert.equal((await request('/content',{cookie:user.cookie})).body.posts[0].title,body.title);
  db.prepare("UPDATE memberships SET expires_at='2000-01-01T00:00:00.000Z'").run();
  assert.equal((await request('/content',{cookie:user.cookie})).body.posts[0].title,body.title);
  db.prepare("UPDATE sessions SET expires_at='2000-01-01T00:00:00.000Z' WHERE user_id=?").run(other.body.user.id);
  assert.equal((await request('/content',{cookie:other.cookie})).status,401);
  assert.equal((await request('/posts',{body,cookie:user.cookie,headers:{'Idempotency-Key':randomUUID()}})).status,403);
});
