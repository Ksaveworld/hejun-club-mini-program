// Collect metadata pages before local section/topic filtering. No document bytes.
async function readArticleCatalog(api,isCurrent=()=>true){
  const articles=[],ids=new Set(),cursors=new Set();let cursor='';
  for(let page=0;page<20;page++){
    if(!isCurrent())throw new Error('页面或账号已变化，请刷新资料。');
    const result=await api('/articles'+(cursor?'?after='+encodeURIComponent(cursor):''));
    if(!isCurrent())throw new Error('页面或账号已变化，请刷新资料。');
    if(!Array.isArray(result.articles))throw new Error('资料目录读取不完整，请重试。');
    for(const article of result.articles)if(!ids.has(article.id)){ids.add(article.id);articles.push(article);}
    if(!result.hasMore)return {articles,hasMore:false};
    const next=result.nextCursor;
    if(typeof next!=='string'||!/^[a-f0-9-]{36}$/.test(next)||cursors.has(next))throw new Error('资料目录读取不完整，请刷新重试。');
    cursors.add(next);cursor=next;
  }
  throw new Error('资料目录较多，暂未读取完整，请联系工作人员。');
}
module.exports={readArticleCatalog};
