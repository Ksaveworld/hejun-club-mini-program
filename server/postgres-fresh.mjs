import {grantMigrationTables} from './collaboration/grant-migration.mjs';
import {grantEvidenceTables} from './collaboration/grant-evidence-store.mjs';
import {batch2MigrationTables} from './batch2-content.mjs';
import {readFileSync} from 'node:fs';
import {createHash} from 'node:crypto';
import {postgresTransaction} from './postgres.mjs';
import {virtualPaymentMigrationTables} from './postgres-virtual-payment.mjs';
import {postVersionMigrationTables} from './postgres-content.mjs';
import {renewalMigrationTables} from './postgres-renewals.mjs';
import {reminderMigrationTables} from './postgres-reminders.mjs';
import {reviewMigrationTables} from './postgres-review-access.mjs';

const baseline=readFileSync(new URL('./migrations/postgres/001-baseline.sql',import.meta.url),'utf8');
const baselineHash=createHash('sha256').update(baseline).digest('hex');
const tables=[...baseline.matchAll(/CREATE TABLE (\w+)\s*\(/g)].map(match=>match[1]).sort();
const marker='_club_pg_initialization';
function checkSchema(schema){
  if(!/^club_migration_[a-z0-9_]{1,40}$/.test(schema||''))throw Error('需要指定新的独立数据区');
}

// Explicit setup only. The running application never executes this SQL, imports
// legacy records or reuses an existing schema. A failed setup rolls back in full.
export function freshDatabaseSql(schema){
  checkSchema(schema);
  return `BEGIN;\nCREATE SCHEMA "${schema}";\nSET LOCAL search_path TO "${schema}";\n${baseline}\n`+
    `INSERT INTO schema_version(version) VALUES(14);\n`+
    `CREATE TABLE ${marker}(version BIGINT PRIMARY KEY, baseline_sha256 TEXT NOT NULL, data_origin TEXT NOT NULL, initialized_at TIMESTAMPTZ NOT NULL, source_tables BIGINT NOT NULL);\n`+
    `INSERT INTO ${marker} VALUES(1,'${baselineHash}','fresh-no-legacy-import',CURRENT_TIMESTAMP,${tables.length});\nCOMMIT;\n`;
}

export async function initializeFreshDatabase(pool,{schema}){
  checkSchema(schema);
  return postgresTransaction(pool,async client=>{
    await client.query(`CREATE SCHEMA "${schema}"`);
    await client.query(`SET LOCAL search_path TO "${schema}"`);
    await client.query(baseline);
    await client.query('INSERT INTO schema_version(version) VALUES(14)');
    await client.query(`CREATE TABLE ${marker}(version BIGINT PRIMARY KEY, baseline_sha256 TEXT NOT NULL, data_origin TEXT NOT NULL, initialized_at TIMESTAMPTZ NOT NULL, source_tables BIGINT NOT NULL)`);
    await client.query(`INSERT INTO ${marker} VALUES(1,$1,'fresh-no-legacy-import',CURRENT_TIMESTAMP,$2)`,[baselineHash,tables.length]);
    return {schema,tables:tables.length,legacyDataImported:false};
  });
}

export async function verifyFreshDatabase(pool,{schema},profileSchemaTarget){
  checkSchema(schema);
  return postgresTransaction(pool,async client=>{
    await client.query('SET TRANSACTION READ ONLY');
    await client.query(`SET LOCAL search_path TO "${schema}"`);
    const rows=(await client.query(`SELECT * FROM ${marker} ORDER BY version`)).rows;
    if(rows.length!==1||Number(rows[0].version)!==1||rows[0].baseline_sha256!==baselineHash||
      rows[0].data_origin!=='fresh-no-legacy-import'||Number(rows[0].source_tables)!==tables.length)
      throw Error('新版数据区初始化记录不一致');
    const actual=(await client.query('SELECT table_name FROM information_schema.tables WHERE table_schema=$1 AND table_type=$2',[schema,'BASE TABLE'])).rows.map(r=>r.table_name).filter(n=>n!==marker).sort();
    const store=(await client.query("SELECT value FROM settings WHERE key='private-report-store-v1'")).rows[0];
    const optional=await virtualPaymentMigrationTables(client,schema);
    optional.push(...await grantMigrationTables(client,schema));
    optional.push(...await grantEvidenceTables(client,schema));
    // An explicitly enabled private profile table must survive subsequent boots.
    // Keep rejecting all unknown tables and unexpected profile definitions.
    if(profileSchemaTarget!==undefined&&profileSchemaTarget!==schema)throw Error('头像资料数据区不匹配');
    if(profileSchemaTarget===schema&&actual.includes('user_profiles')){
      const columns=(await client.query("SELECT column_name,data_type,is_nullable FROM information_schema.columns WHERE table_schema=$1 AND table_name='user_profiles' ORDER BY column_name",[schema])).rows;
      if(columns.map(c=>`${c.column_name}:${c.data_type}:${c.is_nullable}`).join(',')!=='avatar_bytes:bytea:YES,avatar_mime:text:YES,nickname:text:NO,updated_at:text:NO,user_id:text:NO')throw Error('头像资料结构不一致');
      optional.push('user_profiles');
    }
    optional.push(...await batch2MigrationTables(client,schema));
    optional.push(...await postVersionMigrationTables(client,schema));
    optional.push(...await renewalMigrationTables(client,schema),...await reminderMigrationTables(client,schema));
    optional.push(...await reviewMigrationTables(client,schema));
    const reward=(await client.query("SELECT value FROM settings WHERE key='_club_reward_ledger_migration'")).rows[0];
    if(reward){
      if(reward.value!=='003-reward-ledger-v1')throw Error('奖励迁移标记不一致');
      optional.push('_club_reward_ledger_state','_club_reward_ledger_commands','_club_reward_order_snapshots');
    }
    const expected=[...tables,...optional,...(store?.value==='pg-chunks-1048576'?['_club_report_chunks','_club_report_files']:[])].sort();
    if(store&&store.value!=='pg-chunks-1048576')throw Error('私有报告存储版本不一致');
    if(JSON.stringify(actual)!==JSON.stringify(expected))throw Error('新版数据区结构不一致');
    if(store){
      const columns=(await client.query("SELECT table_name,column_name,data_type FROM information_schema.columns WHERE table_schema=$1 AND table_name IN ('_club_report_files','_club_report_chunks') ORDER BY table_name,column_name",[schema])).rows;
      const definition=columns.map(c=>c.table_name+':'+c.column_name+':'+c.data_type).join(',');
      if(definition!=='_club_report_chunks:data:bytea,_club_report_chunks:part:bigint,_club_report_chunks:sha256:text,_club_report_files:byte_size:bigint,_club_report_files:parts:bigint,_club_report_files:sha256:text')throw Error('私有报告存储结构不一致');
    }
    return {storage:'postgres',tables:tables.length,initialized:true,dataOrigin:'fresh-no-legacy-import',legacyDataImported:false,releaseReady:false};
  });
}
