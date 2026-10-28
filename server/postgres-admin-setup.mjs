import {randomUUID,randomBytes} from 'node:crypto';
import {postgresTransaction} from './postgres.mjs';
import {requireRule,digest,nowISO} from './domain.mjs';
// Explicit one-time operator provisioning only. No default password, public
// registration endpoint, role promotion or replacement of an existing operator.
export async function initializeOperationsAdmin(pool,config,input){
  requireRule(config.mode==='fresh'&&config.adminOrigin&&/^club_migration_[a-z0-9_]{1,40}$/.test(config.schema||''),'需要明确新版后台配置');
  requireRule(input?.version===1&&input.appId===config.appId&&input.schema===config.schema,'管理员设置目标不一致');
  requireRule(/^[a-z0-9_]{4,32}$/.test(input.username||'')&&input.username!=='system_content_seed','管理员账号格式不正确');
  requireRule(/^[a-f0-9]{32}:[a-f0-9]{128}$/.test(input.passwordHash||''),'需要有效的管理员密码指纹');
  const fingerprint=digest(JSON.stringify(input));
  return postgresTransaction(pool,async c=>{
    await c.query(`SET LOCAL search_path TO "${config.schema}"`);await c.query('LOCK TABLE users IN SHARE ROW EXCLUSIVE MODE');
    const existing=(await c.query("SELECT value FROM settings WHERE key='operations-admin-bootstrap-v1'")).rows[0];
    if(existing){requireRule(existing.value===fingerprint,'管理员已设置，不能通过初始化替换');return{alreadyInitialized:true};}
    const operators=(await c.query("SELECT id FROM users WHERE role='admin' AND consent_version<>'system-content-only'")).rows;
    requireRule(!operators.length,'已有运营管理员，不能追加初始化权限');
    requireRule(!(await c.query('SELECT 1 FROM users WHERE username=$1',[input.username])).rows.length,'账号已存在，不能提升或替换权限');
    let referral;do{referral=randomBytes(3).toString('hex').toUpperCase();}while((await c.query('SELECT 1 FROM users WHERE referral_code=$1',[referral])).rows.length);
    const id=randomUUID(),now=nowISO();
    await c.query('INSERT INTO users(id,username,password_hash,role,created_at,referral_code,consent_version) VALUES($1,$2,$3,\'admin\',$4,$5,\'operations-provisioned-v1\')',[id,input.username,input.passwordHash,now,referral]);
    await c.query('INSERT INTO audit_log(actor_id,action,target_id,detail,created_at) VALUES($1,$2,$1,$3,$4)',[id,'admin.bootstrap',JSON.stringify({scope:'fresh-operations',origin:config.adminOrigin}),now]);
    await c.query("INSERT INTO settings(key,value) VALUES('operations-admin-bootstrap-v1',$1)",[fingerprint]);
    return{alreadyInitialized:false};
  });
}
