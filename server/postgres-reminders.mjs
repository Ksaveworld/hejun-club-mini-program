import { randomUUID } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { postgresTransaction, safeInteger } from './postgres.mjs';
import { requireRule, validateKey, digest } from './domain.mjs';
export const reminderMigrationMarker = { key: '_club_membership_reminders_migration', value: '006-membership-reminders-v1' };
export const reminderTables = ['_club_reminder_choices','_club_reminder_grants','_club_reminder_tasks','_club_reminder_events'];
const migration = readFileSync(new URL('./migrations/postgres/006-membership-reminders.sql', import.meta.url), 'utf8');
const schemaValid = schema => requireRule(/^club_migration_[a-z0-9_]{1,40}$/.test(schema ?? ''), '需要指定提醒隔离数据区');
const one = async (c, sql, args = []) => (await c.query(sql, args)).rows[0];
export async function reminderMigrationTables(c, schema) {
  schemaValid(schema); const marker = await one(c, 'SELECT value FROM settings WHERE key=$1', [reminderMigrationMarker.key]);
  const actual = (await c.query('SELECT tablename FROM pg_tables WHERE schemaname=$1', [schema])).rows.map(row => row.tablename), count = reminderTables.filter(name => actual.includes(name)).length;
  requireRule(!marker ? count === 0 : marker.value === reminderMigrationMarker.value && count === 4, '提醒迁移标记或表集合不一致', 503);
  return marker ? [...reminderTables] : [];
}
export async function initializePostgresReminders(pool, { schema } = {}) {
  schemaValid(schema); return postgresTransaction(pool, async c => {
    await c.query(`SET LOCAL search_path TO "${schema}"`); await c.query('LOCK TABLE settings IN SHARE ROW EXCLUSIVE MODE');
    if ((await reminderMigrationTables(c, schema)).length) return { initialized: false };
    await c.query(migration); return { initialized: true, tables: [...reminderTables] };
  });
}
function approvedConfig(config, appId) {
  const closed = reason => ({ enabled: false, reason });
  if (config?.status !== 'approved' || !config.version || !config.approvalRef || config.appId !== appId) return closed('到期提醒业务配置尚未批准或与当前小程序不符。');
  const template = config.template;
  if (template?.appId !== appId || template.verifiedForAppId !== true || !template.verificationRef || !template.id || template.kind !== 'once' || !template.title || !template.content || template.purpose !== 'membership_expiry') return closed('当前小程序的真实到期提醒模板及用途尚未核实。');
  if (JSON.stringify(config.offsetDays) !== '[30,15,7,3,1]' || !/^(?:[01]\d|2[0-3]):[0-5]\d$/.test(config.timeOfDay ?? '') || config.timezone !== 'Asia/Shanghai'
    || !Number.isSafeInteger(config.maxLatenessMs) || config.maxLatenessMs <= 0 || config.maxLatenessMs > 86400000 || !Number.isSafeInteger(config.sendLeaseMs) || config.sendLeaseMs < 10000 || !config.scheduleApprovalRef) return closed('提醒日期、具体北京时间和迟到处理尚未明确批准。');
  const keys = [...template.content.matchAll(/{{\s*([A-Za-z_]+\d+)\.DATA\s*}}/g)].map(match => match[1]);
  if (!keys.length || !config.copyApprovalRef || !config.fields || JSON.stringify([...keys].sort()) !== JSON.stringify(Object.keys(config.fields).sort())) return closed('秘书处提醒文案及真实模板字段映射尚未确认。');
  for (const [key, field] of Object.entries(config.fields)) if (!/^(thing|time|date|number|phrase|character_string)\d+$/.test(key) || !['expiry_date','days_remaining','membership_name','approved_text'].includes(field.source) || (field.source === 'approved_text' && (typeof field.value !== 'string' || !field.value))) return closed('提醒字段内容尚未核实。');
  if (config.page !== 'pages/account/index' || !['formal','trial','developer'].includes(config.miniprogramState)) return closed('提醒跳转与正式/测试发送环境尚未确认。');
  return { enabled: true, config };
}
function dueAt(expiry, days, timeOfDay) {
  const instant = Date.parse(expiry); requireRule(Number.isFinite(instant), '会籍到期时间不正确');
  const local = new Date(instant + 8 * 3600000), [hour, minute] = timeOfDay.split(':').map(Number);
  return new Date(Date.UTC(local.getUTCFullYear(), local.getUTCMonth(), local.getUTCDate() - days, hour - 8, minute)).toISOString();
}
function outbound(task, config, membership) {
  const expiryDate = new Date(Date.parse(task.expires_at) + 8 * 3600000).toISOString().slice(0, 10), data = {};
  for (const [key, field] of Object.entries(config.fields)) {
    const value = field.source === 'expiry_date' ? expiryDate : field.source === 'days_remaining' ? String(task.offset_days) : field.source === 'membership_name' ? config.planNames?.[membership.plan_id] : field.value;
    const prefix = /^([A-Za-z_]+)/.exec(key)[1], limit = { thing:20, phrase:5, character_string:32, number:32, time:32, date:32 }[prefix];
    requireRule(typeof value === 'string' && value.length > 0 && [...value].length <= limit && (prefix !== 'number' || /^\d+(\.\d+)?$/.test(value)), '已批准模板字段不能生成有效内容', 503); data[key] = { value };
  }
  return { touser: task.open_id, template_id: task.template_id, page: config.page, miniprogram_state: config.miniprogramState, lang: 'zh_CN', data };
}
const publicTask = row => ({ id: row.id, offsetDays: safeInteger(row.offset_days), dueAt: row.due_at, expiresAt: row.expires_at, status: row.status, reason: row.reason });

