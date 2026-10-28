import test from 'node:test';
import assert from 'node:assert/strict';
import vm from 'node:vm';
import {readFileSync} from 'node:fs';
function common(name){const module={exports:{}};vm.runInNewContext(readFileSync(new URL('../../miniprogram/utils/'+name+'.js',import.meta.url),'utf8'),{module});return module.exports;}
const display=common('article-display'),official=common('official-article');
function harness(){let page,version=1;const opened=[],copied=[];let modal;
 const helpers={hasSession:()=>true,isCurrentSession:s=>s===version};
 const wx={openOfficialAccountArticle:o=>opened.push(o),showModal:o=>{modal=o;},setClipboardData:o=>copied.push(o)};
 vm.runInNewContext(readFileSync(new URL('../../miniprogram/pages/articles/index.js',import.meta.url),'utf8'),{require:p=>p.endsWith('article-display')?display:p.endsWith('official-article')?official:p.endsWith('landing-support')?[]:helpers,Page:p=>page=p,wx});
 page.data=structuredClone(page.data);page.setData=v=>Object.assign(page.data,v);page._stamp=1;page._request=1;
 return {page,opened,copied,wx,get modal(){return modal;},expire(){version++;}};
}
test('info/activity/both and legacy placement filter real article list',()=>{
 const {page}=harness();page.data.ready=true;
 page.data.articles=['info','activity','both','legacy-info','legacy-both'].map(id=>({id,title:id,summary:''}));
 page.data.placements={info:{displayScope:'info'},activity:{displayScope:'activity',activityGroup:'salon'},both:{displayScope:'both',activityGroup:'expo'},'legacy-both':{activityGroup:'online'}};
 page.filter();assert.deepEqual(Array.from(page.data.filtered,a=>a.id),['info','both','legacy-info','legacy-both']);
 for(const [id,m] of Object.entries(page.data.placements))assert.equal(display.showsActivity(m),['activity','both','legacy-both'].includes(id));
});
test('original button opens exact safe URL, fallback copy is explicit and expires with session',()=>{
 const h=harness(),p=h.page,url='https://mp.weixin.qq.com/s/test_article';p.data.ready=true;p.data.selected={id:'a',originalUrl:url};
 p.readOfficial();assert.equal(h.opened.length,1);assert.equal(h.opened[0].url,url);h.opened[0].fail();assert.equal(p.data.officialError,true);
 p.copyOfficial();assert.equal(h.copied.length,0);h.modal.success({confirm:true});assert.equal(h.copied[0].data,url);
 p.copyOfficial();h.expire();h.modal.success({confirm:true});assert.equal(h.copied.length,1);p.readOfficial();assert.equal(h.opened.length,1);
});
test('PDF, hidden page and invalid URL cannot open original',()=>{
 const h=harness(),p=h.page;p.data.ready=true;p.data.selected={id:'a',originalUrl:'https://mp.weixin.qq.com/s/test_article',document:{}};
 p.readOfficial();assert.equal(h.opened.length,0);p.data.selected.document=null;p.data.selected.originalUrl='https://example.com/';p.readOfficial();assert.equal(h.opened.length,0);
 p.data.selected.originalUrl='https://mp.weixin.qq.com/s/test_article';p.onHide();p.readOfficial();assert.equal(h.opened.length,0);
});
test('managed info-only URL suppresses legacy static activity card; all three scopes render correctly',async()=>{
 let page;const url='https://mp.weixin.qq.com/s/fixture',articles=['info','activity','both'].map(id=>({id,title:id,summary:''})),topics=articles.map(a=>({articleId:a.id,displayScope:a.id,activityGroup:a.id==='info'?'':'salon',originalUrl:url}));
 const helpers={api:async p=>p==='/content-topics'?{topics}:{articles},sessionStamp:()=>1,isCurrentSession:()=>true,hasSession:()=>true,readArticleCatalog:async()=>({articles})};
 vm.runInNewContext(readFileSync(new URL('../../miniprogram/pages/activities/index.js',import.meta.url),'utf8'),{require:p=>p.endsWith('article-display')?display:p.endsWith('official-article')?official:p.endsWith('activity-originals')?[{id:'static',url,group:'salon',title:'legacy',summary:''}]:p.endsWith('activity-recaps')?{}:helpers,Page:p=>page=p,wx:{},setTimeout,clearTimeout});
 page.data=structuredClone(page.data);page.setData=v=>Object.assign(page.data,v);page._request=1;page._shown=true;await page.loadRecaps(1);
 assert.deepEqual(Array.from(page.data.officialFiltered,a=>a.id),['activity','both']);
 topics.splice(1);articles.splice(1);await page.loadRecaps(1);assert.equal(page.data.officialFiltered.length,0);
});
