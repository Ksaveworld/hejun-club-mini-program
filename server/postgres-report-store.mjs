import {createHash} from 'node:crypto';
import {createReadStream} from 'node:fs';
import {join} from 'node:path';
import {postgresTransaction,safeInteger} from './postgres.mjs';
import {requireRule} from './domain.mjs';

export const reportStoreTables=['_club_report_chunks','_club_report_files'];
const chunkSize=1024*1024;
// Share only reads that are currently in flight. No bytes or authorization
// decisions survive the query; every request still runs its own access checks.
const pendingChunks=new WeakMap();
function readChunk(pool,schema,sha256,part){
  let pending=pendingChunks.get(pool);
  if(!pending){pending=new Map();pendingChunks.set(pool,pending);}
  const key=JSON.stringify([schema,sha256,part]);
  if(pending.has(key))return pending.get(key);
  const job=(async()=>{
    const c=await pool.connect();
    try{
      // pg's text protocol hex-encodes BYTEA (2x payload). Base64 keeps the
      // wire payload near 4/3 without changing stored bytes or their hash.
      const encoded=(await c.query(`SELECT encode(data,'base64') AS encoded FROM ${schemaName(schema)}._club_report_chunks WHERE sha256=$1 AND part=$2`,[sha256,part])).rows[0]?.encoded;
      return typeof encoded==='string'?Buffer.from(encoded,'base64'):undefined;
    }
    finally{c.release();}
  })();
  pending.set(key,job);
  const clear=()=>{if(pending.get(key)===job)pending.delete(key);};
  job.then(clear,clear);
  return job;
}
const schemaName=s=>{requireRule(/^club_migration_[a-z0-9_]{1,40}$/.test(s||''),'私有资料数据区不正确');return '"'+s+'"';};
export async function initializeReportStore(pool,{schema}){
  return postgresTransaction(pool,async c=>{
    await c.query(`SET LOCAL search_path TO ${schemaName(schema)}`);
    await c.query('CREATE TABLE IF NOT EXISTS _club_report_files(sha256 TEXT PRIMARY KEY,byte_size BIGINT NOT NULL CHECK(byte_size>0),parts BIGINT NOT NULL CHECK(parts>0))');
    await c.query('CREATE TABLE IF NOT EXISTS _club_report_chunks(sha256 TEXT NOT NULL REFERENCES _club_report_files(sha256),part BIGINT NOT NULL CHECK(part>=0),data BYTEA NOT NULL CHECK(octet_length(data)>0),PRIMARY KEY(sha256,part))');
    await c.query("INSERT INTO settings(key,value) VALUES('private-report-store-v1','pg-chunks-1048576') ON CONFLICT(key) DO NOTHING");
  });
}
export async function importReportBatch(pool,{schema,directory,files}){
  let stored=0,reused=0;
  for(const file of files){
    requireRule(/^[a-f0-9]{64}$/.test(file.sha256)&&Number.isSafeInteger(file.bytes)&&file.bytes>0&&file.bytes<=128*1024*1024,'私有资料清单不正确');
    const result=await postgresTransaction(pool,async c=>{
      await c.query(`SET LOCAL search_path TO ${schemaName(schema)}`);
      const known=(await c.query('SELECT * FROM _club_report_files WHERE sha256=$1',[file.sha256])).rows[0];
      if(known){requireRule(safeInteger(known.byte_size)===file.bytes&&safeInteger(known.parts)===Math.ceil(file.bytes/chunkSize),'已有报告存储不一致');return false;}
      await c.query('INSERT INTO _club_report_files VALUES($1,$2,$3)',[file.sha256,file.bytes,Math.ceil(file.bytes/chunkSize)]);
      const hash=createHash('sha256');let bytes=0,part=0;
      for await(const data of createReadStream(join(directory,file.sha256+'.pdf'),{highWaterMark:chunkSize})){
        if(part===0)requireRule(data.subarray(0,5).toString()==='%PDF-','私有资料格式不正确');
        hash.update(data);bytes+=data.length;
        await c.query('INSERT INTO _club_report_chunks VALUES($1,$2,$3)',[file.sha256,part++,data]);
      }
      requireRule(bytes===file.bytes&&hash.digest('hex')===file.sha256&&part===Math.ceil(bytes/chunkSize),'私有资料指纹不一致');return true;
    });
    if(result)stored++;else reused++;
  }
  return {stored,reused};
}
// The content layer has already checked publication, account and membership.
// Storage has no public file URL or unauthenticated import endpoint.
export async function sendPostgresReport(pool,{schema},row,req,res){
  requireRule(row&&/^[a-f0-9]{64}$/.test(row.sha256),'报告原件不存在',404);
  const etag='"'+row.sha256+'"';requireRule(!req.headers['if-match']||req.headers['if-match']===etag,'报告已变化，请重新打开',412);
  const plan=await (async()=>{
    const size=row.byte_size;
    let start=0,end=size-1,status=200;
    const headers={'Content-Type':'application/pdf','Cache-Control':'private, no-store','X-Content-Type-Options':'nosniff','ETag':etag,'Accept-Ranges':'bytes','Referrer-Policy':'no-referrer','Content-Security-Policy':'sandbox',
      'Content-Disposition':(new URL(req.url,'http://localhost').searchParams.get('download')==='1'?'attachment':'inline')+`; filename="report.pdf"; filename*=UTF-8''`+encodeURIComponent(row.filename).replace(/'/g,'%27')};
    if(req.headers.range){
      const match=/^bytes=(\d*)-(\d*)$/.exec(req.headers.range);
      if(!match||(!match[1]&&!match[2])){res.writeHead(416,{...headers,'Content-Range':`bytes */${size}`});res.end();return;}
      if(match[1]){start=Number(match[1]);end=match[2]?Math.min(Number(match[2]),end):end;}
      else start=Math.max(0,size-Number(match[2]));
      if(!Number.isSafeInteger(start)||!Number.isSafeInteger(end)||start<0||start>=size||end<start){res.writeHead(416,{...headers,'Content-Range':`bytes */${size}`});res.end();return;}
      status=206;headers['Content-Range']=`bytes ${start}-${end}/${size}`;
    }
    // Verify the exact requested parts before starting the response.
    const first=Math.floor(start/chunkSize),last=Math.floor(end/chunkSize);
    // One SELECT provides a consistent metadata/part snapshot, avoiding five
    // transaction/setup round trips for each reader. All identifiers validated.
    const c=await pool.connect();let parts;
    try{parts=(await c.query(`SELECT f.byte_size,c.part,octet_length(c.data)::bigint AS bytes FROM ${schemaName(schema)}._club_report_files f LEFT JOIN ${schemaName(schema)}._club_report_chunks c ON c.sha256=f.sha256 AND c.part BETWEEN $2 AND $3 WHERE f.sha256=$1 ORDER BY c.part`,[row.sha256,first,last])).rows;}
    finally{c.release();}
    requireRule(parts.length&&safeInteger(parts[0].byte_size)===row.byte_size,'报告原件暂不可用',404);
    requireRule(parts.length===last-first+1&&parts.every((p,i)=>p.part!==null&&p.bytes!==null&&safeInteger(p.part)===first+i&&safeInteger(p.bytes)===Math.min(chunkSize,size-(first+i)*chunkSize)),'报告存储不完整',503);
    return {first,last,start,end,size,status,headers};
  })();
  if(!plan||res.destroyed)return;
  const {first,last,start,end,size,status,headers}=plan;
  // Imports are atomic and content-addressed: an existing SHA is never overwritten.
  // Borrow only for a chunk query, never while waiting for a slow client to read.
  // Recheck chunks so concurrent deletion cannot finish a truncated response.
  const hash=start===0&&end===size-1?createHash('sha256'):null;
  res.writeHead(status,{...headers,'Content-Length':end-start+1});
  for(let part=first;part<=last;part++){
    if(res.destroyed)return;
    const data=await readChunk(pool,schema,row.sha256,part);
    if(res.destroyed)return;
    requireRule(data&&data.length===Math.min(chunkSize,size-part*chunkSize),'报告存储不完整',503);
    hash?.update(data);
    if(hash&&part===last)requireRule(hash.digest('hex')===row.sha256,'报告原件指纹不一致',503);
    const buffer=Buffer.isBuffer(data)?data:Buffer.from(data);
    const bytes=buffer.subarray(Math.max(0,start-part*chunkSize),Math.min(data.length,end-part*chunkSize+1));
    if(!res.write(bytes))await waitForDrainOrClose(res);
  }
  if(!res.destroyed)res.end();
}

function waitForDrainOrClose(res){
  if(res.destroyed)return Promise.resolve();
  return new Promise((resolve,reject)=>{
    const cleanup=()=>{res.off('drain',done);res.off('close',done);res.off('error',fail);};
    const done=()=>{cleanup();resolve();};
    const fail=error=>{cleanup();reject(error);};
    res.once('drain',done);res.once('close',done);res.once('error',fail);
    if(res.destroyed)done();
  });
}
