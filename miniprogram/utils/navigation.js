// Retry only a failed navigation whose originating page is still on top.
// Business writes never pass through this helper.
function returnToPrevious(page, fallback) {
  if(page._navigationPending || page.data.busy || page.data.loading)return;
  const stack=getCurrentPages(), origin=stack[stack.length-1];
  page._navigationPending=true;
  const finish=()=>{page._navigationPending=false;};
  if(stack.length<2){wx.redirectTo({url:fallback,success:finish,fail:()=>{finish();if(!page._unloaded)page.setData({error:'暂时无法打开列表，请稍后再试。'});}});return;}
  const back=retry=>wx.navigateBack({delta:1,success:finish,fail:error=>{
    const current=getCurrentPages();
    if(page._unloaded || current[current.length-1]!==origin){finish();return;}
    if(!retry && /timeout/.test(error.errMsg || '')){back(true);return;}
    finish();page.setData({error:'暂时未能返回，请再次点击返回。当前记录仍保留。'});
  }});
  back(false);
}
module.exports={returnToPrevious};
