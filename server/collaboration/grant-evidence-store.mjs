import {readFileSync} from 'node:fs';
import {createHash} from 'node:crypto';
import {postgresTransaction} from '../postgres.mjs';
import {fail,one,audit,string} from './common.mjs';
import {normalizeEntitlementTime} from './entitlements.mjs';
import {createGrantIdentityVerifier,isOperationalAccount} from './grant-identity.mjs';

const sql=readFileSync(new URL('./grant-evidence-schema.sql',import.meta.url),'utf8').replace(/\r\n/g,'\n');
const hash=value=>createHash('sha256').update(value).digest('hex');
export const grantEvidenceMigration=Object.freeze({key:'_club_grant_evidence_v1',version:'grant-evidence-v1',sha256:hash(sql)});
const tables=['grant_person_evidence','grant_person_approvals'];
const invalid=(ok)=>fail(ok,'Evidence schema requires explicit migration review',503,'EVIDENCE_MIGRATION_INCONSISTENT');
const checkSchema=s=>fail(/^club_migration_[a-z0-9_]{1,40}$/.test(s||''),'Explicit isolated schema required');
async function catalog(c,schema){
 const cols=(await c.query(`SELECT t.relname,a.attname,format_type(a.atttypid,a.atttypmod) AS type,a.attnotnull,
   pg_get_expr(d.adbin,d.adrelid) AS default_value
   FROM pg_class t JOIN pg_namespace n ON n.oid=t.relnamespace JOIN pg_attribute a ON a.attrelid=t.oid
   LEFT JOIN pg_attrdef d ON d.adrelid=t.oid AND d.adnum=a.attnum
   WHERE n.nspname=$1 AND t.relname=ANY($2::text[]) AND t.relkind='r' AND a.attnum>0 AND NOT a.attisdropped
   ORDER BY t.relname,a.attnum`,[schema,tables])).rows;
 const constraints=(await c.query(`SELECT t.relname,k.conname,k.convalidated,pg_get_constraintdef(k.oid) AS definition
   FROM pg_constraint k JOIN pg_class t ON t.oid=k.conrelid JOIN pg_namespace n ON n.oid=t.relnamespace
   WHERE n.nspname=$1 AND t.relname=ANY($2::text[]) ORDER BY t.relname,k.conname`,[schema,tables])).rows;
 const triggers=(await c.query(`SELECT t.relname,g.tgname,g.tgenabled,pg_get_triggerdef(g.oid) AS definition
   FROM pg_trigger g JOIN pg_class t ON t.oid=g.tgrelid JOIN pg_namespace n ON n.oid=t.relnamespace
   WHERE n.nspname=$1 AND t.relname=ANY($2::text[]) AND NOT g.tgisinternal ORDER BY t.relname,g.tgname`,[schema,tables])).rows;
 return {names:[...new Set(cols.map(r=>r.relname))].sort(),fingerprint:hash(JSON.stringify({cols,constraints,triggers}))};
}
async function migration(c,schema,initialize){
 checkSchema(schema);await c.query(`SET LOCAL search_path TO "${schema}"`);
 if(initialize)await c.query('LOCK TABLE settings IN SHARE ROW EXCLUSIVE MODE');
 let saved=await one(c,'SELECT value FROM settings WHERE key=$1',[grantEvidenceMigration.key]);
 let physical=await catalog(c,schema);
 if(!saved){
  if(!initialize){invalid(false);}
  invalid(physical.names.length===0);
  for(const statement of sql.split(';').map(s=>s.trim()).filter(Boolean))await c.query(statement);
  physical=await catalog(c,schema);
  const value=JSON.stringify({...grantEvidenceMigration,catalogSha256:physical.fingerprint});
  await c.query('INSERT INTO settings(key,value) VALUES($1,$2)',[grantEvidenceMigration.key,value]);
  saved={value};
 }
 let marker;try{marker=JSON.parse(saved.value);}catch{invalid(false);}
 invalid(marker.version===grantEvidenceMigration.version&&marker.sha256===grantEvidenceMigration.sha256&&
  marker.catalogSha256===physical.fingerprint&&JSON.stringify(physical.names)===JSON.stringify([...tables].sort()));
 return {version:marker.version,sha256:marker.sha256};
}
// Explicit installer only: never called by startup, never adopts unknown/partial tables or deletes data.
export function initializeGrantEvidenceDatabase(pool,{schema}={}){
 return postgresTransaction(pool,c=>migration(c,schema,true));
}
export function validateGrantEvidenceDatabase(pool,{schema}={}){
 return postgresTransaction(pool,c=>migration(c,schema,false));
}
// Fresh-host discovery: absence is allowed; partial/unmarked/drifted installs fail closed.
export async function grantEvidenceTables(c,schema){
 checkSchema(schema);await c.query(`SET LOCAL search_path TO "${schema}"`);
 const marker=await one(c,'SELECT value FROM settings WHERE key=$1',[grantEvidenceMigration.key]);
 const physical=await catalog(c,schema);
 if(!marker&&physical.names.length===0)return [];
 await migration(c,schema,false);return [...tables];
}
const object=(v,keys)=>fail(v&&typeof v==='object'&&!Array.isArray(v)&&Object.keys(v).every(k=>keys.includes(k)),'Unsupported evidence fields');
const version=v=>{fail(Number.isSafeInteger(v)&&v>=0,'Expected revision required');return v;};
const view=r=>({userId:r.user_id,revision:Number(r.revision),active:r.active,expiresAt:r.expires_at,
 ...(r.reference?{reference:r.reference,level:r.level}:{evidenceReference:r.evidence_reference})});

