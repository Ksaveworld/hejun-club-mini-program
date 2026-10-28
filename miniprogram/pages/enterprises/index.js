const {api}=require('../../utils/api');
const config=require('../../config');
function decorate(item){const base=config.cloud?.downloadBaseUrl||config.apiBaseUrl||'';return {...item,logoSrc:item.logoUrl&&/^\/api\/enterprises\/[a-f0-9-]+\/logo$/.test(item.logoUrl)?base.replace(/\/api$/,'')+item.logoUrl:''};}
Page({
 data:{id:'',items:[],selected:null,loading:false,error:''},
 onLoad(options={}){this.setData({id:options.id||''});},
 onShow(){this._visible=true;return this.refresh();},
 onHide(){this._visible=false;this._request=(this._request||0)+1;this.setData({items:[],selected:null,loading:false});},
 onUnload(){this.onHide();},
 async onPullDownRefresh(){try{await this.refresh();}finally{wx.stopPullDownRefresh();}},
 async refresh(){const request=this._request=(this._request||0)+1;this.setData({loading:true,error:'',items:[],selected:null});try{const r=await api('/enterprises'+(this.data.id?'/'+encodeURIComponent(this.data.id):''));if(!this._visible||request!==this._request)return;this.setData({items:(r.enterprises||[]).map(decorate),selected:r.enterprise?decorate(r.enterprise):null});}catch(e){if(this._visible&&request===this._request)this.setData({error:e.message||'内容暂不可用'});}finally{if(this._visible&&request===this._request)this.setData({loading:false});}},
 open(e){const id=e.currentTarget.dataset.id;if(this.data.items.some(x=>x.id===id))wx.navigateTo({url:'/pages/enterprises/index?id='+encodeURIComponent(id)});},
 openSupply(){wx.navigateTo({url:'/pages/surveys/index?side=general-supply'});},
 back(){wx.navigateBack({fail:()=>wx.switchTab({url:'/pages/services/index'})});}
});
