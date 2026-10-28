import {randomUUID,createHash} from 'node:crypto';
import {requireRule,textField,validateKey,nowISO} from './domain.mjs';
import {transaction,audit} from './db.mjs';
import definition from '../shared/enterprise-fields.json' with {type:'json'};

export const intakeVersion=definition.version;
export const maxFileBytes=5*1024*1024;
export const maxStoredBytes=256*1024*1024;
const emptyTemplates=new Set(['ee520b26c55ba8b742e497e6e037007b2d289bea9b23ea0680585226314f4e14','e88ebfcbcfc8f73d3bdb44fab9c5e8ab28f1c4720cc7cda94c0cf8671d0ad444','3fa202bb3adb99dcd9df9a0a73cfcf4778552117f52b318e6ebc88c2578cda14']);
const sha=bytes=>createHash('sha256').update(bytes).digest('hex');
export function installEnterpriseIntake(db){
 transaction(db,()=>db.exec(`CREATE TABLE IF NOT EXISTS enterprise_intakes (
  seq INTEGER PRIMARY KEY AUTOINCREMENT,id TEXT NOT NULL UNIQUE,
  company TEXT NOT NULL,contact TEXT NOT NULL,phone TEXT NOT NULL,note TEXT NOT NULL,
  answers_json TEXT NOT NULL,fields_json TEXT NOT NULL,
  filename TEXT NOT NULL,byte_size INTEGER NOT NULL,sha256 TEXT NOT NULL,file_data BLOB NOT NULL,
  submitted_at TEXT NOT NULL,template_version TEXT NOT NULL,consent_json TEXT NOT NULL,
  idempotency_key TEXT NOT NULL UNIQUE,request_hash TEXT NOT NULL
 ); INSERT OR IGNORE INTO schema_version VALUES (14);`));
}
export function intakeConfig(enabled){return {mode:enabled?'hybrid':'closed',maxFileBytes,templateVersion:intakeVersion,fields:definition.fields,templates:{docx:'forms/enterprise-template-20260923.docx',pdf:'forms/enterprise-template-20260923.pdf'}};}

export function validateEnterpriseAnswers(raw){
 requireRule(raw&&typeof raw==='object'&&!Array.isArray(raw),'请填写关键统计信息');
 requireRule(Object.keys(raw).every(id=>definition.fields.some(f=>f.id===id)),'包含不支持的统计字段，请刷新页面');
 const answers={};
 for(const f of definition.fields){
  const value=raw[f.id];
  if(f.type==='multi'){
   requireRule(Array.isArray(value)&&value.length<=f.maxChoices&&(!f.required||value.length>0)&&new Set(value).size===value.length&&value.every(v=>f.options.includes(v)),`${f.label}请选择1至${f.maxChoices}项`);
   requireRule(!value.includes(f.exclusive)||value.length===1,`${f.label}的待定选项不可与其他项同时选择`);
   answers[f.id]=f.options.filter(o=>value.includes(o));
  }else if(f.type==='single'){
   requireRule(f.options.includes(value),`请选择${f.label}`);answers[f.id]=value;
  }else answers[f.id]=textField(value??'',f.label,f.maxLength,f.required);
 }
 return answers;
}

