import {randomUUID} from 'node:crypto';
import {transaction,audit} from './db.mjs';
import {requireRule,textField,validateKey,digest,nowISO} from './domain.mjs';

function fields(input){
 requireRule(input&&typeof input==='object','活动格式不正确');
 const value={title:textField(input.title,'活动名称',80,true),summary:textField(input.summary||'','活动简介',180),
   body:textField(input.body||'','活动详情',4000),mode:input.mode,
   startAt:input.startAt||'',endAt:input.endAt||'',location:textField(input.location||'','活动地点或线上参与说明',300),organizer:textField(input.organizer||'','主办方',100)};
 requireRule(['offline','online'].includes(value.mode),'请选择线上或线下活动');
 for(const key of ['startAt','endAt'])if(value[key]){requireRule(typeof value[key]==='string'&&/^\d{4}-\d\d-\d\dT.*(?:Z|[+-]\d\d:\d\d)$/.test(value[key])&&Number.isFinite(Date.parse(value[key])),'活动时间格式不正确');value[key]=new Date(value[key]).toISOString();}
 if(value.startAt&&value.endAt)requireRule(Date.parse(value.endAt)>Date.parse(value.startAt),'结束时间必须晚于开始时间');
 return value;
}
function editor(actor){requireRule(actor?.role==='admin','需要活动管理权限',403);}
function view(row){return {id:row.id,...JSON.parse(row.content_json),status:row.status,revision:row.revision,publishedAt:row.published_at};}
export function listActivities(db,actor,managed=false){
 if(managed)editor(actor);
 return db.prepare(managed?'SELECT * FROM activities ORDER BY updated_at DESC,id':"SELECT * FROM activities WHERE status='published' ORDER BY json_extract(content_json,'$.startAt') DESC,id").all().map(view);
}
export function readActivity(db,id){const row=db.prepare("SELECT * FROM activities WHERE id=? AND status='published'").get(id);requireRule(row,'活动不存在或已撤下',404);return view(row);}
export function saveActivity(db,actor,input,key,id){
 editor(actor);const content=fields(input),hash=digest(JSON.stringify(content));if(!id)validateKey(key);
 return transaction(db,()=>{
   if(!id){const prior=db.prepare('SELECT * FROM activities WHERE created_by=? AND idempotency_key=?').get(actor.id,key);if(prior){requireRule(prior.creation_hash===hash,'提交编号已用于其他活动',409);return view(prior);}}
   const now=nowISO();
   if(id){const row=db.prepare('SELECT * FROM activities WHERE id=?').get(id);requireRule(row,'活动不存在',404);requireRule(row.revision===input.revision&&row.status==='draft','活动已变化或已发布，请刷新并先撤下再修改',409);db.prepare('UPDATE activities SET content_json=?,revision=revision+1,updated_at=? WHERE id=?').run(JSON.stringify(content),now,id);}
   else{id=randomUUID();db.prepare("INSERT INTO activities(id,content_json,status,revision,created_by,created_at,updated_at,idempotency_key,creation_hash) VALUES (?,?,'draft',1,?,?,?,?,?)").run(id,JSON.stringify(content),actor.id,now,now,key,hash);}
   const result=view(db.prepare('SELECT * FROM activities WHERE id=?').get(id));audit(db,actor.id,'activity.saved',id,{revision:result.revision});return result;
 });
}
export function transitionActivity(db,actor,id,action,revision){
 editor(actor);requireRule(['publish','unpublish'].includes(action),'活动操作不正确');
 return transaction(db,()=>{
  const row=db.prepare('SELECT * FROM activities WHERE id=?').get(id);requireRule(row,'活动不存在',404);
  requireRule(Number.isSafeInteger(revision)&&row.revision===revision&&row.status===(action==='publish'?'draft':'published'),'活动状态已变化，请刷新后重试',409);
  if(action==='publish'){const content=fields(JSON.parse(row.content_json));requireRule(content.body&&content.startAt&&content.endAt&&content.location&&content.organizer,'发布前请补齐时间、地点、主办方及活动详情');requireRule(Date.parse(content.endAt)>Date.now(),'已结束的活动不能新发布');}
  const now=nowISO();db.prepare('UPDATE activities SET status=?,revision=revision+1,updated_at=?,published_at=? WHERE id=?').run(action==='publish'?'published':'draft',now,action==='publish'?now:row.published_at,id);
  audit(db,actor.id,'activity.'+action,id,{revision:row.revision+1});return view(db.prepare('SELECT * FROM activities WHERE id=?').get(id));
 });
}
