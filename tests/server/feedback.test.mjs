import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { openDatabase } from '../../server/db.mjs';
import { insertUser, createOrder } from '../../server/domain.mjs';
import { createFeedback, listFeedback, feedbackDetail, handleFeedback, memberFeedbackAction, markFeedbackRead, feedbackSummary } from '../../server/feedback.mjs';
import { createBackup, verifyBackup, inspectDatabase } from '../../scripts/backup.mjs';
const input={title:'隔离反馈',body:'仅本人和后台可见的问题描述',category:'order'};
function setup(t){const db=openDatabase(':memory:');t.after(()=>db.close());return {db,user:insertUser(db,'feedback_user','unused'),other:insertUser(db,'feedback_other','unused'),admin:insertUser(db,'feedback_admin','unused','admin')};}
test('unpaid users submit privately, same key returns one ticket, other users cannot read or handle it',t=>{
  const e=setup(t),key=randomUUID(),ticket=createFeedback(e.db,e.user,input,key);
  assert.equal(createFeedback(e.db,e.user,input,key).id,ticket.id);
  assert.throws(()=>createFeedback(e.db,e.user,{...input,body:'changed'},key),/提交编号/);
  assert.deepEqual(listFeedback(e.db,e.other).tickets,[]);
  assert.throws(()=>feedbackDetail(e.db,e.other,ticket.id),/不存在/);
  assert.throws(()=>handleFeedback(e.db,e.user,ticket.id,'accept',{revision:1},randomUUID()),/管理员/);
  assert.throws(()=>createFeedback(e.db,e.admin,input,randomUUID()),/会员账号/);
  assert.equal(listFeedback(e.db,e.user).tickets[0].body,undefined);
  assert.equal(feedbackDetail(e.db,e.user,ticket.id).body,input.body);
  assert.equal(e.db.prepare('SELECT count(*) n FROM memberships').get().n,0);
});
test('accept and replies are append-only, idempotent and revision-checked, with a terminal resolved state',t=>{
  const e=setup(t),ticket=createFeedback(e.db,e.user,input,randomUUID()),acceptKey=randomUUID();
  const accepted=handleFeedback(e.db,e.admin,ticket.id,'accept',{revision:1},acceptKey);
  assert.equal(accepted.status,'processing');assert.equal(accepted.events.length,1);
  assert.equal(handleFeedback(e.db,e.admin,ticket.id,'accept',{revision:1},acceptKey).events.length,1);
  assert.throws(()=>handleFeedback(e.db,e.admin,ticket.id,'reply',{revision:1,body:'旧版本',status:'resolved'},randomUUID()),/新处理/);
  assert.throws(()=>handleFeedback(e.db,e.admin,ticket.id,'reply',{revision:2,body:' ',status:'resolved'},randomUUID()));
  handleFeedback(e.db,e.admin,ticket.id,'reply',{revision:2,body:'正在核实',status:'processing'},randomUUID());
  const key=randomUUID(),payload={revision:3,body:'已处理，请刷新查看',status:'resolved'};
  const finished=handleFeedback(e.db,e.admin,ticket.id,'reply',payload,key);
  assert.deepEqual(finished.events.map(x=>x.body),['','正在核实','已处理，请刷新查看']);
  assert.equal(handleFeedback(e.db,e.admin,ticket.id,'reply',payload,key).events.length,3);
  assert.throws(()=>handleFeedback(e.db,e.admin,ticket.id,'reply',{...payload,revision:4},randomUUID()),/当前状态/);
  assert.equal(feedbackDetail(e.db,e.user,ticket.id).status,'resolved');
  const log=JSON.stringify(e.db.prepare('SELECT detail FROM audit_log').all());assert.equal(log.includes(input.body),false);assert.equal(log.includes(payload.body),false);
});
test('feedback pagination stays within the owner and invalid inputs cannot create records',t=>{
  const e=setup(t);for(let i=0;i<35;i++)createFeedback(e.db,e.user,{...input,title:'问题'+i},randomUUID());
  createFeedback(e.db,e.other,input,randomUUID());const first=listFeedback(e.db,e.user),second=listFeedback(e.db,e.user,false,first.nextCursor);
  assert.equal(first.tickets.length,30);assert.equal(second.tickets.length,5);assert.equal(second.nextCursor,null);
  assert.equal(new Set([...first.tickets,...second.tickets].map(x=>x.id)).size,35);
  for(const before of ['0','-1','1.5','9007199254740992'])assert.throws(()=>listFeedback(e.db,e.user,false,before));
  for(const data of [{...input,title:''},{...input,body:'x'.repeat(2001)},{...input,category:'invalid'}])assert.throws(()=>createFeedback(e.db,e.user,data,randomUUID()));
});
test('v2 migration preserves old data and backup/restore includes feedback and all reply events',t=>{
  const prefix=join(tmpdir(),'club-feedback-'),root=mkdtempSync(prefix);assert.ok(root.startsWith(prefix));t.after(()=>rmSync(root,{recursive:true,force:true}));
  const path=join(root,'old.sqlite');let db=openDatabase(path);const user=insertUser(db,'old_user','unused'),admin=insertUser(db,'old_admin','unused','admin');
  db.exec('DROP TABLE feedback_events; DROP TABLE feedback_tickets; DELETE FROM schema_version WHERE version>=3');db.close();
  assert.equal(inspectDatabase(path).counts.feedback_tickets,undefined);db=openDatabase(path);
  assert.equal(db.prepare('SELECT count(*) n FROM users').get().n,2);
  const ticket=createFeedback(db,user,input,randomUUID());handleFeedback(db,admin,ticket.id,'reply',{revision:1,body:'保留的回复',status:'resolved'},randomUUID());db.close();
  const backup=createBackup({sourcePath:path,outputRoot:join(root,'backup')});assert.equal(backup.counts.feedback_events,1);
  assert.equal(verifyBackup({backupPath:backup.backupPath,restoreRoot:join(root,'restore')}).contentDigest,backup.contentDigest);
  db=openDatabase(path);db.exec('DROP TABLE feedback_events');db.close();assert.throws(()=>inspectDatabase(path),/反馈数据表缺失/);
});

