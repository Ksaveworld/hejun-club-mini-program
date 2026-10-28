import {randomUUID} from 'node:crypto';
import {postgresTransaction,safeInteger} from './postgres.mjs';
import {requireRule,textField,validateKey,digest,nowISO} from './domain.mjs';

export function createPostgresSupport(pool,{schema}={}){
  requireRule(/^club_migration_[a-z0-9_]{1,40}$/.test(schema||''),'需要指定迁移隔离区');
  const run=(fn,write=false)=>postgresTransaction(pool,async c=>{
    if(!write)await c.query('SET TRANSACTION ISOLATION LEVEL REPEATABLE READ READ ONLY');
    await c.query(`SET LOCAL search_path TO "${schema}"`);
    if(write)await c.query('LOCK TABLE users IN SHARE ROW EXCLUSIVE MODE');
    return fn(c);
  });
  const one=async(c,s,a=[])=>(await c.query(s,a)).rows[0];
  const access=(u,admin=false)=>requireRule(u?.role===(admin?'admin':'member'),admin?'需要管理员权限':'请使用会员账号',403);
  const audit=(c,u,action,id,detail)=>c.query('INSERT INTO audit_log(actor_id,action,target_id,detail,created_at) VALUES($1,$2,$3,$4,$5)',[u.id,action,id,JSON.stringify(detail),nowISO()]);
  const cursor=value=>{requireRule(value===undefined||(/^[1-9]\d*$/.test(value)&&Number.isSafeInteger(Number(value))),'翻页位置不正确');return value===undefined?Number.MAX_SAFE_INTEGER:Number(value);};
  const select="SELECT *, (SELECT MAX(seq) FROM feedback_events WHERE ticket_id=feedback_tickets.id AND author_kind='staff') latest_staff_seq FROM feedback_tickets";
  const view=r=>({id:r.id,title:r.title,category:r.category,status:r.status,revision:safeInteger(r.revision),confirmedAt:r.confirmed_at||null,relatedOrderId:r.related_order_id||null,unread:BigInt(r.latest_staff_seq||0)>BigInt(r.member_read_seq),createdAt:r.created_at,updatedAt:r.updated_at});
  async function detail(c,u,id,admin=false){
    access(u,admin);const r=await one(c,select+' WHERE id=$1',[id]);requireRule(r&&(admin||r.user_id===u.id),'反馈记录不存在',404);
    const events=(await c.query('SELECT * FROM feedback_events WHERE ticket_id=$1 ORDER BY seq',[id])).rows.map(e=>({id:safeInteger(e.seq),authorKind:e.author_kind,action:e.action,body:e.body,status:e.status,createdAt:e.created_at}));
    return {...view(r),body:r.body,events};
  }
  async function active(c,u){const r=await one(c,'SELECT * FROM memberships WHERE user_id=$1',[u.id]),now=nowISO();return !!r&&r.starts_at<=now&&r.expires_at>now;}
  const ambassador=r=>r?{id:r.id,contact:r.contact,introduction:r.introduction,status:r.status,staffNote:r.staff_note,createdAt:r.created_at,updatedAt:r.updated_at,revision:safeInteger(r.revision)}:null;
  return {
    detail:(u,id,admin=false)=>run(c=>detail(c,u,id,admin)),
    list:(u,before,admin=false)=>run(async c=>{access(u,admin);const rows=(await c.query(select+` WHERE seq<$1${admin?'':' AND user_id=$2'} ORDER BY seq DESC LIMIT 31`,admin?[cursor(before)]:[cursor(before),u.id])).rows;return {tickets:rows.slice(0,30).map(view),nextCursor:rows.length>30?String(rows[29].seq):null};}),
    summary:u=>run(async c=>{access(u);const r=await one(c,"SELECT COUNT(*) n FROM feedback_tickets t WHERE user_id=$1 AND EXISTS(SELECT 1 FROM feedback_events e WHERE e.ticket_id=t.id AND e.author_kind='staff' AND e.seq>t.member_read_seq)",[u.id]);return {unreadCount:safeInteger(r.n)};}),
    create:(u,input,key)=>run(async c=>{
      access(u);validateKey(key);const title=textField(input.title,'问题标题',60,true),body=textField(input.body,'问题描述',2000,true),category=input.category,relatedOrderId=input.relatedOrderId||null;
      requireRule(['account','order','content','other'].includes(category),'反馈分类不正确');
      if(relatedOrderId)requireRule(typeof relatedOrderId==='string'&&await one(c,'SELECT id FROM orders WHERE id=$1 AND user_id=$2',[relatedOrderId,u.id]),'关联订单不存在',404);
      const hash=digest(JSON.stringify({title,body,category,...(relatedOrderId?{relatedOrderId}:{})}));
      const prior=await one(c,'SELECT id,request_hash FROM feedback_tickets WHERE user_id=$1 AND idempotency_key=$2',[u.id,key]);
      if(prior){requireRule(prior.request_hash===hash,'提交编号已用于其他反馈',409);return detail(c,u,prior.id);}
      const id=randomUUID(),now=nowISO();await c.query("INSERT INTO feedback_tickets(id,user_id,title,body,category,status,revision,created_at,updated_at,idempotency_key,request_hash,related_order_id) VALUES($1,$2,$3,$4,$5,'open',1,$6,$6,$7,$8,$9)",[id,u.id,title,body,category,now,key,hash,relatedOrderId]);
      await audit(c,u,'feedback.created',id,{category});return detail(c,u,id);
    },true),
    read:(u,id,input)=>run(async c=>{
      await detail(c,u,id);requireRule(Number.isSafeInteger(input.eventId)&&input.eventId>=0,'阅读位置不正确');
      if(input.eventId)requireRule(await one(c,'SELECT seq FROM feedback_events WHERE ticket_id=$1 AND seq=$2',[id,input.eventId]),'阅读位置不正确');
      await c.query('UPDATE feedback_tickets SET member_read_seq=GREATEST(member_read_seq,$1) WHERE id=$2 AND user_id=$3',[input.eventId,id,u.id]);return {ok:true};
    },true),
    action:(u,id,action,input,key,admin=false)=>run(async c=>{
      access(u,admin);validateKey(key);requireRule((admin?['accept','reply']:['followup','confirm']).includes(action),'反馈操作不正确');
      const body=action==='accept'?'':action==='confirm'?'我确认问题已解决。':textField(input.body,admin?'回复内容':'补充说明',2000,true);
      const status=admin?(action==='accept'?'processing':input.status):(action==='confirm'?'resolved':'processing');
      requireRule(['processing','resolved'].includes(status),'反馈状态不正确');requireRule(Number.isSafeInteger(input.revision)&&input.revision>0,'反馈版本不正确');
      const hash=digest(JSON.stringify({id,action,body,...(admin?{status}:{}),revision:input.revision}));
      const prior=await one(c,'SELECT ticket_id,request_hash FROM feedback_events WHERE actor_id=$1 AND idempotency_key=$2',[u.id,key]);
      if(prior){requireRule(prior.request_hash===hash,'操作编号已用于其他内容',409);return detail(c,u,prior.ticket_id,admin);}
      const ticket=await detail(c,u,id,admin);requireRule(ticket.revision===input.revision,'反馈已有新处理，请刷新后核对',409);
      requireRule(admin?(ticket.status!=='resolved'&&(action!=='accept'||ticket.status==='open')):(!ticket.confirmedAt&&(action!=='confirm'||ticket.status==='resolved')),'当前状态不能执行此操作',409);
      const now=nowISO();await c.query('INSERT INTO feedback_events(ticket_id,actor_id,action,body,status,created_at,idempotency_key,request_hash,author_kind) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9)',[id,u.id,admin?action:'reply',body,status,now,key,hash,admin?'staff':'member_'+action]);
      await c.query('UPDATE feedback_tickets SET status=$1,revision=revision+1,updated_at=$2,confirmed_at=$3 WHERE id=$4',[status,now,action==='confirm'?now:null,id]);
      await audit(c,u,'feedback.'+action,id,{status,revision:ticket.revision+1});return detail(c,u,id,admin);
    },true),
    ambassador:u=>run(async c=>{access(u);return {canApply:await active(c,u),application:ambassador(await one(c,'SELECT * FROM ambassador_applications WHERE user_id=$1',[u.id]))};}),
    applyAmbassador:(u,input,key)=>run(async c=>{
      access(u);validateKey(key);requireRule(input.consent===true,'请同意保存申请信息以便联系');const contact=textField(input.contact,'联系微信或电话',100,true),introduction=textField(input.introduction??'','推荐意向',500),hash=digest(JSON.stringify({contact,introduction}));
      const prior=await one(c,'SELECT * FROM ambassador_applications WHERE user_id=$1',[u.id]);if(prior){requireRule(prior.request_hash===hash,'已有申请，请查看办理进度',409);return ambassador(prior);}
      requireRule(await active(c,u),'有效付费会员可以申请推荐大使',403);const id=randomUUID(),now=nowISO();
      const r=await one(c,"INSERT INTO ambassador_applications(id,user_id,contact,introduction,status,created_at,updated_at,idempotency_key,request_hash) VALUES($1,$2,$3,$4,'pending',$5,$5,$6,$7) RETURNING *",[id,u.id,contact,introduction,now,key,hash]);await audit(c,u,'ambassador.applied',id,{policy:'application-only-v1'});return ambassador(r);
    },true),
    listAmbassadors:(u,before)=>run(async c=>{access(u,true);const rows=(await c.query('SELECT * FROM ambassador_applications WHERE seq<$1 ORDER BY seq DESC LIMIT 100',[cursor(before)])).rows;return {applications:rows.map(r=>({...ambassador(r),userId:r.user_id})),next:rows.length===100?safeInteger(rows.at(-1).seq):null};}),
    followAmbassador:(u,id,input)=>run(async c=>{
      access(u,true);const note=textField(input.note,'跟进说明',500,true);requireRule(Number.isSafeInteger(input.revision),'缺少记录版本');
      const row=await one(c,'SELECT * FROM ambassador_applications WHERE id=$1',[id]);requireRule(row,'申请不存在',404);const rev=safeInteger(row.revision);
      if(row.status==='contacted'&&row.staff_note===note&&rev===input.revision+1)return ambassador(row);
      requireRule(rev===input.revision,'记录已变化，请刷新后重试',409);
      const r=await one(c,"UPDATE ambassador_applications SET status='contacted',staff_note=$1,revision=revision+1,updated_at=$2 WHERE id=$3 RETURNING *",[note,nowISO(),id]);await audit(c,u,'ambassador.contacted',id,{note});return ambassador(r);
    },true)
  };
}
