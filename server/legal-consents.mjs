import { randomUUID } from 'node:crypto';
import { transaction } from './db.mjs';

// Called only with a server-owned, confirmed release, never client-supplied policy text.
export function installLegalConsents(db) {
  db.exec(`CREATE TABLE IF NOT EXISTS legal_consents (
    id TEXT PRIMARY KEY,user_id TEXT NOT NULL REFERENCES users(id),
    scope TEXT NOT NULL CHECK(scope IN ('registration','order','payment')),
    target_id TEXT NOT NULL,release_id TEXT NOT NULL,documents_json TEXT NOT NULL,
    accepted_at TEXT NOT NULL,hong_kong_accepted INTEGER NOT NULL DEFAULT 0,details_confirmed INTEGER NOT NULL DEFAULT 0,UNIQUE(user_id,scope,target_id,release_id)
  ); INSERT OR IGNORE INTO schema_version VALUES(12);`);
  const columns=new Set(db.prepare("PRAGMA table_info(legal_consents)").all().map(c=>c.name));
  for(const name of ["hong_kong_accepted","details_confirmed"])if(!columns.has(name))db.exec(`ALTER TABLE legal_consents ADD COLUMN ${name} INTEGER NOT NULL DEFAULT 0`);
}

export function recordLegalConsent(db, {userId,scope,targetId,body,release,withinTransaction=false}) {
  if (!release || release.status !== 'approved') throw new Error('协议版本尚未确认适用于当前服务');
  if (!['registration','order','payment'].includes(scope)) throw new Error('同意场景不正确');
  if (body?.accepted !== true || body.releaseId !== release.id || (release.requireHongKongConsent && body.hongKongAccepted !== true)) throw new Error('请阅读并同意当前版本协议');
  if (!Array.isArray(release.documents) || release.documents.length < 2 ||
      release.documents.some(d=>!d.id||!d.version||!/^[a-f0-9]{64}$/.test(d.sha256))) throw new Error('服务端协议版本配置不完整');
  const snapshot=JSON.stringify([...release.documents].sort((a,b)=>a.id.localeCompare(b.id)).map(({id,version,sha256})=>({id,version,sha256})));
  const write=()=>{
    const user=db.prepare('SELECT id FROM users WHERE id=?').get(userId);
    if (!user) throw new Error('账号不存在');
    if (scope==='registration' && targetId!==userId) throw new Error('同意记录不属于当前账号');
    if (scope!=='registration' && !db.prepare('SELECT id FROM orders WHERE id=? AND user_id=?').get(targetId,userId)) throw new Error('订单不属于当前账号');
    const previous=db.prepare('SELECT * FROM legal_consents WHERE user_id=? AND scope=? AND target_id=? AND release_id=?').get(userId,scope,targetId,release.id);
    if(previous){if(previous.documents_json!==snapshot)throw new Error('同一协议版本的文件内容发生变化，请发布新版本');return previous;}
    const id=randomUUID(),at=new Date().toISOString();
    db.prepare('INSERT INTO legal_consents VALUES(?,?,?,?,?,?,?,?,?)').run(id,userId,scope,targetId,release.id,snapshot,at,body.hongKongAccepted===true?1:0,body.detailsConfirmed===true?1:0);
    return db.prepare('SELECT * FROM legal_consents WHERE id=?').get(id);
  };
  return withinTransaction ? write() : transaction(db,write);
}
