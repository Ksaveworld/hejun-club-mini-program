import test from 'node:test';
import assert from 'node:assert/strict';
import { openDatabase, audit } from '../../server/db.mjs';
import { queryAudit } from '../../server/audit-query.mjs';

test('audit query requires admin, uses stable pagination and exact targets, and does not write records', () => {
  const db = openDatabase(':memory:');
  try {
    for (let i=0;i<65;i++) audit(db,null,'article.created','target-a',{revision:1});
    audit(db,null,'order.created','target-b');
    const actor={role:'admin'}, params = value=>new URLSearchParams(value);
    assert.throws(()=>queryAudit(db,{role:'member'},params('')),/管理员/);
    const first=queryAudit(db,actor,params('group=article&target=target-a')); assert.equal(first.records.length,30);
    audit(db,null,'article.updated','target-a',{revision:2});
    const second=queryAudit(db,actor,params('group=article&target=target-a&before='+first.nextCursor));
    const third=queryAudit(db,actor,params('group=article&target=target-a&before='+second.nextCursor));
    assert.equal(new Set([...first.records,...second.records,...third.records].map(r=>r.id)).size,65);assert.equal(third.nextCursor,null);
    assert.equal(queryAudit(db,actor,params('target=target')).records.length,0);
    for(const invalid of ['before=-1','before=1.2','before=9007199254740992','group=arbitrary','target=a&target=b','unknown=x']) assert.throws(()=>queryAudit(db,actor,params(invalid)));
    assert.equal(db.prepare('SELECT count(*) n FROM audit_log').get().n,67);
  } finally {db.close();}
});

test('audit response projects only permitted human-readable fields and tolerates historical broken JSON', () => {
  const db=openDatabase(':memory:');
  try {
    audit(db,null,'application.approve','order',{note:'审核说明',password:'PRIVATE',accessToken:'TOKEN'});
    audit(db,null,'article.publish','article',{revision:3,body:'PRIVATE',access:{secret:'PRIVATE'}});
    db.prepare("INSERT INTO audit_log(action,target_id,detail,created_at) VALUES ('old.action','old','invalid','2026-09-08')").run();
    const result=queryAudit(db,{role:'admin'},new URLSearchParams());
    assert.equal(result.records[0].label,'其他操作'); assert.equal(result.records[1].revision,3); assert.equal(result.records[2].note,'审核说明');
    assert.equal(JSON.stringify(result).includes('PRIVATE'),false); assert.equal(JSON.stringify(result).includes('TOKEN'),false);
  } finally {db.close();}
});
