import {prepareSurveyMaterial,surveyMaterialHash,saveSurveyMaterial,surveyExportSchemas} from './survey-material.mjs';
import {randomUUID,createHash} from 'node:crypto';
import {postgresTransaction,safeInteger} from './postgres.mjs';
import {requireRule,nowISO} from './domain.mjs';
import {prepareSurvey,surveys} from './surveys.mjs';
import {prepareEnterpriseIntake,intakeVersion,maxStoredBytes,sendEnterpriseUpload} from './enterprise-intake.mjs';

// Explicit isolated schema; never fall back to public or change a pooled connection globally.
export function createPostgresForms(pool,{schema}={}) {
  if(!/^club_migration_[a-z0-9_]{1,40}$/.test(schema||''))throw new Error('需要显式指定迁移隔离区');
  const run=fn=>postgresTransaction(pool,async client=>{
    await client.query(`SET LOCAL search_path TO "${schema}"`);
    return fn(client);
  });
  const audit=(client,actor,action,target,detail={})=>client.query(
    'INSERT INTO audit_log(actor_id,action,target_id,detail,created_at) VALUES($1,$2,$3,$4,$5)',
    [actor,action,target,JSON.stringify(detail),nowISO()]);
  async function admin(client,user){
    requireRule(user?.role==='admin','需要管理员权限',403);
    const result=await client.query("SELECT id FROM users WHERE id=$1 AND role='admin'",[user.id]);
    requireRule(result.rows.length===1,'需要管理员权限',403);
  }
  function cursor(before){
    const value=before===undefined?Number.MAX_SAFE_INTEGER:Number(before);
    requireRule(Number.isSafeInteger(value)&&value>0,'分页编号不正确');return value;
  }
  function consent(body,legal){
    if(legal)requireRule(body?.accepted===true&&body.releaseId===legal.id&&(!legal.requireHongKongConsent||body.hongKongAccepted===true),'请阅读当前协议并确认适用的存储安排',409);
  }
  return {
    storage:'postgres',
    async submitSurvey(side,body,key,legal){
      consent(body.legalConsent,legal);
      const {schema:definition,answers,hash:answerHash}=prepareSurvey(side,body,key);
      const file=prepareSurveyMaterial(side,body),hash=surveyMaterialHash(answerHash,file);
      return run(async client=>{
        const id=randomUUID();
        if(file){answers.attachmentFilename=file.filename;answers.attachmentReceipt=id;}
        const inserted=await client.query(`INSERT INTO survey_submissions(id,survey_id,version,answers_json,submitted_at,idempotency_key,request_hash)
          VALUES($1,$2,$3,$4,$5,$6,$7) ON CONFLICT(idempotency_key) DO NOTHING RETURNING id`,
          [id,side,definition.version,JSON.stringify(answers),nowISO(),key,hash]);
        if(!inserted.rows.length){
          const {rows:[previous]}=await client.query('SELECT id,request_hash FROM survey_submissions WHERE idempotency_key=$1',[key]);
          requireRule(previous?.request_hash===hash,'本次提交内容已变化，请生成新的提交记录',409);
          return {id:previous.id,duplicate:true};
        }
        await saveSurveyMaterial(client,{id,side,answers,definition,file,key,hash,legal,body,now:nowISO()});
        if(legal)await audit(client,null,'survey.legal_accepted',id,{releaseId:legal.id,documents:legal.documents,accepted:true,hongKongAccepted:body.legalConsent.hongKongAccepted===true});
        await audit(client,null,'survey.submitted',id,{side,version:definition.version});
        return {id,duplicate:false};
      });
    },
    async listSurveys(user,before,side){
      const position=cursor(before);requireRule(!side||Object.hasOwn(surveys,side),'问卷不存在',404);
      return run(async client=>{
        await admin(client,user);
        const {rows}=await client.query('SELECT seq,id,survey_id,version,answers_json,submitted_at FROM survey_submissions WHERE seq<$1 AND ($2::text IS NULL OR survey_id=$2) ORDER BY seq DESC LIMIT 100',[position,side||null]);
        await audit(client,user.id,'survey.exported','survey',{count:rows.length});
        return {submissions:rows.map(({seq,answers_json,...row})=>({...row,seq:safeInteger(seq),answers:JSON.parse(answers_json)})),schemas:surveyExportSchemas(surveys),next:rows.length===100?safeInteger(rows.at(-1).seq):null};
      });
    },
    async saveEnterpriseIntake(body,key,legal){
      const value=prepareEnterpriseIntake(body,key,legal);
      return run(async client=>{
        // All writers in this repository serialize quota checks and inserts across instances.
        await client.query('LOCK TABLE enterprise_intakes IN SHARE ROW EXCLUSIVE MODE');
        const {rows:[previous]}=await client.query('SELECT id,request_hash FROM enterprise_intakes WHERE idempotency_key=$1',[key]);
        if(previous){requireRule(previous.request_hash===value.requestHash,'提交内容已变化，请重新选择文件后提交',409);return {id:previous.id,duplicate:true};}
        const {rows:[quota]}=await client.query('SELECT coalesce(sum(byte_size),0)::bigint AS bytes,count(*) FILTER (WHERE submitted_at>$1) AS recent FROM enterprise_intakes',[new Date(Date.now()-86400000).toISOString()]);
        requireRule(safeInteger(quota.bytes)+value.bytes.length<=maxStoredBytes,'资料收集空间已满，请联系工作人员',503);
        requireRule(safeInteger(quota.recent)<100,'今日资料提交较多，请联系工作人员或明日重试',429);
        const id=randomUUID(),v=value;
        await client.query(`INSERT INTO enterprise_intakes(id,company,contact,phone,note,answers_json,fields_json,filename,byte_size,sha256,file_data,submitted_at,template_version,consent_json,idempotency_key,request_hash)
          VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16)`,
          [id,v.company,v.contact,v.phone,v.note,JSON.stringify(v.answers),JSON.stringify(v.fields),v.filename,v.bytes.length,v.hash,v.bytes,nowISO(),intakeVersion,JSON.stringify(v.consent),key,v.requestHash]);
        await audit(client,null,'enterprise_intake.submitted',id,{templateVersion:intakeVersion,bytes:v.bytes.length});
        return {id,duplicate:false};
      });
    },
    async listEnterpriseIntakes(user,before){
      const position=cursor(before);
      return run(async client=>{
        await admin(client,user);
        const {rows}=await client.query("SELECT seq,id,company,contact,phone,note,answers_json,fields_json,filename,byte_size,submitted_at,template_version FROM enterprise_intakes WHERE seq<$1 AND template_version NOT LIKE 'application-materials-v1:%' AND template_version NOT LIKE 'survey-material-v1:%' ORDER BY seq DESC LIMIT 100",[position]);
        return {submissions:rows.map(({seq,byte_size,answers_json,fields_json,...row})=>({...row,seq:safeInteger(seq),byte_size:safeInteger(byte_size),answers:JSON.parse(answers_json),fields:JSON.parse(fields_json)})),next:rows.length===100?safeInteger(rows.at(-1).seq):null};
      });
    },
    async downloadSurveyMaterial(user,id,res){
      const row=await run(async client=>{
        await admin(client,user);
        const {rows:[row]}=await client.query("SELECT filename,file_data,sha256 FROM enterprise_intakes WHERE id=$1 AND template_version='survey-material-v1:general-supply'",[id]);
        requireRule(row,'问卷附件不存在',404);row.file_data=Buffer.from(row.file_data);
        requireRule(createHash('sha256').update(row.file_data).digest('hex')===row.sha256,'资料校验失败',500);
        await audit(client,user.id,'survey_material.downloaded',id);return row;
      });sendEnterpriseUpload(row,res);
    },
    async downloadEnterpriseUpload(user,id,res){
      const row=await run(async client=>{
        await admin(client,user);
        const {rows:[row]}=await client.query("SELECT filename,file_data,sha256 FROM enterprise_intakes WHERE id=$1 AND template_version NOT LIKE 'application-materials-v1:%' AND template_version NOT LIKE 'survey-material-v1:%'",[id]);
        requireRule(row,'资料不存在',404);
        row.file_data=Buffer.from(row.file_data);
        requireRule(createHash('sha256').update(row.file_data).digest('hex')===row.sha256,'资料校验失败，请联系技术人员',500);
        await audit(client,user.id,'enterprise_intake.downloaded',id);return row;
      });
      sendEnterpriseUpload(row,res);
    }
  };
}
