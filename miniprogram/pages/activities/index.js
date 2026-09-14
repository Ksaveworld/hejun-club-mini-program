const {api}=require('../../utils/api');
const {returnToPrevious}=require('../../utils/navigation');
function decorate(item){
 const format=value=>{const d=new Date(Date.parse(value)+8*3600000);return d.toISOString().slice(0,16).replace('T',' ');};
 return {...item,time:format(item.startAt)+' 至 '+format(item.endAt),phase:Date.parse(item.endAt)<Date.now()?'已结束':Date.parse(item.startAt)>Date.now()?'即将开始':'进行中'};
}
Page({
 data:{id:'',items:[],filtered:[],selected:null,query:'',ready:false,loading:false,error:''},
 onLoad(options={}){this.setData({id:options.id||''});},
 onShow(){return this.refresh();},
 onHide(){this._request=(this._request||0)+1;this.setData({items:[],filtered:[],selected:null,ready:false,loading:false});},
 onUnload(){this._unloaded=true;this.onHide();},
 async onPullDownRefresh(){try{await this.refresh();}finally{wx.stopPullDownRefresh();}},
 async refresh(){
  if(this._unloaded)return;const version=this._request=(this._request||0)+1;
  this.setData({items:[],filtered:[],selected:null,loading:true,ready:false,error:''});
  try{const r=await api('/activities'+(this.data.id?'/'+encodeURIComponent(this.data.id):''));if(this._unloaded||version!==this._request)return;
    this.setData({items:(r.activities||[]).map(decorate),selected:r.activity?decorate(r.activity):null,ready:true});this.filter();
  }catch(e){if(!this._unloaded&&version===this._request)this.setData({error:e.message||'活动读取失败，请重试。'});}
  finally{if(!this._unloaded&&version===this._request)this.setData({loading:false});}
 },
 filter(){this.setData({filtered:this.data.items.filter(i=>(i.title+i.summary+i.location).includes(this.data.query.trim()))});},
 search(e){this.setData({query:e.detail.value});this.filter();},
 open(e){const id=e.currentTarget.dataset.id;if(this.data.ready&&this.data.items.some(i=>i.id===id))wx.navigateTo({url:'/pages/activities/index?id='+encodeURIComponent(id)});},
 back(){returnToPrevious(this,'/pages/activities/index');}
});
