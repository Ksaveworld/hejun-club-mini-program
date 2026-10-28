import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {PGlite} from '@electric-sql/pglite';
import {initializeCollaborationDatabase} from '../../server/collaboration/migration.mjs';
import {initializeGrantDatabase,grantMigrationTables,grantMigration,grantLevelsMigration} from '../../server/collaboration/grant-migration.mjs';

async function fixture(t){
  const pg=new PGlite();await pg.waitReady;t.after(()=>pg.close());
  const schema='club_migration_grant_test';
  await pg.exec(`CREATE SCHEMA ${schema}; SET search_path TO ${schema};`+readFileSync(new URL('../../server/migrations/postgres/001-baseline.sql',import.meta.url),'utf8'));
  await pg.exec(`INSERT INTO users(id,username,password_hash,role,created_at,referral_code,consent_version)
    VALUES('synthetic-admin','synthetic-admin','synthetic','admin','2026-01-01T00:00:00.000Z','SYNTHADMIN','test'),
    ('synthetic-member','synthetic-member','synthetic','member','2026-01-01T00:00:00.000Z','SYNTHMEMBER','test');
    INSERT INTO orders(id,user_id,plan_id,amount_cents,status,profile_json,created_at,idempotency_key,request_hash)
    VALUES('synthetic-order','synthetic-member','basic',36500,'paid','{}','2026-01-01T00:00:00.000Z','synthetic-key','synthetic-hash');
    INSERT INTO memberships VALUES('synthetic-member','synthetic-order','basic','2026-01-01T00:00:00.000Z','2027-01-01T00:00:00.000Z');
    INSERT INTO payment_receipts VALUES('synthetic-transaction','synthetic-order','synthetic-hash','2026-01-01T00:00:00.000Z','success');
    INSERT INTO settings VALUES('synthetic-price','36500');`);
  const faults={marker:false,levelsMarker:false};
  const pool={connect:async()=>({query:(sql,args)=>{
    if(faults.marker&&sql.startsWith('INSERT INTO settings')&&args?.[0]===grantMigration.key)throw Error('synthetic marker write failure');
    if(faults.levelsMarker&&sql.startsWith('INSERT INTO settings')&&args?.[0]===grantLevelsMigration.key)throw Error('synthetic levels marker write failure');
    // Match pg's simple-query path for unparameterized migration SQL.
    return args===undefined?pg.exec(sql).then(results=>results.at(-1)??{rows:[]}):pg.query(sql,args);
  },release(){}})};
  const baseline=(await pg.query('SELECT tablename FROM pg_tables WHERE schemaname=$1 ORDER BY tablename',[schema])).rows.map(x=>x.tablename);
  async function snapshot(){
    const result={};for(const table of baseline){
      const where=table==='settings'?" WHERE key NOT IN ('_club_single_grant_migration','_club_single_grant_levels_migration','_club_collaboration_migration')":'';
      result[table]=(await pg.query(`SELECT row_to_json(t)::text AS row FROM ${table} t${where} ORDER BY row_to_json(t)::text`)).rows;
    }return result;
  }
  return {pg,pool,schema,faults,snapshot};
}

test('standalone grant migration creates only two tables, verifies and repeats without legacy data changes',async t=>{
  const f=await fixture(t),before=await f.snapshot();
  assert.deepEqual(await grantMigrationTables(f.pg,f.schema),[]);
  const first=await initializeGrantDatabase(f.pool,{schema:f.schema});
  assert.equal(first.initialized,true);assert.equal(first.adopted,false);assert.match(first.sha256,/^[a-f0-9]{64}$/);
  assert.equal(first.version,'single-grant-levels-v2');
  assert.deepEqual(await grantMigrationTables(f.pg,f.schema),['collab_grant_batches','collab_grants']);
  const repeat=await initializeGrantDatabase(f.pool,{schema:f.schema});assert.equal(repeat.initialized,false);
  const collab=(await f.pg.query("SELECT tablename FROM pg_tables WHERE schemaname=$1 AND tablename LIKE 'collab_%' ORDER BY tablename",[f.schema])).rows;
  assert.deepEqual(collab.map(x=>x.tablename),['collab_grant_batches','collab_grants']);
  assert.deepEqual(await f.snapshot(),before);
});

