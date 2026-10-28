import {postgresTransaction} from './postgres.mjs';
import {createPostgresProfile,PROFILE_SCHEMA_SQL} from './postgres-profile.mjs';

// Additive, owner-only profile migration. No old rows/tables are rewritten.
// The release must explicitly name the validated database schema.
export async function prepareProfileRuntime(pool,config,target){
  if(target===undefined)return undefined;
  if(!/^club_migration_[a-z0-9_]{1,40}$/.test(config?.schema||'')
    ||target!==config.schema||config.mode!=='fresh')throw Error('Invalid profile migration target');
  await postgresTransaction(pool,async c=>{
    await c.query(`SET LOCAL search_path TO "${config.schema}"`);
    await c.query(PROFILE_SCHEMA_SQL);
    await c.query('SELECT user_id,nickname,avatar_bytes,avatar_mime,updated_at FROM user_profiles LIMIT 0');
  });
  return createPostgresProfile(pool,config);
}
