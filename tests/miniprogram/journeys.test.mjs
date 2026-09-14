import test from 'node:test';
import assert from 'node:assert/strict';
import vm from 'node:vm';
import {readFileSync} from 'node:fs';
function moduleFile(file,require){const module={exports:{}};vm.runInNewContext(readFileSync(new URL('../../miniprogram/'+file,import.meta.url),'utf8'),{module,require});return module.exports;}
const content=moduleFile('data/content.js');const {memberJourney}=moduleFile('utils/member-journey.js',()=>content);
function page(name,client={}){
 let def;const routes=[],wx={navigateTo:o=>routes.push(['push',o.url]),redirectTo:o=>routes.push(['replace',o.url]),switchTab:o=>routes.push(['tab',o.url]),navigateBack:o=>routes.push(['back',o.delta]),stopPullDownRefresh(){}};
 vm.runInNewContext(readFileSync(new URL('../../miniprogram/pages/'+name+'/index.js',import.meta.url),'utf8'),{Page:d=>{def=d;},wx,getCurrentPages:()=>[{},{}],getApp:()=>({globalData:{}}),require:p=>p.includes('utils/navigation')?{returnToPrevious:()=>routes.push(['back',1])}:p.includes('member-journey')?{memberJourney}:p.includes('utils/api')?client:content});
 const instance={...def,data:structuredClone(def.data),setData(p){Object.assign(this.data,p);}};return {instance,routes,wx};
}
test('current journey distinguishes unpaid, review, rejected, active, expired and selects a live order ahead of history',()=>{
 assert.equal(memberJourney(null,[]).kind,'members');
 for(const status of ['review','pending','rejected']){const state=memberJourney(null,[{id:'live',status,createdAt:'2026-01-01'},{id:'cancelled',status:'cancelled',createdAt:'2026-02-01'}]);assert.equal(state.id,'live');assert.equal(state.kind,'order');}
 assert.equal(memberJourney({active:true,planId:'basic'},[]).kind,'services');assert.match(memberJourney({active:false},[]).title,/到期/);
});
test('plan selection authenticates before the form and continues the selected plan; ordinary login returns to its caller',()=>{
 const client={hasSession:()=>false,captureReferral(){},api:async()=>({nativeAuth:{}})};
 const {instance:members,routes}=page('members',client);members.openPlan({currentTarget:{dataset:{planId:'organization'}}});assert.equal(routes[0][1],'/pages/login/index?planId=organization');
 const login=page('login',client);login.instance.onLoad({planId:'organization'});login.instance.finishLogin();assert.equal(login.routes[0][1],'/pages/join/index?planId=organization');
 const ordinary=page('login',client);ordinary.instance.onLoad({planId:'https://untrusted'});ordinary.instance.finishLogin();assert.equal(ordinary.routes[0][0],'back');
});
test('order list opens a distinct navigation entry and detail reloads the same identifier',async()=>{
 const calls=[],order={id:'abc',planId:'basic',status:'review',amountCents:36500,form:{}};
 const client={hasSession:()=>true,sessionStamp:()=>({version:1}),isCurrentSession:()=>true,money:x=>String(x/100),statusLabels:{review:'待审核'},api:async path=>{calls.push(path);return path==='/orders'?{orders:[order]}:{order};}};
 const list=page('orders',client);list.instance.onLoad({});await list.instance.refreshOrders();list.instance.openOrder({currentTarget:{dataset:{orderId:'abc'}}});assert.equal(list.routes[0][1],'/pages/orders/index?id=abc');assert.equal(list.instance.data.selectedOrder,null);
 const detail=page('orders',client);detail.instance.onLoad({id:'abc'});await detail.instance.refreshOrders();assert.equal(detail.instance.data.detailMode,true);assert.equal(detail.instance.data.selectedOrder.id,'abc');assert.equal(detail.instance.data.moreOpen,false);
 await detail.instance.refreshOrders();assert.equal(detail.instance.data.selectedOrder.id,'abc');detail.instance.backToRecords();assert.equal(detail.routes[0][0],'back');
});
test('home knowledge shortcut opens the correct category; article detail reads the deep link without loading a mixed list',async()=>{
 const home=page('home');home.instance.openServices({currentTarget:{dataset:{serviceId:'knowledge'}}});assert.equal(home.routes[0][1],'/pages/articles/index?category=knowledge');
 home.instance.openServices({currentTarget:{dataset:{serviceId:'activities'}}});assert.equal(home.routes[1][1],'/pages/activities/index');
 home.instance.openArticles();assert.equal(home.routes[2][1],'/pages/articles/index');
 const calls=[],client={hasSession:()=>false,sessionStamp:()=>({}),isCurrentSession:()=>true,api:async path=>{calls.push(path);return {article:{id:'article-id',body:'可阅读正文'}};}};
 const reader=page('articles',client);reader.instance.onLoad({id:'article-id'});await reader.instance.refresh();assert.deepEqual(calls,['/articles/article-id']);assert.equal(reader.instance.data.selected.body,'可阅读正文');
 reader.instance.onHide();assert.equal(reader.instance.data.selected,null);await reader.instance.onShow();assert.equal(reader.instance.data.selected.body,'可阅读正文');
});