// Inspect bounded ZIP directory metadata without extracting or executing uploaded content.
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
export function prepareEnterpriseIntake(body,key,legal=null){
 validateKey(key);requireRule(body.templateVersion===intakeVersion,'模板版本已变化，请刷新页面',409);
 requireRule(body.consent===true,'请确认信息用途与上传授权');
 if(legal)requireRule(body.legalConsent?.accepted===true&&(!legal.requireHongKongConsent||body.legalConsent?.hongKongAccepted===true)&&body.legalConsent?.releaseId===legal.id,'请阅读当前协议并确认适用的存储安排',409);
 const company=textField(body.company,'企业名称',160,true),contact=textField(body.contact,'联系人',80,true),phone=textField(body.phone,'联系电话',30,true),note=textField(body.note??'','补交说明',1000,false);
 const answers=validateEnterpriseAnswers(body.answers);
 requireRule(/^\+?[0-9 ()-]{6,30}$/.test(phone)&&phone.replace(/\D/g,'').length>=6,'请填写有效联系电话');
 const filename=textField(body.filename,'文件名',160,true);
 requireRule(!/[\\/\x00-\x1f\x7f]/.test(filename)&&/\.(docx|pdf)$/i.test(filename),'仅支持.docx或.pdf文件');
 const encoded=body.fileBase64;
 requireRule(typeof encoded==='string'&&encoded.length>0&&encoded.length<=Math.ceil(maxFileBytes/3)*4,'文件不能超过5MB',413);
 requireRule(encoded.length%4===0&&/^[A-Za-z0-9+/]+={0,2}$/.test(encoded),'文件内容无效');
 const bytes=Buffer.from(encoded,'base64');requireRule(bytes.length>20&&bytes.length<=maxFileBytes&&bytes.toString('base64')===encoded,'文件内容或大小无效');
 if(/\.pdf$/i.test(filename))requireRule(bytes.subarray(0,5).toString()==='%PDF-'&&bytes.subarray(-2048).includes(Buffer.from('%%EOF')),'PDF文件格式不正确');
 else validateDocx(bytes);
 const hash=sha(bytes);requireRule(!emptyTemplates.has(hash),'这是未修改的空白模板，请选择填好后的文件');
 const consent={scope:'internal-enterprise-assessment-and-contact',version:intakeVersion,accepted:true,legalReleaseId:legal?.id??null,documents:legal?.documents??[],hongKongAccepted:body.legalConsent?.hongKongAccepted===true};
 const requestHash=sha(JSON.stringify({company,contact,phone,note,answers,filename,hash,consent}));
 return {company,contact,phone,note,answers,filename,bytes,hash,consent,requestHash,fields:definition.fields};
}
export function saveEnterpriseIntake(db,body,key,legal=null){
 const {company,contact,phone,note,answers,filename,bytes,hash,consent,requestHash}=prepareEnterpriseIntake(body,key,legal);
 return transaction(db,()=>{
  const previous=db.prepare('SELECT id,request_hash FROM enterprise_intakes WHERE idempotency_key=?').get(key);
  if(previous){requireRule(previous.request_hash===requestHash,'提交内容已变化，请重新选择文件后提交',409);return {id:previous.id,duplicate:true};}
  const used=db.prepare('SELECT coalesce(sum(byte_size),0) AS bytes FROM enterprise_intakes').get().bytes;
  requireRule(used+bytes.length<=maxStoredBytes,'资料收集空间已满，请联系工作人员',503);
  const recent=db.prepare('SELECT count(*) AS n FROM enterprise_intakes WHERE submitted_at>?').get(new Date(Date.now()-86400000).toISOString()).n;
  requireRule(recent<100,'今日资料提交较多，请联系工作人员或明日重试',429);
  const id=randomUUID();
  db.prepare(`INSERT INTO enterprise_intakes(id,company,contact,phone,note,answers_json,fields_json,filename,byte_size,sha256,file_data,submitted_at,template_version,consent_json,idempotency_key,request_hash) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`).run(id,company,contact,phone,note,JSON.stringify(answers),JSON.stringify(definition.fields),filename,bytes.length,hash,bytes,nowISO(),intakeVersion,JSON.stringify(consent),key,requestHash);
  audit(db,null,'enterprise_intake.submitted',id,{templateVersion:intakeVersion,bytes:bytes.length});return {id,duplicate:false};
 });
}
export function listEnterpriseIntakes(db,user,before){
 requireRule(user?.role==='admin','需要管理员权限',403);
 const cursor=before===undefined?Number.MAX_SAFE_INTEGER:Number(before);
 requireRule(Number.isSafeInteger(cursor)&&cursor>0,'分页编号不正确');
 const rows=db.prepare('SELECT seq,id,company,contact,phone,note,answers_json,fields_json,filename,byte_size,submitted_at,template_version FROM enterprise_intakes WHERE seq<? ORDER BY seq DESC LIMIT 100').all(cursor);
 return {submissions:rows.map(({answers_json,fields_json,...row})=>({...row,answers:JSON.parse(answers_json),fields:JSON.parse(fields_json)})),next:rows.length===100?rows.at(-1).seq:null};
}
export function downloadEnterpriseUpload(db,user,id,res){
 requireRule(user?.role==='admin','需要管理员权限',403);
 const row=db.prepare('SELECT filename,file_data,sha256 FROM enterprise_intakes WHERE id=?').get(id);requireRule(row,'资料不存在',404);
 requireRule(sha(row.file_data)===row.sha256,'资料校验失败，请联系技术人员',500);
 audit(db,user.id,'enterprise_intake.downloaded',id,{});
 sendEnterpriseUpload(row,res);
}
export function sendEnterpriseUpload(row,res){
 res.writeHead(200,{'Content-Type':'application/octet-stream','Content-Length':row.file_data.length,'Content-Disposition':`attachment; filename="enterprise-submission.${row.filename.toLowerCase().endsWith('.pdf')?'pdf':'docx'}"; filename*=UTF-8''${encodeURIComponent(row.filename)}`,'Cache-Control':'no-store','X-Content-Type-Options':'nosniff','Content-Security-Policy':"sandbox; default-src 'none'"});res.end(Buffer.from(row.file_data));
}
