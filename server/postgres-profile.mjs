import {postgresTransaction} from './postgres.mjs';
import {requireRule,nowISO} from './domain.mjs';

export const PROFILE_AVATAR_MAX_BYTES=64*1024;
// Private owner-only profiles: never return these bytes from a public user DTO.
export const PROFILE_SCHEMA_SQL=`CREATE TABLE IF NOT EXISTS user_profiles (
 user_id TEXT COLLATE "C" PRIMARY KEY REFERENCES users(id),
 nickname TEXT NOT NULL CHECK(char_length(nickname) BETWEEN 1 AND 24),
 avatar_bytes BYTEA, avatar_mime TEXT,
 updated_at TEXT COLLATE "C" NOT NULL,
 CHECK ((avatar_bytes IS NULL AND avatar_mime IS NULL) OR
 (avatar_bytes IS NOT NULL AND avatar_mime IN ('image/png','image/jpeg') AND octet_length(avatar_bytes) BETWEEN 1 AND 65536))
);`;

export function validateProfileAvatar(value){
 requireRule(typeof value==='string'&&value.length>0&&value.length<=87384&&/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/.test(value),'头像格式不正确');
 const bytes=Buffer.from(value,'base64');
 requireRule(bytes.length<=PROFILE_AVATAR_MAX_BYTES&&bytes.toString('base64')===value,'头像不能超过64KB');
 let mime,width,height;
 if(bytes.length>=45&&bytes.subarray(0,8).equals(Buffer.from([137,80,78,71,13,10,26,10]))){
   mime='image/png';let pos=8,ended=false,hasData=false,first=true;
   while(pos+12<=bytes.length){
     const length=bytes.readUInt32BE(pos),kind=bytes.toString('ascii',pos+4,pos+8);
     requireRule(length<=bytes.length-pos-12,'头像文件不完整');
     if(first){requireRule(kind==='IHDR'&&length===13,'头像格式不正确');width=bytes.readUInt32BE(pos+8);height=bytes.readUInt32BE(pos+12);first=false;}
     else requireRule(kind!=='IHDR','头像格式不正确');
     requireRule(!['acTL','fcTL','fdAT'].includes(kind),'请使用静态头像');
     if(kind==='IDAT')hasData=true;
     pos+=length+12;
     if(kind==='IEND'){requireRule(length===0&&pos===bytes.length,'头像格式不正确');ended=true;break;}
   }
   requireRule(ended&&hasData,'头像文件不完整');
 }else if(bytes.length>=12&&bytes[0]===255&&bytes[1]===216&&bytes[bytes.length-2]===255&&bytes[bytes.length-1]===217){
   mime='image/jpeg';let pos=2,hasScan=false;
   while(pos+4<=bytes.length){
     requireRule(bytes[pos]===255,'头像格式不正确');
     while(pos<bytes.length&&bytes[pos]===255)pos++;
     const marker=bytes[pos++];requireRule(marker!==0&&marker!==216&&marker!==217,'头像格式不正确');
     requireRule(pos+2<=bytes.length,'头像文件不完整');
     const length=bytes.readUInt16BE(pos);requireRule(length>=2&&pos+length<=bytes.length,'头像文件不完整');
     if([192,193,194].includes(marker)){requireRule(width===undefined&&length>=8,'头像格式不正确');height=bytes.readUInt16BE(pos+3);width=bytes.readUInt16BE(pos+5);}
     if(marker===218){hasScan=true;break;}
     pos+=length;
   }
   requireRule(hasScan,'头像文件不完整');
 }else requireRule(false,'请选择PNG或JPEG静态头像');
 requireRule(Number.isInteger(width)&&Number.isInteger(height)&&width>=1&&height>=1&&width<=1024&&height<=1024,'头像尺寸不能超过1024×1024');
 return {bytes,mime};
}

export function createPostgresProfile(pool,{schema}={}){
 requireRule(/^club_migration_[a-z0-9_]{1,40}$/.test(schema||''),'需要指定迁移隔离区');
 const run=(user,fn)=>postgresTransaction(pool,async c=>{
   requireRule(user?.role==='member'&&typeof user.id==='string','请使用会员账号',403);
   await c.query(`SET LOCAL search_path TO "${schema}"`);
   const live=(await c.query('SELECT role FROM users WHERE id=$1',[user.id])).rows[0];
   requireRule(live?.role==='member','账号状态已变化',403);
   return fn(c);
 });
 const view=row=>({nickname:row?.nickname||'',avatarDataUrl:row?.avatar_bytes?'data:'+row.avatar_mime+';base64,'+Buffer.from(row.avatar_bytes).toString('base64'):'',updatedAt:row?.updated_at||null});
 return {
   get:user=>run(user,async c=>({profile:view((await c.query('SELECT * FROM user_profiles WHERE user_id=$1',[user.id])).rows[0])})),
   save:(user,input)=>run(user,async c=>{
     requireRule(input&&typeof input==='object'&&!Array.isArray(input)&&Object.keys(input).every(k=>['nickname','avatarBase64','removeAvatar'].includes(k)),'资料字段不正确');
     requireRule(typeof input.nickname==='string','请填写昵称');
     const nickname=input.nickname.trim();
     requireRule([...nickname].length>=1&&[...nickname].length<=24&&!/[\x00-\x1f\x7f-\x9f<>\u200b-\u200f\u2028-\u202e\u2060-\u206f\ufeff]/.test(nickname),'昵称需为1至24字，不能包含控制字符或标签');
     requireRule(input.removeAvatar===undefined||input.removeAvatar===true,'头像操作不正确');
     requireRule(!(input.removeAvatar&&input.avatarBase64!==undefined),'头像操作冲突');
     const avatar=input.avatarBase64===undefined?null:validateProfileAvatar(input.avatarBase64);
     const replace=!!avatar||input.removeAvatar===true;
     const row=(await c.query(`INSERT INTO user_profiles(user_id,nickname,avatar_bytes,avatar_mime,updated_at) VALUES($1,$2,$3,$4,$5)
       ON CONFLICT(user_id) DO UPDATE SET nickname=EXCLUDED.nickname,
       avatar_bytes=CASE WHEN $6 THEN EXCLUDED.avatar_bytes ELSE user_profiles.avatar_bytes END,
       avatar_mime=CASE WHEN $6 THEN EXCLUDED.avatar_mime ELSE user_profiles.avatar_mime END,updated_at=EXCLUDED.updated_at RETURNING *`,
       [user.id,nickname,avatar?.bytes||null,avatar?.mime||null,nowISO(),replace])).rows[0];
     await c.query('INSERT INTO audit_log(actor_id,action,target_id,detail,created_at) VALUES($1,$2,$3,$4,$5)',[user.id,'profile.updated',user.id,JSON.stringify({avatarChanged:replace}),nowISO()]);
     return {profile:view(row)};
   })
 };
}
