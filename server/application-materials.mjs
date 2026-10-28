import {randomUUID,createHash} from 'node:crypto';
import {requireRule,textField,validateKey,nowISO} from './domain.mjs';
import {postgresTransaction,safeInteger} from './postgres.mjs';
import {createEnterpriseUpload} from './enterprise-upload.mjs';
import {intakeVersion,maxFileBytes,maxStoredBytes,sendEnterpriseUpload} from './enterprise-intake.mjs';
export const applicationMaterialPrefix='application-materials-v1:';
const kinds=['partner','organization'],sha=v=>createHash('sha256').update(v).digest('hex');
const blanks=new Set(['d3f9c87526354f686c4668867b67d1ca0add210ede159664d5039b612768ff43','efca447f49ad607ddf35a6c4d9a7fea74c6a3eb8a74f1c8845e7dc5b3f1ff270']);
function identity(user,kind){requireRule(user?.id,'请先登录后上传材料',401);requireRule(kinds.includes(kind),'申请类型不存在',404);}
function storageKey(user,kind,key){identity(user,kind);validateKey(key);return sha(JSON.stringify(['application-materials',user.id,kind,key]));}
function consent(body,legal){requireRule(body.consent===true,'请同意将材料用于本次申请联系与办理');if(legal)requireRule(body.legalConsent?.accepted===true&&body.legalConsent.releaseId===legal.id&&(!legal.requireHongKongConsent||body.legalConsent.hongKongAccepted===true),'请阅读当前协议并确认适用的存储安排',409);}
export function prepareApplicationMaterial(user,kind,body,key,legal){
 const idempotencyKey=storageKey(user,kind,key);consent(body,legal);
 const company=textField(body.company,'机构或企业名称',160,true),contact=textField(body.contact,'联系人',80,true),phone=textField(body.phone,'联系电话',30,true),note=textField(body.note??'','补充说明',1000);
 requireRule(/^\+?[0-9 ()-]{6,30}$/.test(phone)&&phone.replace(/\D/g,'').length>=6,'请填写有效联系电话');
 const filename=textField(body.filename,'文件名',160,true);requireRule(!/[\\/\x00-\x1f\x7f]/.test(filename)&&/\.(docx|pdf)$/i.test(filename),'仅支持DOCX或PDF，盖章材料请扫描为PDF');
 const b=body.fileBase64;requireRule(typeof b==='string'&&b.length>0&&b.length<=Math.ceil(maxFileBytes/3)*4,'文件不能超过5MB',413);requireRule(b.length%4===0&&/^[A-Za-z0-9+/]+={0,2}$/.test(b),'文件内容无效');
 const bytes=Buffer.from(b,'base64');requireRule(bytes.length>20&&bytes.length<=maxFileBytes&&bytes.toString('base64')===b,'文件内容或大小无效');
 if(/\.pdf$/i.test(filename))requireRule(bytes.subarray(0,5).toString()==='%PDF-'&&bytes.subarray(-2048).includes(Buffer.from('%%EOF')),'PDF文件格式不正确');else validateDocx(bytes);
 const hash=sha(bytes);requireRule(!blanks.has(hash),'这是空白模板，请上传填写后的材料');
 const accepted={scope:'private-application-materials',accepted:true,legalReleaseId:legal?.id??null,documents:legal?.documents??[],hongKongAccepted:body.legalConsent?.hongKongAccepted===true};
 return {company,contact,phone,note,filename,bytes,hash,idempotencyKey,accepted,requestHash:sha(JSON.stringify({userId:user.id,kind,company,contact,phone,note,filename,hash,accepted}))};
}
// Reuses bounded 30KB transport; all staging is additionally bound to identity and kind.
export function createApplicationUpload(options){
 const base=createEnterpriseUpload(options),owners=new Map();
 function owned(user,kind,id){identity(user,kind);const a=owners.get(id);requireRule(a&&a.user===user.id&&a.kind===kind,'材料上传已过期或无权访问',403);return a;}
 return {
 start(user,kind,body,key,legal){const k=storageKey(user,kind,key);const result=base.start({...body,templateVersion:intakeVersion},k,legal);for(const [id,a] of owners)if(a.expires<=Date.now())owners.delete(id);owners.set(result.id,{user:user.id,kind,key:k,expires:Date.now()+10*60*1000});return result;},
 append(user,kind,id,index,body){owned(user,kind,id);return base.append(id,index,body);},
 resolve(user,kind,body,key){const a=owned(user,kind,body.fileUploadId);requireRule(a.key===storageKey(user,kind,key),'上传请求编号不一致',409);return base.resolve({...body,templateVersion:intakeVersion});},
 release(user,kind,id,token){owned(user,kind,id);base.release(id,token);owners.delete(id);},
 close(){base.close();owners.clear();}
 };
}
export function createApplicationMaterials(pool,{schema}={}){
 requireRule(/^club_migration_[a-z0-9_]{1,40}$/.test(schema||''),'需要显式指定迁移隔离区');
 const run=fn=>postgresTransaction(pool,async c=>{await c.query(`SET LOCAL search_path TO "${schema}"`);return fn(c);});
 async function auth(c,user,admin=false){requireRule(user?.id,'请先登录',401);requireRule(!admin||user.role==='admin','需要管理员权限',403);const {rows}=await c.query('SELECT id,role FROM users WHERE id=$1',[user.id]);requireRule(rows.length===1&&(!admin||rows[0].role==='admin'),'无权访问',403);}
 const audit=(c,user,action,id,detail={})=>c.query('INSERT INTO audit_log(actor_id,action,target_id,detail,created_at) VALUES($1,$2,$3,$4,$5)',[user.id,action,id,JSON.stringify(detail),nowISO()]);
 const position=before=>{const n=before===undefined?Number.MAX_SAFE_INTEGER:Number(before);requireRule(Number.isSafeInteger(n)&&n>0,'分页编号不正确');return n;};
 const map=r=>({id:r.id,seq:safeInteger(r.seq),kind:r.template_version.slice(applicationMaterialPrefix.length),company:r.company,contact:r.contact,phone:r.phone,note:r.note,filename:r.filename,byte_size:safeInteger(r.byte_size),submitted_at:r.submitted_at,status:'submitted'});
 const columns='seq,id,company,contact,phone,note,filename,byte_size,submitted_at,template_version';
 return {
 async save(user,kind,body,key,legal){const v=prepareApplicationMaterial(user,kind,body,key,legal);return run(async c=>{
  await auth(c,user);await c.query('LOCK TABLE enterprise_intakes IN SHARE ROW EXCLUSIVE MODE');
  const {rows:[previous]}=await c.query('SELECT id,request_hash FROM enterprise_intakes WHERE idempotency_key=$1',[v.idempotencyKey]);
  if(previous){requireRule(previous.request_hash===v.requestHash,'提交内容已变化，请重新选择文件后提交',409);return {id:previous.id,duplicate:true};}
  const {rows:[q]}=await c.query('SELECT coalesce(sum(byte_size),0)::bigint AS bytes,count(*) FILTER (WHERE submitted_at>$1) AS recent FROM enterprise_intakes',[new Date(Date.now()-86400000).toISOString()]);
  requireRule(safeInteger(q.bytes)+v.bytes.length<=maxStoredBytes,'资料收集空间已满，请联系工作人员',503);requireRule(safeInteger(q.recent)<100,'今日资料提交较多，请明日重试',429);
  const id=randomUUID();await c.query(`INSERT INTO enterprise_intakes(id,company,contact,phone,note,answers_json,fields_json,filename,byte_size,sha256,file_data,submitted_at,template_version,consent_json,idempotency_key,request_hash) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16)`,[id,v.company,v.contact,v.phone,v.note,JSON.stringify({userId:user.id,kind}),JSON.stringify([]),v.filename,v.bytes.length,v.hash,v.bytes,nowISO(),applicationMaterialPrefix+kind,JSON.stringify(v.accepted),v.idempotencyKey,v.requestHash]);
  await audit(c,user,'application_material.submitted',id,{kind,bytes:v.bytes.length});return {id,duplicate:false};
 });},
 async listMine(user,kind,before){identity(user,kind);const n=position(before);return run(async c=>{await auth(c,user);const {rows}=await c.query(`SELECT ${columns} FROM enterprise_intakes WHERE seq<$1 AND template_version=$2 AND answers_json::jsonb->>'userId'=$3 ORDER BY seq DESC LIMIT 50`,[n,applicationMaterialPrefix+kind,user.id]);return {submissions:rows.map(map),next:rows.length===50?safeInteger(rows.at(-1).seq):null};});},
 async listAdmin(user,before,kind){const n=position(before);requireRule(!kind||kinds.includes(kind),'申请类型不存在',404);return run(async c=>{await auth(c,user,true);const {rows}=await c.query(`SELECT ${columns} FROM enterprise_intakes WHERE seq<$1 AND template_version IN ($2,$3) AND ($4::text IS NULL OR template_version=$4) ORDER BY seq DESC LIMIT 50`,[n,...kinds.map(k=>applicationMaterialPrefix+k),kind?applicationMaterialPrefix+kind:null]);return {submissions:rows.map(map),next:rows.length===50?safeInteger(rows.at(-1).seq):null};});},
 async downloadAdmin(user,id,res){const row=await run(async c=>{await auth(c,user,true);const {rows:[r]}=await c.query('SELECT filename,file_data,sha256 FROM enterprise_intakes WHERE id=$1 AND template_version IN ($2,$3)',[id,...kinds.map(k=>applicationMaterialPrefix+k)]);requireRule(r,'材料不存在',404);r.file_data=Buffer.from(r.file_data);requireRule(sha(r.file_data)===r.sha256,'资料校验失败，请联系技术人员',500);await audit(c,user,'application_material.downloaded',id);return r;});sendEnterpriseUpload(row,res);}
 };
}
function validateDocx(bytes){
 let end=-1;
 for(let i=bytes.length-22;i>=Math.max(0,bytes.length-65557);i--)if(bytes.readUInt32LE(i)===0x06054b50){end=i;break;}
 requireRule(end>=0,'Word文件损坏，请另存为.docx后重新上传');
 const entries=bytes.readUInt16LE(end+10),size=bytes.readUInt32LE(end+12),offset=bytes.readUInt32LE(end+16);
 requireRule(bytes.readUInt16LE(end+4)===0&&bytes.readUInt16LE(end+6)===0&&entries>0&&entries<=2000&&offset+size===end,'不支持此Word文件格式');
 const names=new Set();let cursor=offset,total=0;
 for(let i=0;i<entries;i++){
  requireRule(cursor+46<=end&&bytes.readUInt32LE(cursor)===0x02014b50,'Word文件目录不完整');
  const length=bytes.readUInt16LE(cursor+28),extra=bytes.readUInt16LE(cursor+30),comment=bytes.readUInt16LE(cursor+32);
  const next=cursor+46+length+extra+comment;requireRule(next<=end,'Word文件目录不完整');
  const name=bytes.subarray(cursor+46,cursor+46+length).toString('utf8');
  requireRule(!(bytes.readUInt16LE(cursor+8)&1)&&[0,8].includes(bytes.readUInt16LE(cursor+10)),'不支持加密的Word文件');
  requireRule(!name.includes('..')&&!name.startsWith('/')&&!name.includes('\\')&&!/vbaProject|embeddings\/|\.exe$|\.js$/i.test(name),'请上传不含宏或嵌入程序的Word文件');
  total+=bytes.readUInt32LE(cursor+24);requireRule(total<=32*1024*1024,'Word解压体积过大，请精简后上传');
  names.add(name);cursor=next;
 }
 requireRule(cursor===end&&names.has('[Content_Types].xml')&&names.has('word/document.xml'),'请上传有效的.docx文件');
}

