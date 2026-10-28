import {randomBytes,randomUUID} from 'node:crypto';
import {digest,hashPassword,checkPassword,validateCredentials} from '../domain.mjs';
import {fail,one,runner,audit,string} from './common.mjs';
export const ASSOCIATION_ACTIONS=Object.freeze(['content.read','content.create','content.edit','content.publish','content.unpublish','attachment.read','attachment.write','registration.configure','registration.list','registration.export']);
const cookieName='club_pg_collab';
const cookie=t=>`${cookieName}=${t}; HttpOnly; Secure; SameSite=Strict; Path=/; Max-Age=${t?43200:0}`;
const cookieToken=(req,name)=>new RegExp(`(?:^|;\\s*)${name}=([a-f0-9]{64})(?:;|$)`).exec(req.headers?.cookie||'')?.[1];
export function createCollaborationAccess(pool,{schema,clock=()=>new Date().toISOString()}={}) {
 const run=runner(pool,schema),proofs=new WeakMap();
 const permissions=value=>{fail(Array.isArray(value)&&value.length>0&&value.every(a=>ASSOCIATION_ACTIONS.includes(a)),'Invalid actions');return [...new Set(value)].sort();};
 async function authenticateInTransaction(c,req,{write=false}={}) {
  fail(req?.headers?.authorization===undefined,'Cannot mix Bearer and management cookie',400,'AUTH_AMBIGUOUS');
  const admin= cookieToken(req,'club_pg_admin'),collab=cookieToken(req,cookieName);
  fail(!(admin&&collab),'Cannot mix management identities',400,'AUTH_AMBIGUOUS');
  const token=admin||collab; fail(token,'Management login required',401,'AUTH_REQUIRED');
  const hash=digest((admin?'pg-admin:':'pg-collab:')+token);
  const row=await one(c,'SELECT u.id,u.role FROM sessions s JOIN users u ON u.id=s.user_id WHERE s.token_hash=$1 AND s.expires_at>$2',[hash,clock()]);
  fail(row&&(admin?row.role==='admin':row.role==='member'),'Session expired',401,'AUTH_REQUIRED');
  if(write)fail(req.headers['x-club-actor']===row.id,'Account changed; reload',409,'ACTOR_CHANGED');
  const actor=Object.freeze({id:row.id,role:admin?'admin':'association'});
  proofs.set(actor,{hash,admin:!!admin}); await current(c,actor);return actor;
 }
 async function current(c,actor) {
  const proof=actor&&proofs.get(actor);fail(proof,'Server-authenticated actor required',401,'AUTH_REQUIRED');
  // Hold platform session/role through a grant transaction. Do not add these
  // locks to association paths: their existing account-disable lock order differs.
  const user=await one(c,`SELECT u.id,u.role FROM sessions s JOIN users u ON u.id=s.user_id WHERE s.token_hash=$1 AND s.user_id=$2 AND s.expires_at>$3${proof.admin?' FOR SHARE OF s,u':''}`,[proof.hash,actor.id,clock()]);
  fail(user,'Session expired',401,'AUTH_REQUIRED');
  if(proof.admin){fail(user.role==='admin','Platform admin required',403,'FORBIDDEN');return {id:user.id,platform:true};}
  fail(user.role==='member','Account changed',403,'FORBIDDEN');
  const account=await one(c,'SELECT a.*,o.active AS association_active FROM collab_accounts a JOIN collab_associations o ON o.id=a.association_id WHERE a.user_id=$1 FOR SHARE OF a,o',[user.id]);
  fail(account?.active&&account.association_active,'Account disabled or not authorized',403,'ACCOUNT_DISABLED');
  return {id:user.id,platform:false,associationId:account.association_id,actions:JSON.parse(account.actions_json)};
 }
 async function platform(c,actor){const ctx=await current(c,actor);fail(ctx.platform,'Platform administrator required',403,'FORBIDDEN');return ctx;}
 async function scope(c,actor,action){const ctx=await current(c,actor);fail(ctx.platform||ctx.actions.includes(action),'Action forbidden',403,'FORBIDDEN');return ctx;}
 async function authorizeObject(c,actor,kind,id,action) {
  fail(['articles','activities'].includes(kind),'Unknown content kind');
  const ctx=await scope(c,actor,action);
  const target=await one(c,`SELECT id FROM ${kind} WHERE id=$1`,[id]);fail(target,'Object unavailable',404,'NOT_FOUND');
  const ownership=await one(c,'SELECT * FROM collab_objects WHERE kind=$1 AND object_id=$2',[kind,id]);
  fail(ctx.platform||ownership?.association_id===ctx.associationId,'Object unavailable',404,'NOT_FOUND');
  if(['content.edit','content.publish','content.create'].includes(action))fail(!ownership?.blocked,'Platform takedown must be resolved by platform',409,'PLATFORM_BLOCKED');
  return true;
 }
 return {
  run,current,platform,scope,authorizeObject,authenticateInTransaction,
  authenticate:req=>run(c=>authenticateInTransaction(c,req)),
  authorizeActivity:(c,actor,activity,action)=>authorizeObject(c,actor,'activities',typeof activity==='string'?activity:activity?.id,action),
  async login(input){const username=validateCredentials(input);const saved=await run(c=>one(c,'SELECT * FROM users WHERE username=$1',[username]));
   const valid=await checkPassword(input.password,saved?.password_hash??await hashPassword(randomBytes(32).toString('hex')));fail(saved?.role==='member'&&valid,'Invalid credentials',401,'INVALID_CREDENTIALS');
   return run(async c=>{const user=await one(c,'SELECT * FROM users WHERE id=$1 FOR UPDATE',[saved.id]);fail(user?.password_hash===saved.password_hash,'Account changed',409);
    const a=await one(c,'SELECT a.active,o.active AS org_active FROM collab_accounts a JOIN collab_associations o ON o.id=a.association_id WHERE a.user_id=$1',[user.id]);fail(a?.active&&a.org_active,'Account disabled',403,'ACCOUNT_DISABLED');
    const token=randomBytes(32).toString('hex');await c.query('INSERT INTO sessions VALUES($1,$2,$3)',[digest('pg-collab:'+token),user.id,new Date(Date.parse(clock())+43200000).toISOString()]);
    return {user:{id:user.id,username:user.username,role:'association'},cookie:cookie(token)};});},
  logout:req=>run(async c=>{const t=cookieToken(req,cookieName);if(t)await c.query('DELETE FROM sessions WHERE token_hash=$1',[digest('pg-collab:'+t)]);return cookie('');}),
  createAssociation:(actor,{id,name})=>run(async c=>{await platform(c,actor);id=string(id,'association ID',100);name=string(name,'name',100);await c.query('INSERT INTO collab_associations(id,name) VALUES($1,$2)',[id,name]);await audit(c,actor.id,'collab.association.created',id);return {id,name};}),
  async createAccount(actor,input){const username=validateCredentials(input),actions=permissions(input.actions),passwordHash=await hashPassword(input.password);return run(async c=>{await platform(c,actor);fail((await one(c,'SELECT active FROM collab_associations WHERE id=$1',[input.associationId]))?.active,'Association unavailable');const id=randomUUID();
   await c.query("INSERT INTO users(id,username,password_hash,role,created_at,referral_code,consent_version) VALUES($1,$2,$3,'member',$4,$5,'collab-account-v1')",[id,username,passwordHash,clock(),'C'+randomBytes(8).toString('hex')]);
   await c.query('INSERT INTO collab_accounts(user_id,association_id,actions_json) VALUES($1,$2,$3)',[id,input.associationId,JSON.stringify(actions)]);await audit(c,actor.id,'collab.account.created',id,{associationId:input.associationId,actions});return {id,username,associationId:input.associationId,actions,active:true,revision:1};});},
  setAccountActive:(actor,id,active,revision)=>run(async c=>{await platform(c,actor);fail(typeof active==='boolean'&&Number.isSafeInteger(revision),'Invalid state/version');const row=await one(c,'SELECT * FROM collab_accounts WHERE user_id=$1 FOR UPDATE',[id]);fail(row,'Account missing',404);fail(Number(row.revision)===revision,'Account changed',409,'VERSION_CONFLICT');await c.query('UPDATE collab_accounts SET active=$1,revision=revision+1 WHERE user_id=$2',[active,id]);if(!active)await c.query('DELETE FROM sessions WHERE user_id=$1',[id]);await audit(c,actor.id,'collab.account.state',id,{active});return {id,active,revision:revision+1};}),
  listAccounts:actor=>run(async c=>{await platform(c,actor);return (await c.query('SELECT a.user_id AS id,u.username,a.association_id,a.active,a.actions_json,a.revision FROM collab_accounts a JOIN users u ON u.id=a.user_id ORDER BY u.username')).rows.map(r=>({...r,revision:Number(r.revision),actions:JSON.parse(r.actions_json),actions_json:undefined}));}),
  listObjects:(actor,kind,action='content.read')=>run(async c=>{fail(['articles','activities'].includes(kind),'Unknown kind');const ctx=await scope(c,actor,action);return (await c.query(`SELECT t.* FROM ${kind} t LEFT JOIN collab_objects o ON o.kind=$1 AND o.object_id=t.id WHERE ($2::boolean OR o.association_id=$3) AND NOT EXISTS(SELECT 1 FROM settings s WHERE s.key='_club_deleted:'||$1||':'||t.id) ORDER BY t.id`,[kind,ctx.platform,ctx.associationId??null])).rows;})
 };
}
