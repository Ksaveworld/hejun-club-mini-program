import {postgresTransaction} from './postgres.mjs';
import {digest,requireRule} from './domain.mjs';
const actor='fe228ed9-3364-497a-b376-b0ca4d717805';
const descriptors={articles:['id','title','summary','body','category','access_json','status','revision','created_by','updated_by','created_at','updated_at','published_at','idempotency_key','creation_hash'],
  activities:['id','content_json','status','revision','created_by','created_at','updated_at','published_at','idempotency_key','creation_hash'],
  article_documents:['article_id','sha256','filename','byte_size','pages','imported_at'],report_previews:['article_id','sha256','byte_size','pages']};
export async function seedPublishedContent(pool,{schema},content){
  requireRule(/^club_migration_[a-z0-9_]{1,40}$/.test(schema||''),'内容目标区不正确');
  requireRule(content.version===1&&content.origin==='u51-published-content-only'&&Object.keys(content.tables||{}).sort().join(',')===Object.keys(descriptors).sort().join(','),'只允许已有发布内容');
  const hash=digest(JSON.stringify(content));
  return postgresTransaction(pool,async c=>{
    await c.query(`SET LOCAL search_path TO "${schema}"`);
    const known=(await c.query("SELECT value FROM settings WHERE key='published-content-seed-v1'")).rows[0];
    if(known){requireRule(known.value===hash,'已接入内容与来源指纹不同，需人工核对');return {alreadySeeded:true};}
    for(const table of Object.keys(descriptors))requireRule(Number((await c.query(`SELECT count(*) AS n FROM ${table}`)).rows[0].n)===0,'不能覆盖已有内容');
    // Attribution only: no copied user, known password, session or WeChat identity.
    // A syntactically valid all-zero scrypt target has no usable login credential.
    await c.query("INSERT INTO users(id,username,password_hash,role,created_at,referral_code,consent_version) VALUES($1,'system_content_seed',$2,'admin',$3,'SEED00','system-content-only')",[actor,'0'.repeat(32)+':'+ '0'.repeat(128),new Date().toISOString()]);
    for(const [table,columns]of Object.entries(descriptors))for(const original of content.tables[table]){
      if(['articles','activities'].includes(table))requireRule(original.status==='published','未发布内容不能自动接入');
      requireRule(Object.keys(original).sort().join(',')===columns.slice().sort().join(','),'发布内容字段不正确');
      const values=columns.map(name=>['created_by','updated_by'].includes(name)?actor:original[name]);
      await c.query(`INSERT INTO ${table}(${columns.join(',')}) VALUES(${columns.map((_,i)=>'$'+(i+1)).join(',')})`,values);
    }
    await c.query("INSERT INTO settings VALUES('published-content-seed-v1',$1)",[hash]);
    return {articles:content.tables.articles.length,activities:content.tables.activities.length,legacyCustomersImported:false};
  });
}
