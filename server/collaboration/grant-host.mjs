import {postgresTransaction} from '../postgres.mjs';
import {createCollaborationAccess} from './access.mjs';
import {createSingleGrants} from './single-grants.mjs';
import {createGrantHttpHandler} from './grant-http.mjs';
import {effectiveEntitlements,normalizeEntitlementTime} from './entitlements.mjs';
import {grantMigrationTables} from './grant-migration.mjs';
import {fail} from './common.mjs';

// The host keeps the existing money-writer lock protocol. Acquire the users table
// BEFORE session/identity/approval rows, including on retry and revocation.
// Do not replace this with a user-row lock unless ALL money writers migrate too.
export async function prepareGrantHost(pool,{schema,adminOrigin,clock,evidenceFactory,...serviceOptions}={}) {
  const installed=await postgresTransaction(pool,async c=>{
    fail(/^club_migration_[a-z0-9_]{1,40}$/.test(schema||''),'Invalid schema');
    await c.query(`SET LOCAL search_path TO "${schema}"`);
    return (await grantMigrationTables(c,schema)).length===2;
  });
  if(!installed)return undefined;
  const access=createCollaborationAccess(pool,{schema,...(clock?{clock}:{})});
  const coordinated={...access,writeRun:fn=>access.run(async c=>{
    await c.query('LOCK TABLE users IN SHARE ROW EXCLUSIVE MODE');
    return fn(c);
  })};
  // Evidence callbacks must share the host's authenticated actor proof registry.
  // This server-only factory does not enable writes, choose a policy or supply secrets.
  fail(evidenceFactory===undefined||typeof evidenceFactory==='function','Invalid evidence factory');
  const evidence=evidenceFactory?await evidenceFactory(coordinated):{};
  fail(evidence&&typeof evidence==='object'&&!Array.isArray(evidence)&&
    Object.keys(evidence).every(key=>['identityVerifier','approvalResolver','phoneResolver'].includes(key)&&typeof evidence[key]==='function'),'Invalid evidence resolvers');
  const grants=createSingleGrants(coordinated,{...serviceOptions,...evidence,...(clock?{clock}:{}),writeCoordinationReady:true});
  const http=adminOrigin?createGrantHttpHandler({access:coordinated,grants,adminOrigin}):undefined;
  return Object.freeze({grants,http,entitlementResolver:effectiveEntitlements,grantPaymentConflict,
    // Installed does not mean writes/evidence are enabled. Shipped startup supplies
    // no trusted evidence or approval resolver and leaves all grant writes closed.
    writesEnabled:serviceOptions.writesEnabled===true});
}

// Called inside the actual paid transaction after its users-table lock. A real
// receipt is retained as needs_reconciliation when a grant won the race; never
// overwrite it, invent an order, or report an actual payment as unpaid.
export async function grantPaymentConflict(c,userId,{startsAt,expiresAt}) {
  const start=Date.parse(normalizeEntitlementTime(startsAt)),end=Date.parse(normalizeEntitlementTime(expiresAt));
  fail(start<=end,'Invalid payment interval',503,'ENTITLEMENT_DATA_INVALID');
  const rows=(await c.query("SELECT starts_at,expires_at FROM collab_grants WHERE user_id=$1 AND status='active'",[userId])).rows;
  let overlap=false;
  for(const row of rows){
    const from=Date.parse(normalizeEntitlementTime(row.starts_at)),to=Date.parse(normalizeEntitlementTime(row.expires_at));
    fail(from<to,'Invalid grant interval',503,'ENTITLEMENT_DATA_INVALID');
    overlap ||= start<to&&from<end;
  }
  return overlap;
}
