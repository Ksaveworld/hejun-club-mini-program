import test from 'node:test';
import assert from 'node:assert/strict';
import vm from 'node:vm';
import {readFileSync} from 'node:fs';

const start=Date.parse('2026-10-28T12:00:00.000Z');
const iso=ms=>new Date(ms).toISOString();
const plan=(planId,expires=start+86400000)=>({planId,active:true,startsAt:iso(start-86400000),expiresAt:iso(expires)});
const paid=(planId,expires=start+86400000)=>({...plan(planId,expires),orderId:'SYNTHETIC-PAID-ORDER'});
const session=(display,membership=null,byPlan=display?[display]:[])=>({user:{id:'synthetic-member',role:'member',referralCode:'ABC123'},membership,
  displayMembership:display,effectiveEntitlements:{active:!!display,byPlan,planIds:byPlan.map(p=>p.planId)}});
function harness(kind,initial=session(plan('star'))) {
  let page,now=start,currentSession=initial,has=true,stamp={scope:'SYNTHETIC',authMode:'wechat',expiresAt:iso(start+3600000)},listener;
  const timers=new Map(),calls=[],overrides=new Map();let timerId=0;
  class Clock extends Date {constructor(...args){super(...(args.length?args:[now]));}static now(){return now;}}
  const load=(path,require=()=>({}))=>{const module={exports:{}};vm.runInNewContext(readFileSync(new URL('../../miniprogram/'+path,import.meta.url),'utf8'),{module,require,Date:Clock});return module.exports;};
  const consume=load('utils/consumption-membership.js');
  const plans=[{id:'basic',name:'基础会员'},{id:'star',name:'星级会员'}];
  const journey=load('utils/member-journey.js',()=>({plans}));
  const api={hasSession:()=>has,sessionStamp:()=>stamp,isCurrentSession:value=>value===stamp,newKey:()=> 'SYNTHETIC-NATIVE-KEY',
    clearSession:()=>{has=false;},subscribeSession:fn=>{listener=fn;return()=>{listener=null;}},
    api:async(path,body,key)=>{
      calls.push({path,body,key});if(overrides.has(path))return overrides.get(path)(body,key);
      if(path==='/me')return currentSession;if(path==='/orders')return {orders:[]};if(path==='/profile')return {profile:null};
      if(path==='/feedback/summary')return {unreadCount:0};if(path==='/reminders')return {enabled:false,tasks:[]};if(path==='/posts')return {posts:[]};
      throw Error('Unexpected synthetic request '+path);
    }};
  const require=path=>path.endsWith('/consumption-membership')?consume:path.endsWith('/api')?api:path.endsWith('/content')?{plans}:
    path.endsWith('/member-journey')?journey:path.endsWith('/user-display')?{accountDisplayLabel:u=>u.id}:
    path.endsWith('/profile-avatar')?{saveProfileAvatar:async()=>'',clearProfileAvatar:()=>{}}:
    path.endsWith('/display-time')?{chineseDateTime:v=>v.replace('T',' ')}:path.endsWith('/drafts')?{read:()=>null,write:()=>true}:
    path.endsWith('/navigation')?{returnToPrevious:()=>{}}:{};
  vm.runInNewContext(readFileSync(new URL('../../miniprogram/pages/'+kind+'/index.js',import.meta.url),'utf8'),{
    require,Page:value=>{page=value;},Date:Clock,setTimeout:(fn,ms)=>{const id=++timerId;timers.set(id,{fn,ms});return id;},clearTimeout:id=>timers.delete(id),
    wx:{stopPullDownRefresh(){},navigateTo(){},redirectTo(){},nextTick:fn=>fn(),pageScrollTo(){},showModal(){}}});
  page.data=structuredClone(page.data);page.setData=value=>Object.assign(page.data,value);page.onLoad(kind==='posts'?{mode:'new'}:undefined);
  return {page,calls,timers,consume,overrides,get stamp(){return stamp;},setSession:s=>{currentSession=s;},setNow:value=>{now=value;},
    changeAccount:()=>{stamp={...stamp,scope:'OTHER-SYNTHETIC'};listener?.();},tickTimer:id=>{const timer=timers.get(id);timers.delete(id);timer?.fn();}};
}
const flush=()=>new Promise(resolve=>setImmediate(resolve));

test('consumption uses byPlan arrays, exact expiry and leaves the original paid source untouched',()=>{
  const legacy=paid('basic'),star=plan('star'),s=session(star,legacy,[legacy,star]),h=harness('account',s);
  assert.equal(h.consume.consumptionMembership(s),star);assert.equal(s.membership,legacy);
  assert.equal(h.consume.hasConsumptionPlan(s,'star'),true);assert.equal(h.consume.hasConsumptionPlan(s,'basic'),true);
  h.setNow(Date.parse(star.expiresAt));assert.equal(h.consume.consumptionMembership(s),null);assert.equal(h.consume.hasConsumptionPlan(s,'star'),false);
  assert.equal(h.consume.consumptionMembership({user:s.user,membership:legacy}),legacy);
  assert.equal(h.consume.hasConsumptionPlan({...s,effectiveEntitlements:{byPlan:{star}}},'star'),false);
  assert.equal(h.consume.consumptionMembership({...s,user:{role:'reviewer'}}),null);
});

