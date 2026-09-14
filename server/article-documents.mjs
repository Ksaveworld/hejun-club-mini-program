import {openSync,closeSync,readSync,fstatSync,constants,createReadStream} from 'node:fs';
import {join} from 'node:path';
import {pipeline} from 'node:stream/promises';
import {requireRule} from './domain.mjs';

export function documentInfo(db,id){
  const row=db.prepare('SELECT filename,byte_size,pages FROM article_documents WHERE article_id=?').get(id);
  const preview=db.prepare('SELECT pages FROM report_previews WHERE article_id=?').get(id);
  return row?{filename:row.filename,bytes:row.byte_size,pages:row.pages,previewPages:preview?.pages||0}:null;
}
export async function sendArticleDocument(db,id,directory,req,res,preview=false){
  const row=preview?db.prepare("SELECT p.sha256,p.byte_size,p.pages,'试看-'+d.filename AS filename FROM report_previews p JOIN article_documents d USING(article_id) WHERE p.article_id=?").get(id):db.prepare('SELECT * FROM article_documents WHERE article_id=?').get(id);
  requireRule(row&&directory&&/^[a-f0-9]{64}$/.test(row.sha256),'报告原件不存在',404);
  let fd;
  try{fd=openSync(join(directory,row.sha256+'.pdf'),constants.O_RDONLY|(constants.O_NOFOLLOW||0));}catch{requireRule(false,'报告原件暂不可用',404);}
  try{
    const st=fstatSync(fd);requireRule(st.isFile()&&st.size===row.byte_size,'报告文件校验失败',503);
    const header=Buffer.alloc(5);readSync(fd,header,0,5,0);requireRule(header.toString()==='%PDF-','报告格式不正确',503);
    const headers={'Content-Type':'application/pdf','X-Content-Type-Options':'nosniff','Cache-Control':'private, no-store',
      'Content-Security-Policy':"sandbox",'Referrer-Policy':'no-referrer','Accept-Ranges':'bytes',
      'Content-Disposition':(new URL(req.url,'http://localhost').searchParams.get('download')==='1'?'attachment':'inline')+`; filename="report.pdf"; filename*=UTF-8''`+encodeURIComponent(row.filename).replace(/'/g,'%27')};
    let start=0,end=st.size-1,status=200;
    if(req.headers.range){
      const match=/^bytes=(\d*)-(\d*)$/.exec(req.headers.range);
      if(!match||(!match[1]&&!match[2])){res.writeHead(416,{...headers,'Content-Range':`bytes */${st.size}`});res.end();return;}
      if(match[1]){start=Number(match[1]);end=match[2]?Math.min(Number(match[2]),end):end;}
      else{const suffix=Number(match[2]);start=Math.max(0,st.size-suffix);}
      if(!Number.isSafeInteger(start)||!Number.isSafeInteger(end)||start<0||start>=st.size||end<start){res.writeHead(416,{...headers,'Content-Range':`bytes */${st.size}`});res.end();return;}
      status=206;headers['Content-Range']=`bytes ${start}-${end}/${st.size}`;
    }
    res.writeHead(status,{...headers,'Content-Length':end-start+1});
    const stream=createReadStream('',{fd,autoClose:true,start,end});fd=undefined;
    await pipeline(stream,res).catch(()=>res.destroy());
  }finally{if(fd!==undefined)closeSync(fd);}
}
