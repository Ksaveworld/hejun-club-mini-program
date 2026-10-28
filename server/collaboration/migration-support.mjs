import {readFileSync} from 'node:fs';
import {createHash} from 'node:crypto';
import {postgresTransaction} from '../postgres.mjs';
import {requireRule} from '../domain.mjs';

// Explicit migration only; never called by the request handler or application startup.
export function optionalSchemaMigration({file,key,version}) {
 const sql=readFileSync(file,'utf8'),hash=createHash('sha256').update(sql).digest('hex');
 const tables=[...sql.matchAll(/CREATE TABLE (\w+)\s*\(/g)].map(m=>m[1]).sort();
 const value=version+':'+hash;
 const check=schema=>requireRule(/^club_migration_[a-z0-9_]{1,40}$/.test(schema||''),'需要显式指定独立数据区');
 async function verify(client,schema){
  check(schema);
  const saved=(await client.query('SELECT value FROM settings WHERE key=$1',[key])).rows[0];
  const names=(await client.query('SELECT tablename FROM pg_tables WHERE schemaname=$1',[schema])).rows.map(r=>r.tablename);
  const found=tables.filter(name=>names.includes(name));
  requireRule(saved?saved.value===value&&found.length===tables.length:found.length===0,'增量数据表与迁移标记不一致',503);
  return saved?[...tables]:[];
 }
 async function initialize(pool,{schema}){
  check(schema);
  return postgresTransaction(pool,async c=>{
   await c.query(`SET LOCAL search_path TO "${schema}"`);
   await c.query('LOCK TABLE settings IN SHARE ROW EXCLUSIVE MODE');
   if((await verify(c,schema)).length)return {initialized:false,version};
   await c.query(sql);await c.query('INSERT INTO settings(key,value) VALUES($1,$2)',[key,value]);
   return {initialized:true,version,tables:[...tables]};
  });
 }
 return {verify,initialize};
}