test('member follows up on a staff result, sees real unread state and confirms resolution without overwriting history',t=>{
 const e=setup(t);let ticket=createFeedback(e.db,e.user,input,randomUUID());
 ticket=handleFeedback(e.db,e.admin,ticket.id,'reply',{revision:ticket.revision,body:'请核对结果',status:'resolved'},randomUUID());
 assert.equal(feedbackSummary(e.db,e.user).unreadCount,1);assert.equal(feedbackSummary(e.db,e.other).unreadCount,0);
 assert.throws(()=>markFeedbackRead(e.db,e.other,ticket.id,{eventId:ticket.events[0].id}),/不存在/);
 markFeedbackRead(e.db,e.user,ticket.id,{eventId:ticket.events[0].id});assert.equal(feedbackSummary(e.db,e.user).unreadCount,0);
 const key=randomUUID(),payload={revision:ticket.revision,body:'仍有问题，请继续核对'};
 ticket=memberFeedbackAction(e.db,e.user,ticket.id,'followup',payload,key);const retry=memberFeedbackAction(e.db,e.user,ticket.id,'followup',payload,key);
 assert.equal(ticket.status,'processing');assert.equal(retry.events.length,2);assert.equal(ticket.events[1].authorKind,'member_followup');
 assert.throws(()=>memberFeedbackAction(e.db,e.other,ticket.id,'followup',{revision:ticket.revision,body:'越权'},randomUUID()),/不存在/);
 ticket=handleFeedback(e.db,e.admin,ticket.id,'reply',{revision:ticket.revision,body:'已再次核实',status:'resolved'},randomUUID());
 const confirmKey=randomUUID(),confirm={revision:ticket.revision};ticket=memberFeedbackAction(e.db,e.user,ticket.id,'confirm',confirm,confirmKey);
 assert.ok(ticket.confirmedAt);assert.equal(ticket.events.length,4);assert.equal(memberFeedbackAction(e.db,e.user,ticket.id,'confirm',confirm,confirmKey).events.length,4);
 assert.throws(()=>memberFeedbackAction(e.db,e.user,ticket.id,'followup',{revision:ticket.revision,body:'再次补充'},randomUUID()),/当前状态/);
 assert.throws(()=>markFeedbackRead(e.db,e.user,ticket.id,{eventId:99999}),/阅读位置/);
 assert.equal(e.db.prepare("SELECT detail FROM audit_log WHERE action='feedback.followup'").get().detail.includes('仍有问题'),false);
});
test('v3 upgrade preserves existing ticket and staff events and makes them readable without modifying history',t=>{
 const prefix=join(tmpdir(),'club-feedback-upgrade-'),root=mkdtempSync(prefix);assert.ok(root.startsWith(prefix));t.after(()=>rmSync(root,{recursive:true,force:true}));
 const path=join(root,'club.sqlite');let db=openDatabase(path);const user=insertUser(db,'old_member','unused'),admin=insertUser(db,'old_admin','unused','admin');
 let ticket=createFeedback(db,user,input,randomUUID());ticket=handleFeedback(db,admin,ticket.id,'reply',{revision:1,body:'旧回复',status:'resolved'},randomUUID());
 db.exec('ALTER TABLE feedback_events DROP COLUMN author_kind; ALTER TABLE feedback_tickets DROP COLUMN member_read_seq; ALTER TABLE feedback_tickets DROP COLUMN confirmed_at; ALTER TABLE feedback_tickets DROP COLUMN related_order_id; DELETE FROM schema_version WHERE version=4');
 const old=db.prepare('SELECT * FROM feedback_tickets').get();db.close();db=openDatabase(path);
 const row=db.prepare('SELECT * FROM feedback_tickets').get();for(const [field,value]of Object.entries(old))assert.equal(row[field],value);
 assert.equal(feedbackDetail(db,user,ticket.id).events[0].body,'旧回复');assert.equal(feedbackSummary(db,user).unreadCount,1);db.close();
 const backup=createBackup({sourcePath:path,outputRoot:join(root,'backup')});const restored=verifyBackup({backupPath:backup.backupPath,restoreRoot:join(root,'restore')});assert.equal(backup.contentDigest,restored.contentDigest);
});

test('feedback can reference only the submitting member own order and retries preserve that reference',t=>{
 const e=setup(t);const order=createOrder(e.db,e.user.id,{planId:'basic',consent:true,form:{name:'隔离',phone:'13800000000',city:'测试'}},randomUUID());
 const key=randomUUID(),payload={...input,relatedOrderId:order.id};const ticket=createFeedback(e.db,e.user,payload,key);assert.equal(ticket.relatedOrderId,order.id);assert.equal(createFeedback(e.db,e.user,payload,key).id,ticket.id);
 assert.throws(()=>createFeedback(e.db,e.other,payload,randomUUID()),/关联订单不存在/);assert.throws(()=>createFeedback(e.db,e.user,input,key),/提交编号/);
});
