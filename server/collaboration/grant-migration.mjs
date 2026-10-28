import {readFileSync} from 'node:fs';
import {createHash} from 'node:crypto';
import {postgresTransaction} from '../postgres.mjs';
import {fail} from './common.mjs';

// New proposal hashes canonical LF so Windows checkout policy cannot alter its identity.
const sql=readFileSync(new URL('./grant-schema.sql',import.meta.url),'utf8').replace(/\r\n/g,'\n');
const levelsSql=readFileSync(new URL('./grant-levels-v2.sql',import.meta.url),'utf8').replace(/\r\n/g,'\n');
const legacySql=readFileSync(new URL('./schema.sql',import.meta.url),'utf8');
const hash=value=>createHash('sha256').update(value).digest('hex');
export const grantMigration=Object.freeze({
  key:'_club_single_grant_migration',version:'single-grant-v1',sha256:hash(sql),
  tables:Object.freeze(['collab_grant_batches','collab_grants'])
});
export const grantLevelsMigration=Object.freeze({
  key:'_club_single_grant_levels_migration',version:'single-grant-levels-v2',sha256:hash(levelsSql),
  tables:grantMigration.tables
});
const marker=`${grantMigration.version}:${grantMigration.sha256}`;
const levelsMarker=`${grantLevelsMigration.version}:${grantLevelsMigration.sha256}`;
const legacyMarker=`collaboration-v1:${hash(legacySql)}`;
const legacyTables=[...legacySql.matchAll(/CREATE TABLE (\w+)\s*\(/g)].map(m=>m[1]);
const columnNames={
  collab_grants:['id','user_id','level','starts_at','expires_at','reason','approval_reference','actor_id','status','idempotency_key','request_hash','created_at','revoked_at','revoked_by','revoke_reason'],
  collab_grant_batches:['idempotency_key','request_hash','created_at']
};
const nullable=new Set(['revoked_at','revoked_by','revoke_reason']);
const invalid=(condition,detail)=>fail(condition,`Grant migration requires review: ${detail}`,503,'GRANT_MIGRATION_INCONSISTENT');
function checkSchema(schema){fail(/^club_migration_[a-z0-9_]{1,40}$/.test(schema||''),'Explicit isolated schema required',400,'INVALID_SCHEMA');}

// Inspect the physical columns, constraints and supporting index, not merely names.
// Strict adoption is intentional: drift requires a separately reviewed migration.
async function validateTables(c,schema,{levels=false}={}){
  for(const table of grantMigration.tables){
    const columns=(await c.query(`SELECT a.attname AS name,format_type(a.atttypid,a.atttypmod) AS type,
      a.attnotnull AS required,a.atthasdef AS has_default
      FROM pg_attribute a JOIN pg_class t ON t.oid=a.attrelid JOIN pg_namespace n ON n.oid=t.relnamespace
      WHERE n.nspname=$1 AND t.relname=$2 AND t.relkind='r' AND a.attnum>0 AND NOT a.attisdropped ORDER BY a.attnum`,[schema,table])).rows;
    invalid(columns.length===columnNames[table].length && columns.every((col,i)=>
      col.name===columnNames[table][i] && col.type==='text' && col.required===!nullable.has(col.name) && !col.has_default),`${table} column definition differs`);
    const constraints=(await c.query(`SELECT con.conname AS name,con.contype AS type,con.convalidated AS valid,con.condeferrable AS deferrable,
      pg_get_constraintdef(con.oid) AS definition,
      ARRAY(SELECT a.attname::text FROM unnest(con.conkey) WITH ORDINALITY AS k(num,ord)
        JOIN pg_attribute a ON a.attrelid=con.conrelid AND a.attnum=k.num ORDER BY k.ord) AS columns,
      rn.nspname AS reference_schema,rt.relname AS reference_table,
      ARRAY(SELECT a.attname::text FROM unnest(con.confkey) WITH ORDINALITY AS k(num,ord)
        JOIN pg_attribute a ON a.attrelid=con.confrelid AND a.attnum=k.num ORDER BY k.ord) AS reference_columns,
      con.confupdtype AS on_update,con.confdeltype AS on_delete
      FROM pg_constraint con JOIN pg_class t ON t.oid=con.conrelid JOIN pg_namespace n ON n.oid=t.relnamespace
      LEFT JOIN pg_class rt ON rt.oid=con.confrelid LEFT JOIN pg_namespace rn ON rn.oid=rt.relnamespace
      WHERE n.nspname=$1 AND t.relname=$2 AND con.contype IN ('p','u','f','c')`,[schema,table])).rows;
    const expected=table==='collab_grants'?7:1;
    invalid(constraints.length===expected && constraints.every(x=>x.valid&&!x.deferrable),`${table} constraints differ`);
    const keys=(type,names)=>constraints.some(x=>x.type===type&&JSON.stringify(x.columns)===JSON.stringify(names));
    invalid(keys('p',[table==='collab_grants'?'id':'idempotency_key']),`${table} primary key missing`);
    if(table==='collab_grants'){
      invalid(keys('u',['idempotency_key']),'grant idempotency uniqueness missing');
      for(const name of ['user_id','actor_id','revoked_by'])invalid(constraints.some(x=>x.type==='f'&&
        JSON.stringify(x.columns)===JSON.stringify([name])&&x.reference_schema===schema&&x.reference_table==='users'&&
        JSON.stringify(x.reference_columns)==='["id"]'&&x.on_update==='a'&&x.on_delete==='a'),`grant ${name} reference differs`);
      const checks=constraints.filter(x=>x.type==='c').map(x=>x.definition.replace(/::text|\s|[()]/g,'')).sort();
      const levelCheck=levels?"CHECKlevel=ANYARRAY['basic','star']":"CHECKlevel='star'";
      invalid(JSON.stringify(checks)===JSON.stringify([levelCheck,"CHECKstatus=ANYARRAY['active','revoked']"].sort()),'grant level/status constraints differ');
      invalid(constraints.some(x=>x.type==='c'&&x.name==='collab_grants_level_check'&&x.definition.replace(/::text|\s|[()]/g,'')===levelCheck),'grant level constraint identity differs');
    }
  }
  const indexes=(await c.query(`SELECT i.indisvalid AS valid,i.indisready AS ready,i.indisunique AS unique_index,
    pg_get_expr(i.indpred,i.indrelid) AS predicate,
    ARRAY(SELECT a.attname::text FROM unnest(i.indkey) WITH ORDINALITY AS k(num,ord)
      JOIN pg_attribute a ON a.attrelid=i.indrelid AND a.attnum=k.num ORDER BY k.ord) AS columns
    FROM pg_index i JOIN pg_class t ON t.oid=i.indrelid JOIN pg_namespace n ON n.oid=t.relnamespace
    WHERE n.nspname=$1 AND t.relname='collab_grants'`,[schema])).rows;
  invalid(indexes.some(x=>x.valid&&x.ready&&!x.unique_index&&x.predicate===null&&JSON.stringify(x.columns)==='["user_id"]'),'grant user index missing');
}

async function inspect(c,schema){
  checkSchema(schema);
  const settings=(await c.query(`SELECT key,value FROM "${schema}".settings WHERE key=ANY($1::text[])`,[[grantMigration.key,grantLevelsMigration.key,'_club_collaboration_migration']])).rows;
  const saved=settings.find(x=>x.key===grantMigration.key)?.value;
  const levelsSaved=settings.find(x=>x.key===grantLevelsMigration.key)?.value;
  const legacy=settings.find(x=>x.key==='_club_collaboration_migration')?.value;
  const names=(await c.query('SELECT tablename FROM pg_tables WHERE schemaname=$1',[schema])).rows.map(x=>x.tablename);
  const present=grantMigration.tables.filter(x=>names.includes(x));
  invalid(!saved||saved===marker,'version/hash mismatch');
  invalid(!levelsSaved||levelsSaved===levelsMarker,'levels version/hash mismatch');
  if(!present.length){invalid(!saved&&!levelsSaved&&!legacy,'marker exists but grant tables are absent');return 'empty';}
  invalid(present.length===grantMigration.tables.length,'partial grant tables; automatic repair refused');
  await validateTables(c,schema,{levels:!!levelsSaved});
  if(levelsSaved){invalid(!!saved,'levels marker requires original v1 marker');return 'current';}
  if(saved)return 'v1';
  invalid(legacy===legacyMarker&&legacyTables.every(x=>names.includes(x)),'unmarked tables are not a complete verified collaboration-v1 installation');
  return 'legacy';
}

// Read-only runtime verification; [] means this proposal has not been initialized.
export async function grantMigrationTables(client,schema){
  return (await inspect(client,schema))==='current'?[...grantMigration.tables]:[];
}

// Explicit operator/integrator entrypoint only; importing this module never opens a DB.
export async function initializeGrantDatabase(pool,{schema}={}){
  checkSchema(schema);
  return postgresTransaction(pool,async c=>{
    await c.query(`SET LOCAL search_path TO "${schema}"`);
    await c.query('LOCK TABLE settings IN SHARE ROW EXCLUSIVE MODE');
    const state=await inspect(c,schema);
    if(state==='current')return {initialized:false,adopted:false,...grantLevelsMigration};
    if(state==='empty'){await c.query(sql);await validateTables(c,schema);}
    if(state!=='v1')await c.query('INSERT INTO settings(key,value) VALUES($1,$2)',[grantMigration.key,marker]);
    // DDL and both new markers share one transaction. Only a checked v1 level
    // constraint is replaced; no row, legacy hash or existing v1 marker changes.
    await c.query(levelsSql);
    await validateTables(c,schema,{levels:true});
    await c.query('INSERT INTO settings(key,value) VALUES($1,$2)',[grantLevelsMigration.key,levelsMarker]);
    return {initialized:true,adopted:state==='legacy',upgradedFrom:state,...grantLevelsMigration};
  });
}