test('complete legacy installation is adopted without changing old marker, grants or payment rows',async t=>{
  const f=await fixture(t);await initializeCollaborationDatabase(f.pool,{schema:f.schema});
  await f.pg.query(`INSERT INTO collab_grants VALUES('synthetic-grant','synthetic-member','star','2025-01-01T00:00:00.000Z','2026-01-01T00:00:00.000Z','synthetic reason','synthetic approval','synthetic-admin','active','legacy-grant-key','legacy-hash','2025-01-01T00:00:00.000Z',NULL,NULL,NULL)`);
  const before=await f.snapshot(),oldMarker=(await f.pg.query("SELECT value FROM settings WHERE key='_club_collaboration_migration'")).rows;
  const oldGrant=(await f.pg.query('SELECT * FROM collab_grants')).rows;
  const result=await initializeGrantDatabase(f.pool,{schema:f.schema});assert.equal(result.adopted,true);
  assert.deepEqual((await f.pg.query("SELECT value FROM settings WHERE key='_club_collaboration_migration'")).rows,oldMarker);
  assert.deepEqual((await f.pg.query('SELECT * FROM collab_grants')).rows,oldGrant);
  assert.deepEqual(await f.snapshot(),before);
  assert.equal((await initializeCollaborationDatabase(f.pool,{schema:f.schema})).initialized,false);
});

test('partial and unmarked pre-existing tables fail closed without repairing or dropping them',async t=>{
  const f=await fixture(t);
  await f.pg.query('CREATE TABLE collab_grant_batches(idempotency_key TEXT PRIMARY KEY,request_hash TEXT NOT NULL,created_at TEXT NOT NULL)');
  await assert.rejects(initializeGrantDatabase(f.pool,{schema:f.schema}),{code:'GRANT_MIGRATION_INCONSISTENT'});
  assert.equal((await f.pg.query('SELECT count(*) AS n FROM collab_grant_batches')).rows[0].n,0);
  assert.equal((await f.pg.query('SELECT value FROM settings WHERE key=$1',[grantMigration.key])).rows.length,0);
});

test('matching table names with missing uniqueness or mismatched hash are rejected',async t=>{
  const f=await fixture(t);await initializeGrantDatabase(f.pool,{schema:f.schema});
  await f.pg.query('ALTER TABLE collab_grants DROP CONSTRAINT collab_grants_idempotency_key_key');
  await assert.rejects(grantMigrationTables(f.pg,f.schema),{code:'GRANT_MIGRATION_INCONSISTENT'});
  await assert.rejects(initializeGrantDatabase(f.pool,{schema:f.schema}),{code:'GRANT_MIGRATION_INCONSISTENT'});
  await f.pg.query('ALTER TABLE collab_grants ADD UNIQUE(idempotency_key)');
  await f.pg.query('UPDATE settings SET value=$1 WHERE key=$2',['single-grant-v1:tampered',grantMigration.key]);
  await assert.rejects(initializeGrantDatabase(f.pool,{schema:f.schema}),{code:'GRANT_MIGRATION_INCONSISTENT'});
});

test('failure writing the marker rolls back all new tables and a subsequent explicit retry succeeds',async t=>{
  const f=await fixture(t),before=await f.snapshot();f.faults.marker=true;
  await assert.rejects(initializeGrantDatabase(f.pool,{schema:f.schema}),/synthetic marker write failure/);
  assert.deepEqual(await grantMigrationTables(f.pg,f.schema),[]);
  assert.deepEqual(await f.snapshot(),before);f.faults.marker=false;
  assert.equal((await initializeGrantDatabase(f.pool,{schema:f.schema})).initialized,true);
});

test('unmarked full tables and legacy marker mismatch require review; no implicit adoption',async t=>{
  const f=await fixture(t);await f.pg.exec(readFileSync(new URL('../../server/collaboration/grant-schema.sql',import.meta.url),'utf8'));
  await assert.rejects(initializeGrantDatabase(f.pool,{schema:f.schema}),{code:'GRANT_MIGRATION_INCONSISTENT'});
  await f.pg.query("INSERT INTO settings VALUES('_club_collaboration_migration','collaboration-v1:unverified')");
  await assert.rejects(initializeGrantDatabase(f.pool,{schema:f.schema}),{code:'GRANT_MIGRATION_INCONSISTENT'});
  assert.equal((await f.pg.query('SELECT value FROM settings WHERE key=$1',[grantMigration.key])).rows.length,0);
});

