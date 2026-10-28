import {PGlite} from '@electric-sql/pglite';
import {readFileSync} from 'node:fs';
import {digest} from '../../server/domain.mjs';
import {createCollaborationAccess,ASSOCIATION_ACTIONS} from '../../server/collaboration/access.mjs';
export async function fixture(t){
 const pg=new PGlite();await pg.waitReady;const schema='club_migration_collab';
 await pg.exec(`CREATE SCHEMA ${schema}; SET search_path TO ${schema};`+readFileSync(new URL('../../server/migrations/postgres/001-baseline.sql',import.meta.url),'utf8')+readFileSync(new URL('../../server/collaboration/schema.sql',import.meta.url),'utf8'));
 let tail=Promise.resolve();const faults={audit:false};
 const pool={connect:async()=>{const prev=tail;let release;tail=new Promise(r=>release=r);await prev;return {query:(sql,args)=>{if(faults.audit&&sql.startsWith('INSERT INTO audit_log'))throw Error('synthetic audit failure');return pg.query(sql,args);},release};}};
 const clock=()=> '2026-10-21T10:00:00.000Z',access=createCollaborationAccess(pool,{schema,clock});
 await pg.query("INSERT INTO users(id,username,password_hash,role,created_at,referral_code,consent_version) VALUES('admin','admin','synthetic','admin',$1,'ADMIN','fixture')",[clock()]);
 const token='a'.repeat(64);await pg.query('INSERT INTO sessions VALUES($1,$2,$3)',[digest('pg-admin:'+token),'admin','2099-01-01T00:00:00.000Z']);
 const admin=await access.authenticate({headers:{cookie:'club_pg_admin='+token}});
 async function account(org,name){await access.createAssociation(admin,{id:org,name:org});const user=await access.createAccount(admin,{username:name,password:'Synthetic-only-123!',associationId:org,actions:ASSOCIATION_ACTIONS});const login=await access.login({username:name,password:'Synthetic-only-123!'});return {user,req:{headers:{cookie:login.cookie.split(';')[0]}},actor:await access.authenticate({headers:{cookie:login.cookie.split(';')[0]}})};}
 t.after(()=>pg.close());return {pg,pool,schema,clock,access,admin,account,faults};
}
