import test from 'node:test';
import assert from 'node:assert/strict';
import {createPostgresRateLimiter} from '../../server/postgres-rate-limit.mjs';

const req=(remoteAddress,headers={})=>({socket:{remoteAddress},headers});
const rejects=(fn,message)=>assert.throws(fn,error=>error.status===429&&error.message===message);
const busy='服务繁忙，请稍后重试',frequent='操作过于频繁，请稍后重试';

test('scopes and addresses count independently and excess requests return 429',()=>{
  let clock=1000;const limit=createPostgresRateLimiter({now:()=>clock});
  limit(req('10.0.0.1'),'login',2);limit(req('10.0.0.1'),'login',2);
  rejects(()=>limit(req('10.0.0.1'),'login',2),frequent);
  limit(req('10.0.0.1'),'survey',2);limit(req('10.0.0.2'),'login',2);
});

test('a full table rejects new keys while existing keys keep counting',()=>{
  let clock=1000;const limit=createPostgresRateLimiter({now:()=>clock,capacity:2});
  limit(req('10.0.0.1'),'login',3);limit(req('10.0.0.2'),'login',3);
  rejects(()=>limit(req('10.0.0.3'),'login',3),busy);
  rejects(()=>limit(req('10.0.0.1'),'other',3),busy);
  limit(req('10.0.0.1'),'login',3);limit(req('10.0.0.1'),'login',3);
  rejects(()=>limit(req('10.0.0.1'),'login',3),frequent);
});

test('expired windows reset counts and release capacity',()=>{
  let clock=1000;const limit=createPostgresRateLimiter({now:()=>clock,capacity:1});
  limit(req('10.0.0.1'),'login',1);rejects(()=>limit(req('10.0.0.1'),'login',1),frequent);
  rejects(()=>limit(req('10.0.0.2'),'login',1),busy);
  clock+=59999;rejects(()=>limit(req('10.0.0.1'),'login',1),frequent);
  clock+=1;limit(req('10.0.0.2'),'login',1);
  rejects(()=>limit(req('10.0.0.1'),'login',1),busy);
  clock+=60000;limit(req('10.0.0.1'),'login',1);
});

test('forwarded headers cannot create new keys or bypass a full table',()=>{
  let clock=1000;const limit=createPostgresRateLimiter({now:()=>clock,capacity:1});
  limit(req('10.0.0.9',{'x-forwarded-for':'1.1.1.1'}),'login',1);
  for(const headers of [{'x-forwarded-for':'2.2.2.2'},{'x-real-ip':'3.3.3.3'},{forwarded:'for=4.4.4.4'},{'x-client-ip':'5.5.5.5'}])
    rejects(()=>limit(req('10.0.0.9',headers),'login',1),frequent);
  rejects(()=>limit(req('10.0.0.8',{'x-real-ip':'10.0.0.9'}),'login',1),busy);
});

test('invalid configuration is rejected',()=>{
  for(const options of [{capacity:0},{capacity:1.5},{capacity:'10'},{now:1}])assert.throws(()=>createPostgresRateLimiter(options));
});
