import {randomBytes,timingSafeEqual} from 'node:crypto';
import {transaction,audit} from './db.mjs';
import {digest,requireRule,nowISO} from './domain.mjs';

const prefix='native_account_transfer:';
// One pending proof per account, stored hashed in the existing private settings table.
// Both entry points must use the same authoritative database; never exchange via stale snapshots.
export function issueNativeTransfer(db,user,appId){
  requireRule(/^wx[a-f0-9]{16}$/.test(appId||''),'会员接续暂未开放',503);
  requireRule(user?.role==='member','请先登录原会员账号',401);
  return transaction(db,()=>{
    requireRule(db.prepare("SELECT 1 FROM users WHERE id=? AND role='member'").get(user.id),'账号状态已变化',409);
    const proof=randomBytes(24).toString('base64url'),expiresAt=new Date(Date.now()+10*60*1000).toISOString();
    db.prepare('INSERT INTO settings(key,value) VALUES(?,?) ON CONFLICT(key) DO UPDATE SET value=excluded.value')
      .run(prefix+user.id,JSON.stringify({hash:digest(proof),appId,expiresAt}));
    audit(db,user.id,'account.native_transfer_issued',user.id,{appId,expiresAt});
    return {transferCode:user.id+'.'+proof,expiresAt};
  });
}
export function readNativeTransfer(db,code,appId){
  requireRule(typeof code==='string'&&/^[a-f0-9-]{36}\.[A-Za-z0-9_-]{32}$/.test(code),'接续码无效或已过期，请在原网页重新获取',401);
  const [id,proof]=code.split('.'),key=prefix+id;
  const row=db.prepare('SELECT value FROM settings WHERE key=?').get(key);
  let record;try{record=JSON.parse(row?.value??'null');}catch{}
  requireRule(record&&record.appId===appId&&record.expiresAt>nowISO()&&/^[a-f0-9]{64}$/.test(record.hash),'接续码无效或已过期，请在原网页重新获取',401);
  requireRule(timingSafeEqual(Buffer.from(record.hash,'hex'),Buffer.from(digest(proof),'hex')),'接续码无效或已过期，请在原网页重新获取',401);
  const user=db.prepare("SELECT * FROM users WHERE id=? AND role='member'").get(id);
  requireRule(user,'原账号状态已变化，请联系工作人员',409);
  return {user,key};
}
export function consumeNativeTransfer(db,code,appId){
  // Must run inside the identity-linking transaction, so a later failure restores this proof.
  const proof=readNativeTransfer(db,code,appId);
  db.prepare('DELETE FROM settings WHERE key=?').run(proof.key);
  audit(db,proof.user.id,'account.native_transfer_consumed',proof.user.id,{appId});
  return proof.user;
}