test('account displays gifted star term without a paid order and clears all entitlement state on hide',async()=>{
  const h=harness('account');await h.page.onShow();
  assert.equal(h.page.data.membership,null);assert.equal(h.page.data.displayMembership.planId,'star');assert.equal(h.page.data.starContact,true);
  assert.equal(h.page.data.membershipLabel,'星级会员');assert.equal(h.page.data.journey.kind,'services');
  assert.ok(h.page.data.expiryLabel);h.page.onHide();
  assert.equal(h.page.data.displayMembership,null);assert.equal(h.page.data.membership,null);assert.equal(h.page.data.starContact,false);
  assert.equal(h.page.data.loggedIn,false);assert.equal(h.timers.size,0);
});

test('account highest displayed tier keeps its own shorter term, while paid source is preserved',async()=>{
  const payment=paid('basic',start+100*86400000),gift=plan('star',start+86400000),h=harness('account',session(gift,payment,[payment,gift]));
  await h.page.onShow();assert.equal(h.page.data.membership.orderId,'SYNTHETIC-PAID-ORDER');assert.equal(h.page.data.membership.expiresAt,payment.expiresAt);
  assert.equal(h.page.data.displayMembership.expiresAt,gift.expiresAt);assert.equal(h.page.data.starContact,true);
  h.changeAccount();assert.equal(h.page.data.user,null);assert.equal(h.page.data.displayMembership,null);
});

test('expired paid source retains its historical expiry label without granting consumption',async()=>{
  const payment={...paid('basic',start-1000),active:false},h=harness('account',session(null,payment));
  await h.page.onShow();assert.equal(h.page.data.membership.orderId,payment.orderId);assert.equal(h.page.data.displayMembership.active,false);
  assert.match(h.page.data.membershipLabel,/到期/);assert.ok(h.page.data.expiryLabel);assert.equal(h.page.data.starContact,false);
  assert.equal(h.page.data.journey.title,'会籍已到期');
});

test('late account response after hide never restores the previous user or entitlement',async()=>{
  const h=harness('account');let finish;h.overrides.set('/me',()=>new Promise(resolve=>{finish=resolve;}));
  const pending=h.page.onShow();h.page.onHide();finish(session(plan('star')));await pending;
  assert.equal(h.page.data.user,null);assert.equal(h.page.data.displayMembership,null);assert.equal(h.page.data.starContact,false);
});

test('expiry while orders are stalled invalidates the old read and refreshes remaining paid access',async()=>{
  const payment=paid('basic',start+86400000),gift=plan('star',start+1000),h=harness('account',session(gift,payment,[payment,gift]));
  let finish,orders=0;h.overrides.set('/orders',()=>++orders===1?new Promise(resolve=>{finish=resolve;}):Promise.resolve({orders:[]}));
  const pending=h.page.onShow();await flush();const expiry=h.page._entitlementExpiryTimer;assert.ok(expiry);
  h.setNow(start+1001);h.setSession(session(payment,payment,[payment]));h.tickTimer(expiry);await flush();
  assert.equal(h.calls.filter(x=>x.path==='/me').length,2,'expiry must initiate a fresh read even when old orders are pending');
  finish({orders:[]});await pending;await flush();
  assert.equal(h.page.data.displayMembership.planId,'basic');assert.equal(h.page.data.starContact,false);
  assert.equal(h.page.data.membershipLabel,'基础会员');assert.equal(h.page.data.journey.title,'基础会员');
});

test('posts accepts gifted consumption, preserves paid source, and clears private content on hide',async()=>{
  const payment=paid('basic'),s=session(plan('star'),payment),h=harness('posts',s);await h.page.onShow();
  assert.equal(h.page.data.canSubmit,true);assert.equal(s.membership,payment);
  h.page._draft={title:'SYNTHETIC title',body:'SYNTHETIC body'};h.page.setData({title:h.page._draft.title,body:h.page._draft.body});
  h.page.onHide();assert.equal(h.page.data.canSubmit,false);assert.equal(h.page.data.title,'');assert.equal(h.page.data.body,'');assert.equal(h.page.data.selectedPost,null);
});

test('posts rechecks grant expiry before submitting, so stale active display never sends a post',async()=>{
  const gift=plan('star',start+1000),s=session(gift),h=harness('posts',s);await h.page.onShow();
  h.page._draft={title:'SYNTHETIC title',body:'SYNTHETIC body'};h.setNow(start+1000);await h.page.submit();
  assert.equal(h.page.data.canSubmit,false);assert.equal(h.calls.filter(x=>x.path==='/posts'&&x.body).length,0);
  assert.equal(s.membership,null);assert.match(h.page.data.error,/会籍/);
});
