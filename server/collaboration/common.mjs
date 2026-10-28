import {postgresTransaction} from '../postgres.mjs';
export function fail(condition,message,status=400,code='INVALID_REQUEST') { if(!condition) throw Object.assign(new Error(message),{status,code}); }
export const one=async(c,sql,args=[])=>(await c.query(sql,args)).rows[0];
export function runner(pool,schema) {
 fail(/^club_migration_[a-z0-9_]{1,40}$/.test(schema||''),'Explicit isolated schema required');
 return fn=>postgresTransaction(pool,async c=>{await c.query(`SET LOCAL search_path TO "${schema}"`);return fn(c);});
}
export const audit=(c,actor,action,target,detail={},now=new Date().toISOString())=>c.query('INSERT INTO audit_log(actor_id,action,target_id,detail,created_at) VALUES($1,$2,$3,$4,$5)',[actor,action,target,JSON.stringify(detail),now]);
export function string(value,name,max=200) {fail(typeof value==='string'&&value.trim().length>0&&value.length<=max,`Invalid ${name}`);return value.trim();}
