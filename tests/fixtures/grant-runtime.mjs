import {PGlite} from '@electric-sql/pglite';
import {createServer} from 'node:https';
import {readFileSync,writeFileSync,mkdtempSync,rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join,resolve} from 'node:path';
import {execFileSync} from 'node:child_process';
import {randomUUID,createHash} from 'node:crypto';
import {PDFDocument} from 'pdf-lib';
import {freshDatabaseSql,verifyFreshDatabase} from '../../server/postgres-fresh.mjs';
import {initializeGrantDatabase} from '../../server/collaboration/grant-migration.mjs';
import {prepareGrantHost} from '../../server/collaboration/grant-host.mjs';
import {createGrantIdentityVerifier} from '../../server/collaboration/grant-identity.mjs';
import {createPostgresCore} from '../../server/postgres-core.mjs';
import {createPostgresContent} from '../../server/postgres-content.mjs';
import {createPostgresApplication} from '../../server/postgres-app.mjs';
import {createPostgresAdmin} from '../../server/postgres-admin.mjs';
import {hashPassword} from '../../server/domain.mjs';

// Local synthetic integration only: fresh memory DB, short-lived TLS certificate,
// fictional identity/approval records, no external requests or actual payment.
export async function grantRuntime(t){
  const dir=mkdtempSync(join(tmpdir(),'grant-browser-'));
  let pg,server,app;
  t.after(async()=>{app?.stopMaintenance();if(server){server.closeAllConnections();await new Promise(r=>server.close(r));}await pg?.close();rmSync(dir,{recursive:true,force:true});});
  const openssl=process.env.OPENSSL_BIN||'openssl';
  execFileSync(openssl,['req','-x509','-newkey','rsa:2048','-nodes','-keyout',join(dir,'key.pem'),'-out',join(dir,'cert.pem'),'-days','1','-subj','/CN=localhost','-addext','subjectAltName=IP:127.0.0.1,DNS:localhost'],{stdio:'ignore',windowsHide:true});
  pg=new PGlite({parsers:{20:v=>BigInt(v)}});await pg.waitReady;
  const schema='club_migration_browser_grant',appId='wx0000000000000000';
  await pg.exec(freshDatabaseSql(schema));
  let tail=Promise.resolve();
  const pool={connect:async()=>{const prev=tail;let release;tail=new Promise(r=>release=r);await prev;return {
    query:(sql,args)=>args===undefined?pg.exec(sql).then(rows=>rows.at(-1)??{rows:[]}):pg.query(sql,args),release};}};
  let handler;
  server=createServer({key:readFileSync(join(dir,'key.pem')),cert:readFileSync(join(dir,'cert.pem'))},(req,res)=>handler(req,res));
  await new Promise((yes,no)=>{server.once('error',no);server.listen(0,'127.0.0.1',yes);});
  const origin='https://127.0.0.1:'+server.address().port;
  await initializeGrantDatabase(pool,{schema});
  await verifyFreshDatabase(pool,{schema});
  const config={schema,appId,adminOrigin:origin};
  const username='synthetic_operator',password='SyntheticOperator123!';
  const adminId=randomUUID();
  await pg.query(`SET search_path TO ${schema}`);
  await pg.query("INSERT INTO users(id,username,password_hash,role,created_at,referral_code,consent_version) VALUES($1,$2,$3,'admin',$4,'SYNTHADMIN','fixture')",[adminId,username,await hashPassword(password),new Date().toISOString()]);
  const loginCore=createPostgresCore(pool,config);
  const adapter={configured:true,appId,exchangeCode:async code=>({appId,openId:code})};
  const native=await loginCore.login({code:'synthetic-browser-consumer',consent:true},adapter);
  const other=await loginCore.login({code:'synthetic-browser-other',consent:true},adapter);
  const user=await loginCore.authenticate(native.accessToken);
  // These fixture-only rows are deliberately not a production evidence source.
  await pg.exec('CREATE TEMP TABLE synthetic_grant_evidence(user_id TEXT PRIMARY KEY,level TEXT,phone TEXT,revision TEXT)');
  await pg.query("INSERT INTO synthetic_grant_evidence VALUES($1,'star','+8613800000000','1')",[user.id]);
  const evidence=async(c,userId)=>(await c.query('SELECT * FROM synthetic_grant_evidence WHERE user_id=$1 FOR SHARE',[userId])).rows[0];
  const grantHost=await prepareGrantHost(pool,{...config,writesEnabled:true,confirmationSecret:'synthetic-browser-only-secret-minimum-32',
    policy:{approved:true,startRule:'confirmation-time',timeZone:'Asia/Shanghai',yearRule:'calendar-anniversary-clamp',overlap:'block-active',version:'synthetic-v1'},
    identityVerifier:createGrantIdentityVerifier({resolveEvidence:async(c,{userId})=>{const row=await evidence(c,userId);return row?{verified:true,userId,appId,openId:'synthetic-browser-consumer',reference:'synthetic-identity',revision:row.revision}:null;}}),
    phoneResolver:async(c,{phone})=>({available:true,matches:(await c.query('SELECT * FROM synthetic_grant_evidence WHERE phone=$1 FOR SHARE',[phone])).rows.map(row=>({userId:row.user_id,phone:row.phone,verified:true,reference:'synthetic-phone',revision:row.revision}))}),
    approvalResolver:async(c,r)=>{const row=await evidence(c,r.userId);return row&&r.approvalReference==='SYNTHETIC-APPROVAL'?{approved:true,userId:r.userId,level:row.level,reference:r.approvalReference,revision:row.revision}:null;}
  });
  const options={...config,entitlementResolver:grantHost.entitlementResolver,grantPaymentConflict:grantHost.grantPaymentConflict};
  const core=createPostgresCore(pool,options),content=createPostgresContent(pool,{...options,documentsDirectory:dir});
  const reportId=randomUUID(),now=new Date().toISOString();
  await pg.query(`INSERT INTO articles(id,title,summary,body,category,access_json,status,revision,created_by,updated_by,created_at,updated_at,published_at,idempotency_key,creation_hash)
    VALUES($1,'Synthetic star report','Synthetic summary','Protected synthetic report body','knowledge',$2,'published',1,$3,$3,$4,$4,$4,$5,'synthetic')`,[reportId,JSON.stringify({visibility:'plans',planIds:['star'],previewPages:10}),adminId,now,randomUUID()]);
  const pdf=await PDFDocument.create();for(let i=0;i<12;i++)pdf.addPage().drawText('SYNTHETIC REPORT PAGE '+(i+1));
  const full=Buffer.from(await pdf.save()),previewPdf=await PDFDocument.create();for(let i=0;i<10;i++)previewPdf.addPage().drawText('SYNTHETIC PREVIEW PAGE '+(i+1));const preview=Buffer.from(await previewPdf.save());
  const save=bytes=>{const hash=createHash('sha256').update(bytes).digest('hex');writeFileSync(join(dir,hash+'.pdf'),bytes);return hash;};
  await pg.query('INSERT INTO article_documents VALUES($1,$2,$3,$4,12,$5)',[reportId,save(full),'synthetic-report.pdf',full.length,now]);
  await pg.query('INSERT INTO report_previews VALUES($1,$2,$3,10)',[reportId,save(preview),preview.length]);
  app=createPostgresApplication({core,content,grantHost,admin:createPostgresAdmin(pool,config),hosts:[new URL(origin).host],mode:'fresh',autoRecover:false});
  const business=app.listeners('request')[0];
  handler=(req,res)=>{
    const path=new URL(req.url,origin).pathname;
    let file;
    if(path==='/ops/'||path==='/ops/index.html')file=resolve('work/admin-build/ops/index.html');
    else if(/^\/ops\/assets\/[a-zA-Z0-9_.-]+\.(js|css)$/.test(path))file=resolve('work/admin-build/'+path.slice(5));
    if(file&&req.method==='GET'){
      try{const bytes=readFileSync(file);res.writeHead(200,{'Content-Type':file.endsWith('.html')?'text/html':file.endsWith('.js')?'text/javascript':'text/css','Cache-Control':'no-store'});return res.end(bytes);}catch{res.writeHead(404);return res.end();}
    }
    return business(req,res);
  };
  return {origin,pg,pool,schema,core,content,grantHost,user,native,other,reportId,full,username,password,adminId};
}
