import {createHash} from 'node:crypto';
import {requireRule} from './domain.mjs';
import {maxFileBytes,maxStoredBytes} from './enterprise-intake.mjs';

const sha=v=>createHash('sha256').update(v).digest('hex');
export function prepareSurveyMaterial(side,body){
 const present=body.fileBase64!==undefined||body.filename!==undefined;
 if(!present)return null;
 requireRule(side==='general-supply','本问卷不接收附件');
 requireRule(typeof body.filename==='string'&&body.filename.length<=160&&!/[\\/\x00-\x1f\x7f]/.test(body.filename)&&/\.pdf$/i.test(body.filename),'请将公司与产品资料合并为一份PDF');
 const b=body.fileBase64;
 requireRule(typeof b==='string'&&b.length>0&&b.length<=Math.ceil(maxFileBytes/3)*4,'附件不能超过5MB',413);
 requireRule(b.length%4===0&&/^[A-Za-z0-9+/]+={0,2}$/.test(b),'附件内容无效');
 const bytes=Buffer.from(b,'base64');
 requireRule(bytes.length>20&&bytes.length<=maxFileBytes&&bytes.toString('base64')===b&&bytes.subarray(0,5).toString()==='%PDF-'&&bytes.subarray(-2048).includes(Buffer.from('%%EOF')),'PDF文件格式不正确');
 return {filename:body.filename,bytes,hash:sha(bytes)};
}
export function surveyMaterialHash(hash,file){return file?sha(JSON.stringify([hash,file.filename,file.hash])):hash;}
export async function saveSurveyMaterial(client,{id,side,answers,definition,file,key,hash,legal,body,now}){
 if(!file)return;
 await client.query('LOCK TABLE enterprise_intakes IN SHARE ROW EXCLUSIVE MODE');
 const {rows:[quota]}=await client.query('SELECT coalesce(sum(byte_size),0)::bigint AS bytes,count(*) FILTER (WHERE submitted_at>$1) AS recent FROM enterprise_intakes',[new Date(Date.now()-86400000).toISOString()]);
 requireRule(Number(quota.bytes)+file.bytes.length<=maxStoredBytes,'资料收集空间已满，请联系工作人员',503);
 requireRule(Number(quota.recent)<100,'今日资料提交较多，请明日重试',429);
 // The survey receipt is also the private material ID. Both records commit together.
 await client.query(`INSERT INTO enterprise_intakes(id,company,contact,phone,note,answers_json,fields_json,filename,byte_size,sha256,file_data,submitted_at,template_version,consent_json,idempotency_key,request_hash) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16)`,[id,answers.company,answers.contact,answers.phone,'通用产品服务问卷附件；问卷回执：'+id,JSON.stringify(answers),JSON.stringify(definition.fields),file.filename,file.bytes.length,file.hash,file.bytes,now,'survey-material-v1:'+side,JSON.stringify({accepted:true,releaseId:legal?.id??null,hongKongAccepted:body.legalConsent?.hongKongAccepted===true,scope:'private-supply-demand'}),sha('survey-material:'+key),hash]);
}
export function surveyExportSchemas(schemas){
 return {...schemas,'general-supply':{...schemas['general-supply'],fields:[...schemas['general-supply'].fields,{id:'attachmentFilename',number:22,label:'附加资料文件名',options:[]},{id:'attachmentReceipt',number:23,label:'附加资料回执（在问卷后台查看下载）',options:[]}]}};
}
