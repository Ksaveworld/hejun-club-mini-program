const categories = require('../../data/service-directory.json');
Page({
 data: { categories, selected: null, tab: 'services' },
 onLoad(query = {}) { if(query.id) this.setData({selected:categories.find(c=>c.id===query.id)||null}); },
 openCategory(e){wx.navigateTo({url:'/pages/directory/index?id='+e.currentTarget.dataset.id});},
 changeTab(e){this.setData({tab:e.currentTarget.dataset.tab});},
 back(){wx.navigateBack({fail:()=>wx.redirectTo({url:'/pages/directory/index'})});}
});