test('explicit isolated schema is mandatory before opening any connection',async()=>{
  let connected=false;const pool={connect:async()=>{connected=true;throw Error('must not connect');}};
  for(const schema of [undefined,'public','customer','club_migration_x";DROP SCHEMA public'])
    await assert.rejects(initializeGrantDatabase(pool,{schema}),{code:'INVALID_SCHEMA'});
  assert.equal(connected,false);
});

async function installV1(f){
  await f.pg.exec(readFileSync(new URL('../../server/collaboration/grant-schema.sql',import.meta.url),'utf8'));
  await f.pg.query('INSERT INTO settings VALUES($1,$2)',[grantMigration.key,`${grantMigration.version}:${grantMigration.sha256}`]);
}
async function insertGrant(f,id,level){
  return f.pg.query(`INSERT INTO collab_grants VALUES($1,'synthetic-member',$2,'2025-01-01T00:00:00.000Z','2026-01-01T00:00:00.000Z','synthetic reason','synthetic approval','synthetic-admin','active',$1,'synthetic-hash','2025-01-01T00:00:00.000Z',NULL,NULL,NULL)`,[id,level]);
}

test('v1 upgrades to basic/star without changing v1 marker or old rows; unsupported level remains rejected',async t=>{
  const f=await fixture(t);await installV1(f);await insertGrant(f,'synthetic-star-v1','star');
  const before=(await f.pg.query('SELECT * FROM collab_grants')).rows;
  const v1=(await f.pg.query('SELECT value FROM settings WHERE key=$1',[grantMigration.key])).rows;
  assert.deepEqual(await grantMigrationTables(f.pg,f.schema),[]);
  await assert.rejects(insertGrant(f,'basic-before-upgrade','basic'),{code:'23514'});
  const result=await initializeGrantDatabase(f.pool,{schema:f.schema});assert.equal(result.upgradedFrom,'v1');
  assert.deepEqual((await f.pg.query('SELECT value FROM settings WHERE key=$1',[grantMigration.key])).rows,v1);
  assert.deepEqual((await f.pg.query('SELECT * FROM collab_grants')).rows,before);
  await insertGrant(f,'synthetic-basic-v2','basic');await insertGrant(f,'synthetic-star-v2','star');
  await assert.rejects(insertGrant(f,'synthetic-institution','institution'),{code:'23514'});
  const after=(await f.pg.query('SELECT * FROM collab_grants ORDER BY id')).rows;
  assert.equal((await initializeGrantDatabase(f.pool,{schema:f.schema})).initialized,false);
  assert.deepEqual((await f.pg.query('SELECT * FROM collab_grants ORDER BY id')).rows,after);
});

test('v2 marker failure rolls back CHECK alteration and preserves v1 marker and rows',async t=>{
  const f=await fixture(t);await installV1(f);await insertGrant(f,'synthetic-star-v1','star');
  const before=(await f.pg.query('SELECT * FROM collab_grants')).rows;
  f.faults.levelsMarker=true;
  await assert.rejects(initializeGrantDatabase(f.pool,{schema:f.schema}),/synthetic levels marker write failure/);
  assert.deepEqual((await f.pg.query('SELECT * FROM collab_grants')).rows,before);
  assert.equal((await f.pg.query('SELECT value FROM settings WHERE key=$1',[grantLevelsMigration.key])).rows.length,0);
  assert.deepEqual(await grantMigrationTables(f.pg,f.schema),[]);
  await assert.rejects(insertGrant(f,'basic-after-failed-upgrade','basic'),{code:'23514'});
  f.faults.levelsMarker=false;assert.equal((await initializeGrantDatabase(f.pool,{schema:f.schema})).initialized,true);
});

test('unmarked level alteration and v2 hash drift fail closed rather than adopting arbitrary constraints',async t=>{
  const f=await fixture(t);await installV1(f);
  await f.pg.exec(readFileSync(new URL('../../server/collaboration/grant-levels-v2.sql',import.meta.url),'utf8'));
  await assert.rejects(initializeGrantDatabase(f.pool,{schema:f.schema}),{code:'GRANT_MIGRATION_INCONSISTENT'});
  await f.pg.query('INSERT INTO settings VALUES($1,$2)',[grantLevelsMigration.key,'single-grant-levels-v2:wrong']);
  await assert.rejects(grantMigrationTables(f.pg,f.schema),{code:'GRANT_MIGRATION_INCONSISTENT'});
});