// Deliberately no HTTP registration, phone binding, or default enablement. This service
// records an administrator's external verification; it does not claim to verify a person itself.
export function createGrantEvidenceStore(access,{clock=()=>new Date().toISOString(),writesEnabled=false}={}){
 const now=()=>normalizeEntitlementTime(clock());
 const future=(value,at)=>{const end=normalizeEntitlementTime(value);fail(Date.parse(end)>Date.parse(at),'Evidence must expire in the future');return end;};
 async function person(c,userId){
  const user=await one(c,'SELECT id,role FROM users WHERE id=$1 FOR SHARE',[userId]);
  fail(user?.role==='member'&&!await isOperationalAccount(c,userId),'Consumer account required',409,'USER_UNAVAILABLE');
 }
 async function mutate(actor,fn){
  fail(writesEnabled===true,'Evidence writes disabled',503,'FEATURE_DISABLED');
  return access.run(async c=>{
   // Same order as the actual payment/grant host: global users lock before session/evidence rows.
   await c.query('LOCK TABLE users IN SHARE ROW EXCLUSIVE MODE');await access.platform(c,actor);
   const result=await fn(c,now());
   // Locks preserve rows, not the passage of time. Recheck authorization before commit.
   await access.platform(c,actor);
   fail(!result.active||Date.parse(result.expiresAt)>Date.parse(now()),'Evidence expired during operation',409,'EVIDENCE_EXPIRED');
   return result;
  });
 }
 async function resolveEvidence(c,{userId,actor,now:at}){
  await access.platform(c,actor);
  const r=await one(c,'SELECT * FROM grant_person_evidence WHERE user_id=$1 FOR SHARE',[userId]);
  if(!r||!r.active||Date.parse(r.expires_at)<=Date.parse(at))return null;
  return {verified:true,userId:r.user_id,appId:r.app_id,openId:r.open_id,reference:r.evidence_reference,
   revision:String(r.revision),expiresAt:r.expires_at};
 }
 async function approvalResolver(c,{userId,level,approvalReference,actor,now:at}){
  await access.platform(c,actor);
  const evidence=await one(c,'SELECT * FROM grant_person_evidence WHERE user_id=$1 FOR SHARE',[userId]);
  const r=await one(c,'SELECT * FROM grant_person_approvals WHERE reference=$1 FOR SHARE',[approvalReference]);
  if(!r||!r.active||r.user_id!==userId||r.level!==level||Date.parse(r.expires_at)<=Date.parse(at)||
    !evidence?.active||Date.parse(evidence.expires_at)<=Date.parse(at)||String(r.identity_revision)!==String(evidence.revision))return null;
  return {approved:true,userId:r.user_id,level:r.level,reference:r.reference,revision:String(r.revision),expiresAt:r.expires_at};
 }
 return Object.freeze({resolveEvidence,identityVerifier:createGrantIdentityVerifier({resolveEvidence}),approvalResolver,
  // Manual phone entry cannot establish possession; unavailable until a separate trusted binding implementation.
  phoneResolver:async(c,{actor})=>{await access.platform(c,actor);return {available:false,matches:[]};},
  recordIdentity:(actor,input)=>mutate(actor,async(c,at)=>{
   object(input,['userId','appId','openId','evidenceReference','expiresAt','expectedRevision']);
   const userId=string(input.userId,'userId'),appId=string(input.appId,'appId'),openId=string(input.openId,'openId'),
    reference=string(input.evidenceReference,'evidenceReference'),expiresAt=future(input.expiresAt,at),expected=version(input.expectedRevision);
   await person(c,userId);
   const binding=await one(c,'SELECT user_id FROM wechat_identities WHERE app_id=$1 AND open_id=$2 FOR SHARE',[appId,openId]);
   fail(binding?.user_id===userId,'WeChat account binding does not match',409,'IDENTITY_CHANGED');
   const prior=await one(c,'SELECT * FROM grant_person_evidence WHERE user_id=$1 FOR UPDATE',[userId]);
   if(prior?.active&&prior.app_id===appId&&prior.open_id===openId&&prior.evidence_reference===reference&&prior.expires_at===expiresAt&&
      (expected===Number(prior.revision)||expected===Number(prior.revision)-1))return {...view(prior),duplicate:true};
   fail(expected===Number(prior?.revision??0),'Evidence changed',409,'VERSION_CONFLICT');
   const revision=expected+1;
   const r=await one(c,`INSERT INTO grant_person_evidence VALUES($1,$2,$3,$4,$5,$6,true,$7,$8)
    ON CONFLICT(user_id) DO UPDATE SET app_id=EXCLUDED.app_id,open_id=EXCLUDED.open_id,evidence_reference=EXCLUDED.evidence_reference,
    revision=EXCLUDED.revision,expires_at=EXCLUDED.expires_at,active=true,actor_id=EXCLUDED.actor_id,changed_at=EXCLUDED.changed_at RETURNING *`,
    [userId,appId,openId,reference,revision,expiresAt,actor.id,at]);
   await audit(c,actor.id,'grant.identity.recorded',userId,{reference,revision},at);return {...view(r),duplicate:false};
  }),
  recordApproval:(actor,input)=>mutate(actor,async(c,at)=>{
   object(input,['userId','level','reference','expiresAt','expectedRevision']);
   const userId=string(input.userId,'userId'),reference=string(input.reference,'reference'),expiresAt=future(input.expiresAt,at),expected=version(input.expectedRevision);
   fail(['basic','star'].includes(input.level),'Explicit basic or star level required');await person(c,userId);
   const evidence=await resolveEvidence(c,{userId,actor,now:at});fail(evidence,'Current identity evidence required',409,'IDENTITY_UNVERIFIED');
   const verified=await createGrantIdentityVerifier({resolveEvidence})(c,{userId,actor,now:at});fail(verified.verified,'Identity binding changed',409,'IDENTITY_CHANGED');
   const prior=await one(c,'SELECT * FROM grant_person_approvals WHERE reference=$1 FOR UPDATE',[reference]);
   fail(!prior||(prior.user_id===userId&&prior.level===input.level),'Approval reference is bound to another target or level',409,'APPROVAL_CONFLICT');
   if(prior?.active&&prior.expires_at===expiresAt&&String(prior.identity_revision)===evidence.revision&&
     (expected===Number(prior.revision)||expected===Number(prior.revision)-1))return {...view(prior),duplicate:true};
   fail(expected===Number(prior?.revision??0),'Approval changed',409,'VERSION_CONFLICT');
   const revision=expected+1;
   const r=await one(c,`INSERT INTO grant_person_approvals VALUES($1,$2,$3,$4,$5,$6,true,$7,$8)
    ON CONFLICT(reference) DO UPDATE SET identity_revision=EXCLUDED.identity_revision,revision=EXCLUDED.revision,
    expires_at=EXCLUDED.expires_at,active=true,actor_id=EXCLUDED.actor_id,changed_at=EXCLUDED.changed_at RETURNING *`,
    [reference,userId,input.level,evidence.revision,revision,expiresAt,actor.id,at]);
   await audit(c,actor.id,'grant.approval.recorded',reference,{userId,level:input.level,revision,identityRevision:evidence.revision},at);
   return {...view(r),duplicate:false};
  }),
  revoke:(actor,input)=>mutate(actor,async(c,at)=>{
   object(input,['kind','id','expectedRevision','reason']);fail(['identity','approval'].includes(input.kind),'Invalid evidence kind');
   const id=string(input.id,'id'),reason=string(input.reason,'reason',500),expected=version(input.expectedRevision);
   const table=input.kind==='identity'?'grant_person_evidence':'grant_person_approvals',key=input.kind==='identity'?'user_id':'reference';
   const prior=await one(c,`SELECT * FROM ${table} WHERE ${key}=$1 FOR UPDATE`,[id]);fail(prior,'Evidence not found',404,'NOT_FOUND');
   if(!prior.active&&(expected===Number(prior.revision)||expected===Number(prior.revision)-1))return {...view(prior),duplicate:true};
   fail(expected===Number(prior.revision),'Evidence changed',409,'VERSION_CONFLICT');
   const r=await one(c,`UPDATE ${table} SET active=false,revision=revision+1,actor_id=$2,changed_at=$3 WHERE ${key}=$1 RETURNING *`,[id,actor.id,at]);
   await audit(c,actor.id,`grant.${input.kind}.revoked`,id,{revision:Number(r.revision),reason},at);return {...view(r),duplicate:false};
  })
 });
}
