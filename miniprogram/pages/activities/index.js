const officialActivities=require('../../data/activity-originals');
const {openOfficialArticle}=require('../../utils/official-article');
const {api,downloadActivityPoster,removeReportFile}=require('../../utils/api');
const {showsActivity}=require('../../utils/article-display');
const {readArticleCatalog}=require('../../utils/article-catalog');
const recapGroups=require('../../data/activity-recaps');
const {sessionStamp,isCurrentSession,hasSession}=require('../../utils/api');
const {returnToPrevious}=require('../../utils/navigation');
function decorate(item){
 const format=value=>{const time=Date.parse(value);if(!Number.isFinite(time))return '时间待确认';const d=new Date(time+8*3600000);return d.toISOString().slice(0,16).replace('T',' ');};
 return {...item,posterSource:'',time:format(item.startAt)+' 至 '+format(item.endAt),phase:Date.parse(item.endAt)<Date.now()?'已结束':Date.parse(item.startAt)>Date.now()?'即将开始':'进行中'};
}
const groups=[{id:'salon',title:'行业沙龙',description:'查看行业分享与交流活动。'},{id:'expo',title:'热门展会',description:'查看展会信息与活动安排。'},{id:'online',title:'线上活动',description:'查看线上分享与参与说明。'}];
function groupOf(item){
 if(item.mode==='online')return 'online';
 if(/展会|博览会|展览会|交易会/.test(item.title||''))return 'expo';
 if(/沙龙|分享|交流|论坛|路演|研讨/.test(item.title||''))return 'salon';
 return '';
}
function readActivities(path){
 return new Promise((resolve,reject)=>{const timer=setTimeout(()=>reject(new Error('活动读取超时，请检查网络后点击重新读取。')),12000);
  Promise.resolve().then(()=>api(path)).then(value=>{clearTimeout(timer);resolve(value);},error=>{clearTimeout(timer);reject(error);});});
}
Page({
 data:{managedOfficialUrls:[],dynamicOfficials:[],officialFiltered:[],officialErrorId:'',campaign:null,id:'',items:[],filtered:[],unclassified:[],recaps:[],filteredRecaps:[],recapsLoading:false,recapsReady:false,recapsError:'',groups,group:'',groupTitle:'',selected:null,query:'',ready:false,loading:false,error:'',posterLoading:false,posterError:''},
 onLoad(options={}){const group=groups.find(g=>g.id===options.group);this.setData({id:options.id||'',group:group?group.id:'',groupTitle:group?group.title:''});this.filter();},
 onShow(){this._shown=true;const request=this._campaignRequest=(this._campaignRequest||0)+1;api('/campaign').then(r=>{if(this._shown&&!this._unloaded&&request===this._campaignRequest)this.setData({campaign:r.campaign?.active?r.campaign:null});}).catch(()=>{});return this.refresh();},
 onHide(){this._shown=false;this._campaignRequest=(this._campaignRequest||0)+1;this._request=(this._request||0)+1;this.setData({managedOfficialUrls:[],dynamicOfficials:[],officialFiltered:[],officialErrorId:'',campaign:null,items:[],filtered:[],unclassified:[],recaps:[],filteredRecaps:[],recapsLoading:false,recapsReady:false,recapsError:'',selected:null,ready:false,loading:false,posterLoading:false,posterError:''});},
 onUnload(){this._unloaded=true;this.onHide();this.releasePoster();},
 openCampaign(){wx.navigateTo({url:'/pages/surveys/index'});},
 onShareAppMessage(){const item=this.data.ready&&!this.data.loading&&this.data.selected;return item&&/^[a-f0-9-]+$/.test(item.id)?{title:item.title,path:'/pages/activities/index?id='+encodeURIComponent(item.id)}:{title:'跨境企业家俱乐部 · 活动安排',path:'/pages/activities/index'};},
 previewPoster(){if(this.data.ready&&this.data.selected?.posterSource)wx.previewImage({current:this.data.selected.posterSource,urls:[this.data.selected.posterSource]});},
 posterError(){this.setData({posterError:'活动安排原图读取失败，可单独重试。活动文字仍可查看。'});},
 releasePoster(){removeReportFile(this._posterPath);this._posterPath=null;},
 retryPoster(){return this.loadPoster();},
 async loadPoster(version=this._request){
  const item=this.data.selected;
  if(!item?.posterUrl||this.data.posterLoading||this._unloaded||this._shown===false||version!==this._request)return;
  this.setData({posterLoading:true,posterError:''});
  try{
   const source=await downloadActivityPoster(item.id,item.posterUrl);
   const local=!!wx.env?.USER_DATA_PATH&&source.startsWith(wx.env.USER_DATA_PATH+'/');
   if(this._unloaded||this._shown===false||version!==this._request||this.data.selected?.id!==item.id){if(local)removeReportFile(source);return;}
   this.releasePoster();if(local)this._posterPath=source;
   this.setData({selected:{...this.data.selected,posterSource:source}});
  }catch(e){if(!this._unloaded&&this._shown!==false&&version===this._request)this.setData({posterError:e.message||'原图暂时无法读取，可单独重试。'});}
  finally{if(!this._unloaded&&version===this._request)this.setData({posterLoading:false});}
 },
 async onPullDownRefresh(){try{await this.refresh();}finally{wx.stopPullDownRefresh();}},
 recapCurrent(version,stamp){hasSession();return !this._unloaded&&this._shown!==false&&this._request===version&&isCurrentSession(stamp);},
 async loadRecaps(version){
  const stamp=sessionStamp();this._recapStamp=stamp;
  this.setData({managedOfficialUrls:[],dynamicOfficials:[],officialFiltered:[],recaps:[],filteredRecaps:[],recapsLoading:true,recapsReady:false,recapsError:''});
  try{const [result,metadata]=await Promise.all([readArticleCatalog(readActivities,()=>this.recapCurrent(version,stamp)),readActivities('/content-topics')]);
   if(!this.recapCurrent(version,stamp))return;
   const placements=Object.fromEntries((metadata.topics||[]).map(m=>[m.articleId,m]));
   const records=result.articles.map(a=>{const m=placements[a.id];return {...a,group:m?(showsActivity(m)?m.activityGroup:''):recapGroups[a.id]||'',url:m?.originalUrl||'',isRecap:m&&Object.prototype.hasOwnProperty.call(m,'isRecap')?m.isRecap:!!recapGroups[a.id]};}).filter(a=>a.group);
   this.setData({managedOfficialUrls:metadata.topics.map(m=>m.originalUrl).filter(Boolean),dynamicOfficials:records.filter(a=>a.url),recaps:records.filter(a=>!a.url),recapsReady:true});this.filter();
  }catch(e){if(!this._unloaded&&this._shown!==false&&this._request===version)this.setData({recapsError:e.message||'活动回顾读取失败，请重试。'});}
  finally{if(!this._unloaded&&this._request===version)this.setData({recapsLoading:false});}
 },
 officialItems(){const dynamic=this.data.dynamicOfficials;return [...dynamic,...officialActivities.filter(a=>!this.data.managedOfficialUrls.includes(a.url)&&!dynamic.some(d=>d.url===a.url))];},
 officialCurrent(item){return !this._unloaded&&this._shown===true&&this.data.recapsReady&&this.recapCurrent(this._request,this._recapStamp)&&this.officialItems().some(a=>a.id===item.id&&a.url===item.url);},
 openOfficial(e){const item=this.officialItems().find(a=>a.id===e.currentTarget.dataset.id);if(!item||!this.officialCurrent(item))return;this.setData({officialErrorId:''});openOfficialArticle({platform:wx,url:item.url,isCurrent:()=>this.officialCurrent(item),onFailure:()=>this.setData({officialErrorId:item.id})});},
 copyOfficial(e){const item=this.officialItems().find(a=>a.id===e.currentTarget.dataset.id);if(!item||this.data.officialErrorId!==item.id||!this.officialCurrent(item))return;wx.showModal({title:'复制公众号原文链接',content:'复制后可在微信中粘贴打开该文章。',confirmText:'复制链接',success:r=>{if(r.confirm&&this.officialCurrent(item))wx.setClipboardData({data:item.url});}});},
 openRecap(e){const id=e.currentTarget.dataset.id,item=this.data.recaps.find(a=>a.id===id);if(this.data.recapsReady&&this.recapCurrent(this._request,this._recapStamp)&&item)wx.navigateTo({url:'/pages/articles/index?id='+encodeURIComponent(id)+(item.isRecap?'&recap=1':'')});},
 async refresh(){
  if(this._unloaded||this._shown===false)return;const version=this._request=(this._request||0)+1;
  this.releasePoster();this.setData({items:[],filtered:[],unclassified:[],selected:null,loading:true,ready:false,error:'',posterLoading:false,posterError:''});
  if(!this.data.id)void this.loadRecaps(version);
  try{const r=await readActivities('/activities'+(this.data.id?'/'+encodeURIComponent(this.data.id):''));if(this._unloaded||version!==this._request)return;
    this.setData({items:(r.activities||[]).map(decorate),selected:r.activity?decorate(r.activity):null,ready:true});this.filter();void this.loadPoster(version);
  }catch(e){if(!this._unloaded&&version===this._request)this.setData({error:e.message||'活动读取失败，请重试。'});}
  finally{if(!this._unloaded&&version===this._request)this.setData({loading:false});}
 },
 filter(){const query=this.data.query.trim();this.setData({officialFiltered:(this.data.recapsReady?this.officialItems():[]).filter(i=>(!this.data.group||i.group===this.data.group)&&(i.title+' '+i.summary).includes(query)),filteredRecaps:this.data.recaps.filter(i=>(!this.data.group||i.group===this.data.group)&&(i.title+' '+(i.summary||'')).includes(query)),filtered:this.data.items.filter(i=>(!this.data.group||groupOf(i)===this.data.group)&&(i.title+i.summary+i.location).includes(query)),unclassified:this.data.items.filter(i=>!groupOf(i))});},
 openGroup(e){const group=groups.find(g=>g.id===e.currentTarget.dataset.group);if(group)wx.navigateTo({url:'/pages/activities/index?group='+group.id});},
 search(e){this.setData({query:e.detail.value});this.filter();},
 open(e){const id=e.currentTarget.dataset.id;if(this.data.ready&&this.data.items.some(i=>i.id===id))wx.navigateTo({url:'/pages/activities/index?id='+encodeURIComponent(id)});},
 back(){returnToPrevious(this,'/pages/activities/index');}
});