export function createPostgresReminders(pool, { schema, appId, enabled = false, configSettingKey = 'membership_reminders_v1', sender, now = () => new Date().toISOString() } = {}) {
  schemaValid(schema);
  const run = fn => postgresTransaction(pool, async c => { await c.query(`SET LOCAL search_path TO "${schema}"`); return fn(c); });
  async function configuration(c) {
    if (!enabled) return { enabled:false, reason:'到期提醒尚未启用，真实模板、提醒时点和发送渠道仍待核实。' };
    const setting = await one(c, 'SELECT value FROM settings WHERE key=$1', [configSettingKey]); let value; try { value = JSON.parse(setting?.value ?? 'null'); } catch {}
    const config = approvedConfig(value, appId); if (!config.enabled) return config;
    const marker = await one(c, 'SELECT value FROM settings WHERE key=$1', [reminderMigrationMarker.key]);
    if (marker?.value !== reminderMigrationMarker.value) return { enabled:false, reason:'到期提醒任务存储尚未初始化。' };
    return config;
  }
  async function identity(c, user) {
    requireRule(user?.role === 'member' && await one(c, "SELECT 1 FROM users WHERE id=$1 AND role='member'", [user.id]), '请使用当前本人会员身份', 403);
    return one(c, 'SELECT open_id FROM wechat_identities WHERE app_id=$1 AND user_id=$2', [appId,user.id]);
  }
  const service = {
    status:user => run(async c => {
      const bound = await identity(c,user), ready = await configuration(c);
      if (!ready.enabled) return { ...ready, tasks:[] };
      if (!bound) return { enabled:false,reason:'请通过当前小程序的本人微信身份登录后选择提醒。',tasks:[] };
      const tasks = (await c.query('SELECT * FROM _club_reminder_tasks WHERE user_id=$1 AND app_id=$2 ORDER BY due_at DESC LIMIT 30', [user.id,appId])).rows;
      const deliveryReady=sender?.configured===true&&sender.appId===appId;
      return { enabled:deliveryReady,appId,templateId:ready.config.template.id,configVersion:ready.config.version,reminderDays:[...ready.config.offsetDays],purposeText:ready.config.template.title,
        deliveryReady,reason:deliveryReady?'':'发送渠道仍待核实；同意订阅不代表已发出提醒。',tasks:tasks.map(publicTask) };
    }),
    recordChoice:(user,input,key) => run(async c => {
      await c.query('LOCK TABLE users IN SHARE ROW EXCLUSIVE MODE'); const bound = await identity(c,user), ready = await configuration(c); requireRule(ready.enabled,ready.reason,503); requireRule(bound,'本人微信身份未绑定',403); validateKey(key);
      requireRule(input && Object.keys(input).every(name => ['templateId','configVersion','result'].includes(name)) && ['accept','reject','ban','filter'].includes(input.result), '订阅选择不正确',400);
      const hash = digest(JSON.stringify(input)), old = await one(c,'SELECT * FROM _club_reminder_choices WHERE user_id=$1 AND idempotency_key=$2',[user.id,key]);
      if (old) { requireRule(old.request_hash===hash,'选择编号已用于不同内容',409); return { recorded:true,result:old.result,deliveryStatus:'not_sent',permissionVerified:false }; }
      requireRule(input.templateId===ready.config.template.id&&input.configVersion===ready.config.version,'提醒模板配置已变化，请重新读取',409);
      await c.query('INSERT INTO _club_reminder_choices VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9)',[user.id,key,hash,appId,bound.open_id,input.templateId,input.configVersion,input.result,now()]);
      return { recorded:true,result:input.result,deliveryStatus:'not_sent',permissionVerified:false };
    }),
    recordWechatEvent:event => run(async c => {
      requireRule(event?.verified===true&&event.source==='wechat_verified_callback'&&event.appId===appId&&event.id&&event.evidenceRef&&['popup','change','sent'].includes(event.kind),'微信事件必须先验证加密签名、所属小程序和模板',403);
      const ready=await configuration(c);let task;
      if(event.kind==='sent'){
        const marker=await one(c,'SELECT value FROM settings WHERE key=$1',[reminderMigrationMarker.key]);requireRule(marker?.value===reminderMigrationMarker.value,'提醒存储未初始化',503);
        requireRule(typeof event.providerMessageId==='string'&&Number.isSafeInteger(event.errorCode),'微信最终发送回执不正确',400);
        task=await one(c,'SELECT * FROM _club_reminder_tasks WHERE app_id=$1 AND provider_message_id=$2 FOR UPDATE',[appId,event.providerMessageId]);
        requireRule(task?(task.open_id===event.openId&&task.template_id===event.templateId):ready.enabled&&event.templateId===ready.config.template.id,'微信最终回执与发送任务或批准模板不符',409);
      }else{requireRule(ready.enabled,ready.reason,503);requireRule(event.templateId===ready.config.template.id,'微信订阅模板不符',403);}
      await c.query('LOCK TABLE _club_reminder_events IN SHARE ROW EXCLUSIVE MODE');
      const facts={...event};delete facts.evidenceRef;delete facts.verified;delete facts.source;
      const hash=digest(JSON.stringify(facts)),old=await one(c,'SELECT * FROM _club_reminder_events WHERE id=$1',[event.id]);if(old){requireRule(old.request_hash===hash,'微信事件内容冲突',409);if(event.kind!=='sent')return {recorded:true,replay:true};}
      const bound=task?{user_id:task.user_id}:await one(c,"SELECT w.user_id FROM wechat_identities w JOIN users u ON u.id=w.user_id WHERE w.app_id=$1 AND w.open_id=$2 AND u.role='member'",[appId,event.openId]);requireRule(bound,'微信事件不属于当前已绑定会员或已发任务',403);
      if(!old)await c.query('INSERT INTO _club_reminder_events VALUES($1,$2,$3,$4)',[event.id,hash,JSON.stringify(event),now()]);
      if(event.kind==='popup'&&event.result==='accept'){
        const newerRejection=await one(c,"SELECT 1 FROM _club_reminder_events WHERE event_json->>'appId'=$1 AND event_json->>'openId'=$2 AND event_json->>'templateId'=$3 AND event_json->>'result'='reject' AND event_json->>'occurredAt'>=$4",[appId,event.openId,event.templateId,event.occurredAt]);
        if(!newerRejection){
          await c.query("INSERT INTO _club_reminder_grants(id,user_id,app_id,open_id,template_id,status,created_at) VALUES($1,$2,$3,$4,$5,'available',$6)",[event.id,bound.user_id,appId,event.openId,event.templateId,now()]);
          await c.query("UPDATE _club_reminder_tasks t SET status='waiting_permission',reason=NULL,updated_at=$1 WHERE user_id=$2 AND app_id=$3 AND template_id=$4 AND status='cancelled' AND reason='微信已确认用户拒收' AND config_version=$5 AND due_at>=$6 AND EXISTS(SELECT 1 FROM memberships m WHERE m.user_id=t.user_id AND m.order_id=t.membership_order_id AND m.expires_at=t.expires_at AND m.expires_at>$1)",[now(),bound.user_id,appId,event.templateId,ready.config.version,new Date(Date.parse(now())-ready.config.maxLatenessMs).toISOString()]);
        }
      }
      else if(['popup','change'].includes(event.kind)&&event.result==='reject'){
        await c.query("UPDATE _club_reminder_grants SET status='revoked' WHERE user_id=$1 AND app_id=$2 AND template_id=$3 AND status='available'",[bound.user_id,appId,event.templateId]);
        await c.query("UPDATE _club_reminder_tasks SET status='cancelled',reason='微信已确认用户拒收',updated_at=$1 WHERE user_id=$2 AND app_id=$3 AND template_id=$4 AND status='waiting_permission'",[now(),bound.user_id,appId,event.templateId]);
      }else if(event.kind==='sent'){
        if(task){requireRule(task.open_id===event.openId&&task.template_id===event.templateId,'微信最终回执与发送任务不符',409);requireRule(['accepted','unknown'].includes(task.status)||task.status===(event.errorCode===0?'delivered':'failed'),'任务最终结果冲突',409);
          await c.query('UPDATE _club_reminder_tasks SET status=$1,reason=$2,updated_at=$3 WHERE id=$4',[event.errorCode===0?'delivered':'failed',event.errorCode===0?'微信确认推送成功，无法确认用户是否阅读':'微信确认推送失败：'+event.errorCode,now(),task.id]);}
      }
      return {recorded:true};
    }),
    enqueue:() => run(async c => {
      const ready=await configuration(c); if(!ready.enabled)return {...ready,created:0}; const config=ready.config, at=now();
      await c.query("UPDATE _club_reminder_tasks t SET status='cancelled',reason='会籍、身份或已批准提醒配置已变化',updated_at=$1 WHERE status='waiting_permission' AND (config_version<>$2 OR NOT EXISTS(SELECT 1 FROM memberships m JOIN users u ON u.id=m.user_id JOIN wechat_identities w ON w.user_id=m.user_id WHERE m.user_id=t.user_id AND m.order_id=t.membership_order_id AND m.expires_at=t.expires_at AND m.expires_at>$1 AND u.role='member' AND w.app_id=t.app_id AND w.open_id=t.open_id))",[at,config.version]);
      const memberships=(await c.query("SELECT m.*,w.open_id FROM memberships m JOIN users u ON u.id=m.user_id JOIN wechat_identities w ON w.user_id=m.user_id WHERE w.app_id=$1 AND u.role='member' AND m.starts_at<=$2 AND m.expires_at>$2",[appId,at])).rows;let created=0;
      for(const member of memberships)for(const days of config.offsetDays){const due=dueAt(member.expires_at,days,config.timeOfDay);if(Date.parse(due)+config.maxLatenessMs<Date.parse(at))continue;
        const result=await c.query("INSERT INTO _club_reminder_tasks(id,user_id,app_id,open_id,template_id,config_version,membership_order_id,expires_at,offset_days,due_at,status,created_at,updated_at) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,'waiting_permission',$11,$11) ON CONFLICT(user_id,app_id,membership_order_id,expires_at,offset_days) DO NOTHING RETURNING id",[randomUUID(),member.user_id,appId,member.open_id,config.template.id,config.version,member.order_id,member.expires_at,days,due,at]);created+=result.rows.length;}
      return {enabled:true,created};
    }),
    recoverUncertain:() => run(async c => {
      const ready=await configuration(c); if(!ready.enabled)return {changed:0};const at=now(),threshold=new Date(Date.parse(at)-ready.config.sendLeaseMs).toISOString();
      const result=await c.query("UPDATE _club_reminder_tasks SET status='unknown',reason='发送进程中断，禁止自动重发',updated_at=$1 WHERE status='transmitting' AND updated_at<$2 RETURNING id",[at,threshold]);return {changed:result.rows.length};
    }),
    async dispatchOne() {
      if(sender?.configured!==true||sender.appId!==appId)return {accepted:false,reason:'可信微信发送渠道未配置'};
      const claimed=await run(async c => {
        const ready=await configuration(c);if(!ready.enabled)return null;const config=ready.config,at=now();
        await c.query("UPDATE _club_reminder_tasks SET status='cancelled',reason='错过已批准提醒时段，未补发',updated_at=$1 WHERE status='waiting_permission' AND due_at<$2",[at,new Date(Date.parse(at)-config.maxLatenessMs).toISOString()]);
        const rows=(await c.query("SELECT * FROM _club_reminder_tasks WHERE status='waiting_permission' AND app_id=$1 AND due_at<=$2 ORDER BY due_at,id LIMIT 30 FOR UPDATE SKIP LOCKED",[appId,at])).rows;
        for(const task of rows){
          const member=await one(c,"SELECT m.* FROM memberships m JOIN users u ON u.id=m.user_id JOIN wechat_identities w ON w.user_id=m.user_id WHERE m.user_id=$1 AND m.order_id=$2 AND m.expires_at=$3 AND m.expires_at>$4 AND u.role='member' AND w.app_id=$5 AND w.open_id=$6",[task.user_id,task.membership_order_id,task.expires_at,at,appId,task.open_id]);
          if(!member||task.config_version!==config.version||task.template_id!==config.template.id){await c.query("UPDATE _club_reminder_tasks SET status='cancelled',reason='会籍或微信身份已变化',updated_at=$1 WHERE id=$2",[at,task.id]);continue;}
          if(await one(c,"SELECT 1 FROM _club_reminder_tasks WHERE app_id=$1 AND open_id=$2 AND template_id=$3 AND status IN ('transmitting','unknown')",[appId,task.open_id,task.template_id]))continue;
          const grant=await one(c,"SELECT * FROM _club_reminder_grants WHERE user_id=$1 AND app_id=$2 AND open_id=$3 AND template_id=$4 AND status='available' ORDER BY created_at,id LIMIT 1 FOR UPDATE",[task.user_id,appId,task.open_id,task.template_id]);if(!grant)continue;
          const payload=outbound(task,config,member);await c.query("UPDATE _club_reminder_grants SET status='reserved',task_id=$1 WHERE id=$2",[task.id,grant.id]);
          await c.query("UPDATE _club_reminder_tasks SET status='transmitting',grant_id=$1,updated_at=$2 WHERE id=$3",[grant.id,at,task.id]);return {task,payload,grant};
        }return null;
      });
      if(!claimed)return {accepted:false};let outcome;try{outcome=await sender.send(claimed.payload);}catch{outcome={outcome:'unknown'};}
      return run(async c => {
        const task=await one(c,'SELECT * FROM _club_reminder_tasks WHERE id=$1 FOR UPDATE',[claimed.task.id]);requireRule(['transmitting','unknown'].includes(task.status),'发送任务已变化，请人工核对',409);
        const verified=outcome?.responseVerified===true, kind=verified&&['accepted','rejected','not_sent'].includes(outcome.outcome)?outcome.outcome:'unknown';
        let status=kind==='accepted'?'accepted':kind==='rejected'?'failed':kind==='not_sent'?'waiting_permission':'unknown';
        const providerId=typeof outcome?.providerMessageId==='string'&&/^\d+$/.test(outcome.providerMessageId)?outcome.providerMessageId:null;
        if(kind==='accepted'&&providerId){
          const finals=(await c.query("SELECT event_json FROM _club_reminder_events WHERE event_json->>'kind'='sent' AND event_json->>'appId'=$1 AND event_json->>'providerMessageId'=$2",[appId,providerId])).rows.map(row=>row.event_json).filter(event=>event.openId===task.open_id&&event.templateId===task.template_id);
          const codes=new Set(finals.map(event=>event.errorCode));if(codes.size===1)status=finals[0].errorCode===0?'delivered':'failed';
        }
        const history=task.attempts_json??[];history.push({at:now(),outcome:kind,...(Number.isSafeInteger(outcome?.errorCode)?{errorCode:outcome.errorCode}:{}),providerMessageId:providerId});
        const reason=status==='delivered'?'微信确认推送成功，无法确认用户是否阅读':status==='failed'?'微信拒绝发送或最终推送失败，需核对后处理':kind==='unknown'?'发送结果未知，禁止自动重发':kind==='accepted'?'微信接口受理，等待可对应的最终推送结果':outcome.reason??'发送前未出站';
        await c.query('UPDATE _club_reminder_tasks SET status=$1,provider_message_id=$2,attempts_json=$3,reason=$4,updated_at=$5 WHERE id=$6',[status,providerId,JSON.stringify(history),reason,now(),task.id]);
        await c.query('UPDATE _club_reminder_grants SET status=$1,task_id=$2 WHERE id=$3',[kind==='accepted'?'consumed':kind==='rejected'?'revoked':kind==='not_sent'?'available':'reserved',kind==='not_sent'?null:task.id,claimed.grant.id]);
        return {accepted:kind==='accepted',status,taskId:task.id};
      });
    }
  };
  return service;
}
