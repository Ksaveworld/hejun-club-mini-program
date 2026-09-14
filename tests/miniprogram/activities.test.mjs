import test from 'node:test';
import assert from 'node:assert/strict';
import vm from 'node:vm';
import {readFileSync} from 'node:fs';
test('activity page formats Beijing time, searches, opens details and clears stale responses',async()=>{
 const item={id:'12345678-1234-1234-1234-123456789abc',title:'隔离活动',summary:'讲座',location:'北京',organizer:'隔离主办方',body:'第一段\n第二段',mode:'offline',startAt:'2099-01-01T01:00:00Z',endAt:'2099-01-01T03:00:00Z'};let response={activities:[item]},definition,route='',late;
 const api=()=>response==='late'?new Promise(r=>{late=r;}):response instanceof Error?Promise.reject(response):Promise.resolve(response);
 vm.runInNewContext(readFileSync(new URL('../../miniprogram/pages/activities/index.js',import.meta.url),'utf8'),{Page:value=>{definition=value;},require:path=>path.endsWith('/api')?{api}:{returnToPrevious(){}},wx:{navigateTo:o=>{route=o.url;},stopPullDownRefresh(){}},Date,Promise,encodeURIComponent});
 const page={...definition,data:structuredClone(definition.data),setData(patch){Object.assign(this.data,patch);}};page.onLoad();await page.onShow();assert.equal(page.data.items[0].time,'2099-01-01 09:00 至 2099-01-01 11:00');assert.equal(page.data.items[0].phase,'即将开始');
 page.search({detail:{value:'不存在'}});assert.equal(page.data.filtered.length,0);page.search({detail:{value:'北京'}});assert.equal(page.data.filtered.length,1);page.open({currentTarget:{dataset:{id:item.id}}});assert.equal(route,'/pages/activities/index?id='+item.id);
 response='late';const pending=page.refresh();page.onHide();late({activities:[item]});await pending;assert.equal(page.data.items.length,0);assert.equal(page.data.ready,false);
 page.onLoad({id:item.id});response={activity:item};await page.onShow();assert.equal(page.data.selected.body,item.body);response=new Error('活动不存在或已撤下');await page.refresh();assert.equal(page.data.selected,null);assert.match(page.data.error,/已撤下/);
});