test('successful login with a failed transition offers a retry without a second authentication request',async()=>{
 const e=page('login',{captureReferral(){},api:async()=>({nativeAuth:{}})});e.instance.onLoad({planId:'basic'});
 let attempts=0;e.wx.redirectTo=options=>{attempts++;if(attempts===1)options.fail({errMsg:'timeout'});else options.success();};
 assert.equal(await e.instance.finishLogin(),false);assert.equal(e.instance.data.returnReady,true);assert.equal(e.instance.data.navigationBusy,false);
 assert.equal(await e.instance.finishLogin(),true);assert.equal(attempts,2);assert.equal(e.instance._planId,'basic');
});

test('back navigation retries one timeout on the same page, never redirects an existing history or a changed page',()=>{
 const module={exports:{}},origin={},previous={};let stack=[previous,origin],attempts=0,redirects=0;
 const page={data:{},setData(p){Object.assign(this.data,p);}};
 const wx={navigateBack(options){attempts++;if(attempts===1)options.fail({errMsg:'navigateBack:fail timeout'});else options.success();},redirectTo(){redirects++;}};
 vm.runInNewContext(readFileSync(new URL('../../miniprogram/utils/navigation.js',import.meta.url),'utf8'),{module,wx,getCurrentPages:()=>stack});
 module.exports.returnToPrevious(page,'/fallback');assert.equal(attempts,2);assert.equal(redirects,0);assert.equal(page._navigationPending,false);
 wx.navigateBack=options=>{attempts++;stack=[previous];options.fail({errMsg:'timeout'});};const before=attempts;module.exports.returnToPrevious(page,'/fallback');assert.equal(attempts,before+1);assert.equal(redirects,0);
});


test('home reads published content and actual member progress; hiding or changing identity discards stale content',async()=>{
 let version=1;let late;let slow=false;
 const client={captureReferral(){},hasSession:()=>true,sessionStamp:()=>({version}),isCurrentSession:s=>s.version===version,
   api:async path=>path==='/articles'?(slow?await new Promise(resolve=>{late=resolve;}):{articles:[{id:'published',title:'真实发布标题',category:'news'}]}):path==='/me'?{user:{id:'a',role:'member'},membership:null}:{orders:[{id:'order-a',status:'review'}]}};
 const e=page('home',client);e.instance.onLoad({});await e.instance.onShow();assert.equal(e.instance.data.articles[0].id,'published');assert.equal(e.instance.data.journey.id,'order-a');
 e.instance.openArticle({currentTarget:{dataset:{id:'published'}}});assert.equal(e.routes[0][1],'/pages/articles/index?id=published');
 version++;e.instance.openArticle({currentTarget:{dataset:{id:'published'}}});assert.equal(e.routes.length,1);assert.equal(e.instance.data.articles.length,0);
 slow=true;
 const pending=e.instance.onShow();e.instance.onHide();late({articles:[{id:'late-private'}]});await pending;assert.equal(e.instance.data.articles.length,0);assert.equal(e.instance.data.journey,null);
});

test('service discovery routes every displayed action to a working content or record page',()=>{
 const e=page('services',{hasSession:()=>false});
 assert.deepEqual(Array.from(e.instance.data.filteredServices,item=>item.id),['knowledge','activities','insights','posts','feedback']);
 for(const entry of e.instance.data.filteredServices)e.instance.openService({currentTarget:{dataset:{serviceId:entry.id}}});
 assert.equal(e.routes.length,5);assert.ok(e.routes.every(route=>!route[1].includes('service-detail')));assert.ok(e.routes.some(route=>route[1]==='/pages/activities/index'));
 e.instance.search({detail:{value:'帮助'}});assert.equal(e.instance.data.filteredServices[0].id,'feedback');
});
