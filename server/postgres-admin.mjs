import {randomBytes} from 'node:crypto';
import {postgresTransaction} from './postgres.mjs';
import {requireRule,validateCredentials,checkPassword,hashPassword,digest,nowISO} from './domain.mjs';

// Administrator sessions use a distinct cookie and hash namespace. Imported web
// and native sessions cannot be reused as migration-console sessions.
export function createPostgresAdmin(pool,{schema,adminOrigin}={}){
  requireRule(/^club_migration_[a-z0-9_]{1,40}$/.test(schema||''),'需要指定迁移隔离区');
  const origin=new URL(adminOrigin);requireRule(origin.protocol==='https:'&&origin.origin===adminOrigin,'后台必须使用明确的HTTPS来源');
  const run=fn=>postgresTransaction(pool,async c=>{await c.query(`SET LOCAL search_path TO "${schema}"`);return fn(c);});
  const one=async(c,s,a=[])=>(await c.query(s,a)).rows[0];
  const cookie=token=>`club_pg_admin=${token}; HttpOnly; Secure; SameSite=Strict; Path=/; Max-Age=${token?43200:0}`;
  const token=req=>/(?:^|;\s*)club_pg_admin=([a-f0-9]{64})(?:;|$)/.exec(req.headers.cookie||'')?.[1];
  const key=t=>digest('pg-admin:'+t);
  const publicUser=u=>({id:u.id,username:u.username,role:'admin',referralCode:u.referral_code,sourceCode:null,referralSource:null,referralLockedAt:null,phoneVerified:false});
  return {
    origin:adminOrigin,
    async directorySessionInTransaction(c,req,timestamp){
      const t=token(req);requireRule(t,'请重新登录管理员账号',401);
      const row=await one(c,"SELECT u.id FROM sessions s JOIN users u ON u.id=s.user_id WHERE s.token_hash=$1 AND s.expires_at::timestamptz>$2::timestamptz AND u.role='admin'",[key(t),timestamp]);
      requireRule(row,'登录已失效，请重新登录管理员账号',401);
      requireRule(req.headers['x-club-actor']===row.id,'登录账号已变化，请刷新后重新操作',409);
      return row;
    },
    async login(input){
      const username=validateCredentials(input),row=await run(c=>one(c,'SELECT * FROM users WHERE username=$1',[username]));
      const valid=await checkPassword(input.password,row?.password_hash??await hashPassword(randomBytes(32).toString('hex')));
      requireRule(row?.role==='admin'&&valid,'账号或密码不正确',401);
      return run(async c=>{
        const current=await one(c,"SELECT * FROM users WHERE id=$1 AND role='admin' FOR UPDATE",[row.id]);requireRule(current&&current.password_hash===row.password_hash,'账号状态已变化，请重新登录',401);
        const value=randomBytes(32).toString('hex');await c.query('INSERT INTO sessions(token_hash,user_id,expires_at) VALUES($1,$2,$3)',[key(value),row.id,new Date(Date.now()+43200000).toISOString()]);
        return {user:publicUser(current),cookie:cookie(value)};
      });
    },
    authenticate:req=>run(async c=>{const t=token(req);if(!t)return null;const u=await one(c,"SELECT u.* FROM sessions s JOIN users u ON u.id=s.user_id WHERE s.token_hash=$1 AND s.expires_at>$2 AND u.role='admin'",[key(t),nowISO()]);return u?publicUser(u):null;}),
    logout:req=>run(async c=>{const t=token(req);if(t)await c.query('DELETE FROM sessions WHERE token_hash=$1',[key(t)]);return cookie('');})
  };
}
