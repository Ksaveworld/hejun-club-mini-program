import { resolve } from 'node:path';
import { existsSync } from 'node:fs';
import { openDatabase, transaction, audit } from '../server/db.mjs';
import { requireRule } from '../server/domain.mjs';
// Use only after Bai provides the actual default code and its owner. This does not grant rewards.
const code = process.argv[2]?.toUpperCase();
requireRule(code && /^[A-Z0-9]{6}$/.test(code),'请使用已由业务方确认的 6 位默认推荐码');
const path = resolve(process.env.CLUB_DB_PATH || 'work/data/club.sqlite');
requireRule(existsSync(path),'数据库尚未建立');
const db = openDatabase(path);
try {
  const owner = db.prepare("SELECT id FROM users WHERE referral_code=? AND role='member'").get(code);
  requireRule(owner,'推荐码不对应已登记会员账号，未修改任何配置');
  transaction(db,()=>{
    const previous = db.prepare("SELECT value FROM settings WHERE key='default_referral_code'").get()?.value ?? null;
    db.prepare("INSERT INTO settings VALUES ('default_referral_code',?) ON CONFLICT(key) DO UPDATE SET value=excluded.value").run(code);
    audit(db,null,'config.default_referral','default_referral_code',{ previous,code,ownerId:owner.id });
  });
  console.log('默认来源已保存，仅作用于之后没有明确推荐来源的新申请；不会修改历史订单或授予奖励资格。');
} finally { db.close(); }
