import {brotliDecompressSync} from 'node:zlib';
import {createHash} from 'node:crypto';
import {reviewScopeSnapshot,reviewScopeDigest} from './review-access-scope.mjs';

export const cloudRuntimeEnvelopeKey='CLUB_RUNTIME_ENVELOPE_BR';
export const cloudRuntimeEnvelopeKeys=Object.freeze([
  'CLUB_RUNTIME_JSON','CLUB_INITIALIZE_FRESH_SCHEMA','CLUB_INITIALIZE_REPORT_STORE',
  'CLUB_INITIALIZE_VIRTUAL_PAYMENT_SCHEMA','CLUB_INITIALIZE_POST_VERSIONS_SCHEMA',
  'CLUB_INITIALIZE_RENEWALS_SCHEMA','CLUB_INITIALIZE_REVIEW_ACCESS_SCHEMA',
  'CLUB_REVIEW_ACCOUNT_BOOTSTRAP_JSON','CLUB_VERIFY_VIRTUAL_TOKEN_APPID',
  'CLUB_INCREMENTAL_REPORT_MANIFEST_SHA256','CLUB_INCREMENTAL_REPORT_SCHEMA','CLUB_INCREMENTAL_REPORT_MODE',
  'CLUB_ADMIN_BOOTSTRAP_JSON',
]);
const exact=(value,keys)=>value&&typeof value==='object'&&!Array.isArray(value)
  &&Object.keys(value).length===keys.length&&Object.keys(value).every(key=>keys.includes(key));

// Compression is transport only, not encryption. The encoded value stays in
// the private service environment. Public report IDs live in this server bundle;
// credentials, hashes, approval and runtime values never do.
export function decodeCloudRuntimeEnvironment(env){
  if(env[cloudRuntimeEnvelopeKey]===undefined)return env;
  try{
    if(Object.keys(env).some(key=>key.startsWith('CLUB_')&&key!==cloudRuntimeEnvelopeKey))throw Error();
    const encoded=env[cloudRuntimeEnvelopeKey];
    if(typeof encoded!=='string'||encoded.length===0||Buffer.byteLength(encoded)>5000
      ||encoded.length%4!==0||! /^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/.test(encoded))throw Error();
    const bytes=Buffer.from(encoded,'base64');
    if(bytes.toString('base64')!==encoded)throw Error();
    const expanded=brotliDecompressSync(bytes,{maxOutputLength:65536});
    const payload=JSON.parse(new TextDecoder('utf-8',{fatal:true}).decode(expanded));
    if(!exact(payload,['version','environment'])||payload.version!==1
      ||!payload.environment||typeof payload.environment!=='object'||Array.isArray(payload.environment))throw Error();
    const environment=payload.environment;
    if(!Object.keys(environment).every(key=>cloudRuntimeEnvelopeKeys.includes(key))
      ||!Object.hasOwn(environment,'CLUB_RUNTIME_JSON')||Object.keys(environment).length===0
      ||Object.values(environment).some(value=>typeof value!=='string'||value.length===0||Buffer.byteLength(value)>20000))throw Error();
    if(environment.CLUB_REVIEW_ACCOUNT_BOOTSTRAP_JSON!==undefined){
      const bootstrap=JSON.parse(environment.CLUB_REVIEW_ACCOUNT_BOOTSTRAP_JSON);
      if(createHash('sha256').update(JSON.stringify(reviewScopeSnapshot)).digest('hex')!==reviewScopeDigest
        ||bootstrap.appId!==reviewScopeSnapshot.appId||bootstrap.appVersion!==reviewScopeSnapshot.appVersion
        ||bootstrap.schema!==reviewScopeSnapshot.schema||!Array.isArray(bootstrap.accounts)||bootstrap.accounts.length!==2)throw Error();
      bootstrap.accounts=bootstrap.accounts.map(account=>{
        if(!exact(account,['id','username','planId','passwordHash','scopeDigest'])||account.scopeDigest!==reviewScopeDigest)throw Error();
        const {scopeDigest,...identity}=account;
        return {...identity,scope:{articleIds:[...reviewScopeSnapshot.scope.articleIds],resourceIds:[]}};
      });
      environment.CLUB_REVIEW_ACCOUNT_BOOTSTRAP_JSON=JSON.stringify(bootstrap);
    }
    return {...env,...environment};
  }catch{
    // Never include compressed/private input, decompressor errors or causes.
    throw Error('Invalid private cloud runtime envelope');
  }
}
