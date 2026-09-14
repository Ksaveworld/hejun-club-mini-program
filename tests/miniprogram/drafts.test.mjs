import test from 'node:test';
import assert from 'node:assert/strict';
import vm from 'node:vm';
import { readFileSync } from 'node:fs';
function setup() {
  const storage = new Map(), module = { exports: {} }; let now = 1000, full = false;
  const wx = { getStorageSync: key => structuredClone(storage.get(key)),
    setStorageSync: (key,value) => { if(full) throw new Error('storage full'); storage.set(key, structuredClone(value)); } };
  vm.runInNewContext(readFileSync(new URL('../../miniprogram/utils/drafts.js', import.meta.url),'utf8'), { module, wx, Date: { now: () => now } });
  return { ...module.exports, storage, advance: n => { now += n; }, fill: () => { full = true; } };
}
test('local drafts isolate member/environment and expire without restoring stale text', () => {
  const e=setup(); assert.equal(e.write('a','owner','form',{title:'草稿'}),true);
  assert.equal(e.read('a','owner','form').title,'草稿'); assert.equal(e.read('b','owner','form'),null); assert.equal(e.read('a','other','form'),null);
  e.advance(24*60*60*1000+1); assert.equal(e.read('a','owner','form'),null);
  e.write('a','other','another',{title:'另一账号'}); assert.equal(e.read('a','owner','form'),null);
});
test('storage failures do not claim a saved draft; retained draft slots are bounded', () => {
  const e=setup(); for(let i=0;i<20;i++){e.advance(1);e.write('a','owner','form'+i,{title:'草稿'});}
  assert.equal(Object.keys(e.storage.get('club-native-drafts:a').entries).length,12);
  e.fill(); assert.equal(e.write('a','owner','new',{title:'未保存'}),false); assert.equal(e.read('a','owner','new'),null);
});
