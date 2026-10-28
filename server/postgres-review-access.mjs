import {randomBytes} from 'node:crypto';
import {readFileSync} from 'node:fs';
import {postgresTransaction,safeInteger} from './postgres.mjs';
import {requireRule,checkPassword,digest} from './domain.mjs';
import {accessPolicy} from './articles.mjs';
import {resourceAccessPolicy} from './resources.mjs';
import {sendDocumentRow} from './article-documents.mjs';
import {sendPostgresReport} from './postgres-report-store.mjs';

export const reviewApplication={appId:'wx47d5e3e20fd77f65',appVersion:'1.1.0'};
export const reviewMigrationMarker={key:'_club_review_access_migration',value:'007-review-access-v1'};
export const reviewMigrationTableNames=['_club_review_accounts','_club_review_sessions'];
const sql=readFileSync(new URL('./migrations/postgres/007-review-access.sql',import.meta.url),'utf8');
const day=86400000,hour=3600000,uuid=/^[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}$/;
const notice='审核只读体验：可阅读已授权的发布内容和服务说明；申请、投稿、付款、推荐、提现及通知尚未开放审核演示。';
const schemaValid=s=>requireRule(/^club_migration_[a-z0-9_]{1,40}$/.test(s||''),'审核体验数据区不正确');
const one=async(c,q,args=[])=>(await c.query(q,args)).rows[0];
function iso(value){const at=value instanceof Date?value.getTime():Date.parse(value);requireRule(Number.isFinite(at),'审核体验期限配置不正确',503);return new Date(at).toISOString();}
function text(value){return typeof value==='string'&&value.trim().length>0;}
function fail(message,status=403,code='REVIEW_READ_ONLY'){const error=new Error(message);error.status=status;error.code=code;throw error;}

export async function reviewMigrationTables(client,schema){
  schemaValid(schema);
  const marker=await one(client,'SELECT value FROM settings WHERE key=$1',[reviewMigrationMarker.key]);
  const names=(await client.query('SELECT tablename FROM pg_tables WHERE schemaname=$1',[schema])).rows.map(r=>r.tablename);
  const found=reviewMigrationTableNames.filter(n=>names.includes(n));
  requireRule(!marker?found.length===0:marker.value===reviewMigrationMarker.value&&found.length===reviewMigrationTableNames.length,'审核体验迁移标记或表集合不一致',503);
  return marker?[...reviewMigrationTableNames]:[];
}
export async function initializePostgresReviewAccess(pool,{schema}={}){
  schemaValid(schema);
  return postgresTransaction(pool,async c=>{
    await c.query(`SET LOCAL search_path TO "${schema}"`);
    await c.query('LOCK TABLE settings IN SHARE ROW EXCLUSIVE MODE');
    if((await reviewMigrationTables(c,schema)).length)return {initialized:false,version:reviewMigrationMarker.value};
    await c.query(sql);
    return {initialized:true,version:reviewMigrationMarker.value,tables:[...reviewMigrationTableNames],accountsCreated:0};
  });
}

function scope(value){
  let parsed;try{parsed=typeof value==='string'?JSON.parse(value):value;}catch{}
  requireRule(parsed&&typeof parsed==='object'&&!Array.isArray(parsed)&&Object.keys(parsed).length===2&&Object.keys(parsed).every(k=>['articleIds','resourceIds'].includes(k)),'审核内容清单不正确',503);
  for(const field of ['articleIds','resourceIds'])requireRule(Array.isArray(parsed[field])&&parsed[field].length<=500&&parsed[field].every(id=>typeof id==='string'&&uuid.test(id))&&new Set(parsed[field]).size===parsed[field].length,'审核内容清单不正确',503);
  return {articleIds:[...parsed.articleIds].sort(),resourceIds:[...parsed.resourceIds].sort()};
}
function account(row,at){
  const startsAt=iso(row.starts_at),expiresAt=iso(row.expires_at),approvedAt=iso(row.approved_at);
  requireRule(uuid.test(row.id)&&row.app_id===reviewApplication.appId&&row.app_version===reviewApplication.appVersion&&['basic','star'].includes(row.plan_id)&&row.username===`review_${row.plan_id}_110`&&/^[a-f0-9]{32}:[a-f0-9]{128}$/.test(row.password_hash)&&text(row.approved_by)&&text(row.approval_ref),'审核账号授权配置不正确',503);
  requireRule(Date.parse(expiresAt)-Date.parse(startsAt)===30*day&&Date.parse(approvedAt)<=Date.parse(startsAt),'审核账号期限或批准时间不正确',503);
  if(row.revoked_at||!(Date.parse(startsAt)<=at&&at<Date.parse(expiresAt)))fail('审核体验尚未启用、已到期或已撤销',401,'REVIEW_EXPIRED');
  const contentScope=scope(row.scope_json);
  const grantDigest=digest(JSON.stringify({id:row.id,username:row.username,passwordHash:row.password_hash,appId:row.app_id,appVersion:row.app_version,planId:row.plan_id,scope:contentScope,startsAt,expiresAt,approvedAt,approvedBy:row.approved_by,approvalRef:row.approval_ref}));
  return {id:row.id,username:row.username,planId:row.plan_id,startsAt,expiresAt,scope:contentScope,grantDigest};
}
function legalSnapshot(legal,input){
  requireRule(input?.accepted===true&&input.releaseId===legal.id&&(!legal.requireHongKongConsent||input.hongKongAccepted===true),'请阅读当前协议并确认适用的存储安排',409);
  return {releaseId:legal.id,accepted:true,hongKongAccepted:input.hongKongAccepted===true,documents:legal.documents.map(({id,version,sha256})=>({id,version,sha256})).sort((a,b)=>a.id.localeCompare(b.id))};
}
const summary=row=>({id:row.id,title:row.title,summary:row.summary,category:row.category,publishedAt:row.published_at});

// Runtime construction never creates schema/accounts/grants, even when approved.
// Actors have role=reviewer, no production users row and no referral code. Do not
// pass them to core/forms/content/rewards; use this independent read projection.
export function createPostgresReviewAccess(pool,{schema,appId,appVersion,enabled=false,status,approvedBy,approvedAt,approvalRef,legal,documentsDirectory,reportStorage,now=()=>new Date().toISOString()}={}){
  schemaValid(schema);
  const configured=enabled===true&&status==='approved';
  if(configured){
    requireRule(appId===reviewApplication.appId&&appVersion===reviewApplication.appVersion&&text(approvedBy)&&text(approvalRef)&&Number.isFinite(Date.parse(approvedAt)),'审核体验配置尚未完整批准',503);
    requireRule(legal?.status==='approved'&&text(legal.id)&&typeof legal.requireHongKongConsent==='boolean'&&Array.isArray(legal.documents)&&legal.documents.length===2&&new Set(legal.documents.map(d=>d.id)).size===2&&legal.documents.every(d=>['privacy','terms'].includes(d.id)&&text(d.version)&&/^[a-f0-9]{64}$/.test(d.sha256||'')),'审核体验协议配置不完整',503);
    requireRule(reportStorage===undefined||reportStorage==='postgres','审核报告存储方式不正确',503);
  }
  const proofs=new WeakMap();
  const time=()=>Date.parse(iso(now()));
  const run=(fn,write=false)=>postgresTransaction(pool,async c=>{
    if(!write)await c.query('SET TRANSACTION ISOLATION LEVEL REPEATABLE READ READ ONLY');
    await c.query(`SET LOCAL search_path TO "${schema}"`);return fn(c);
  });
  const requireEnabled=()=>{if(!configured)fail('审核只读体验尚未配置',503,'REVIEW_DISABLED');};
  async function marker(c){requireRule((await one(c,'SELECT value FROM settings WHERE key=$1',[reviewMigrationMarker.key]))?.value===reviewMigrationMarker.value,'审核体验存储尚未显式初始化',503);}
  async function resolve(c,tokenHash,at){
    await marker(c);
    const row=await one(c,'SELECT a.*,s.grant_digest,s.created_at AS session_created_at,s.expires_at AS session_expires_at,s.auth_mode FROM _club_review_sessions s JOIN _club_review_accounts a ON a.id=s.account_id WHERE s.token_hash=$1',[tokenHash]);
    if(!row)return null;
    const grant=account(row,at);
    const issued=Date.parse(iso(row.session_created_at)),expiry=Date.parse(iso(row.session_expires_at));
    if(row.auth_mode!=='review'||issued>at||expiry<=at||expiry>issued+12*hour||expiry>Date.parse(grant.expiresAt)||row.grant_digest!==grant.grantDigest)fail('审核登录已失效，请重新登录',401,'REVIEW_EXPIRED');
    return {...grant,sessionExpiresAt:new Date(expiry).toISOString()};
  }
  async function owned(c,actor){
    requireEnabled();const proof=proofs.get(actor);
    requireRule(proof,'请使用当前审核体验会话',401);
    const grant=await resolve(c,proof,time());requireRule(grant,'审核登录已失效，请重新登录',401);return grant;
  }
  function user(grant){return {id:'review-'+grant.id,username:grant.username,role:'reviewer',authMode:'review',phoneVerified:false,referralCode:null,sourceCode:null,referralSource:null,referralLockedAt:null};}
  function view(grant){return {appId:reviewApplication.appId,appVersion:reviewApplication.appVersion,planId:grant.planId,startsAt:grant.startsAt,expiresAt:grant.expiresAt,readOnly:true,notice};}
  async function read(actor,fn){requireEnabled();return run(async c=>fn(c,await owned(c,actor)));}
  function policy(row,kind){try{return (kind==='article'?accessPolicy:resourceAccessPolicy)(JSON.parse(row.access_json));}catch{return null;}}
  function full(row,grant,kind){
    if(row?.status!=='published')return false;const p=policy(row,kind);
    return p?.visibility==='public'||(p?.visibility==='plans'&&p.planIds.includes(grant.planId)&&grant.scope[kind==='article'?'articleIds':'resourceIds'].includes(row.id));
  }
  async function articleState(c,grant,row){
    if(!row||row.status!=='published')return null;
    const doc=await one(c,'SELECT * FROM article_documents WHERE article_id=$1',[row.id]);
    const preview=doc?await one(c,'SELECT * FROM report_previews WHERE article_id=$1',[row.id]):null;
    const p=policy(row,'article'),allowed=full(row,grant,'article'),catalog=!!doc&&p?.visibility==='plans';
    return {row,doc,preview,full:allowed,visible:allowed||catalog,canPreview:catalog&&p.previewPages===10&&Number(preview?.pages)>0,
      info:doc?{filename:doc.filename,bytes:safeInteger(doc.byte_size),pages:safeInteger(doc.pages),previewPages:preview?safeInteger(preview.pages):0}:null};
  }
  const service={configured,appId:reviewApplication.appId,appVersion:reviewApplication.appVersion,readOnly:true,notice,
    async readiness(){
      if(!configured)return {enabled:false,readOnly:true,reason:'审核只读体验尚未配置',...reviewApplication};
      return run(async c=>{
        if(!(await reviewMigrationTables(c,schema)).length)return {enabled:false,readOnly:true,reason:'审核体验存储尚未显式初始化',...reviewApplication};
        const rows=(await c.query('SELECT * FROM _club_review_accounts ORDER BY plan_id')).rows;
        let ready=false;try{const grants=rows.map(r=>account(r,time()));ready=grants.length===2&&new Set(grants.map(g=>g.planId)).size===2;}catch{}
        return {enabled:ready,readOnly:true,reason:ready?notice:'基础及星级审核账号尚未同时批准启用',...reviewApplication};
      });
    },
    async login(input){
      requireEnabled();
      requireRule(input&&typeof input==='object'&&!Array.isArray(input)&&Object.keys(input).every(k=>['authMode','appId','appVersion','username','password','consent','legalConsent'].includes(k)),'审核登录参数不正确');
      requireRule(input.authMode==='review'&&input.appId===appId&&input.appVersion===appVersion,'审核登录版本或应用不一致',409);
      requireRule(input.consent===true,'请阅读并同意当前协议');const consent=legalSnapshot(legal,input.legalConsent);
      requireRule(typeof input.username==='string'&&/^[a-zA-Z0-9_]{4,32}$/.test(input.username)&&typeof input.password==='string'&&input.password.length>=10&&input.password.length<=128,'账号或密码不正确',401);
      return run(async c=>{
        await marker(c);await c.query('LOCK TABLE _club_review_accounts IN SHARE MODE');
        const row=await one(c,'SELECT * FROM _club_review_accounts WHERE username=$1 FOR SHARE',[input.username.toLowerCase()]);
        const encoded=/^[a-f0-9]{32}:[a-f0-9]{128}$/.test(row?.password_hash||'')?row.password_hash:'0'.repeat(32)+':'+ '0'.repeat(128);
        const valid=await checkPassword(input.password,encoded);requireRule(row&&valid,'账号或密码不正确',401);
        const at=time(),grant=account(row,at),token=randomBytes(32).toString('hex'),expiresAt=new Date(Math.min(at+12*hour,Date.parse(grant.expiresAt))).toISOString();
        await c.query('INSERT INTO _club_review_sessions(token_hash,account_id,auth_mode,grant_digest,created_at,expires_at,consent_json) VALUES($1,$2,$3,$4,$5,$6,$7)',[digest(token),grant.id,'review',grant.grantDigest,new Date(at).toISOString(),expiresAt,JSON.stringify(consent)]);
        return {user:user(grant),accessToken:token,tokenType:'Bearer',expiresAt,authMode:'review',reviewAccess:view(grant)};
      },true);
    },
    async authenticate(token){
      if(!configured||typeof token!=='string'||!/^[a-f0-9]{64}$/.test(token))return null;
      return run(async c=>{
        // An initialized review service may coexist with native bearer tokens;
        // absence is null, a known expired/revoked review token never falls through.
        const grant=await resolve(c,digest(token),time());if(!grant)return null;
        const actor=Object.freeze(user(grant));proofs.set(actor,digest(token));return actor;
      });
    },
    me:actor=>read(actor,async(c,grant)=>({user:user(grant),membership:null,reviewAccess:view(grant),paymentReady:false,manualPaymentReady:false,defaultReferralConfigured:false,renewals:{enabled:false,canRenew:false,reason:notice}})),
    articles:actor=>read(actor,async(c,grant)=>{
      const result=[];for(const row of (await c.query("SELECT * FROM articles WHERE status='published' ORDER BY published_at DESC,id")).rows){const state=await articleState(c,grant,row);if(state.visible)result.push({...summary(row),fullAccess:state.full,document:state.info,reviewAccess:view(grant)});if(result.length>100)break;}
      return {articles:result.slice(0,100),hasMore:result.length>100,reviewAccess:view(grant)};
    }),
    article:(actor,id)=>read(actor,async(c,grant)=>{
      requireRule(typeof id==='string'&&uuid.test(id),'内容地址不正确');const state=await articleState(c,grant,await one(c,'SELECT * FROM articles WHERE id=$1',[id]));
      requireRule(state?.visible,'内容不存在或当前不可阅读',404);return {...summary(state.row),body:state.full?state.row.body:'',fullAccess:state.full,document:state.info,reviewAccess:view(grant)};
    }),
    resources:actor=>read(actor,async(c,grant)=>{
      const rows=(await c.query("SELECT * FROM service_resources WHERE status='published' ORDER BY published_at DESC,id")).rows.filter(row=>full(row,grant,'resource'));
      return {resources:rows.slice(0,100).map(summary),hasMore:rows.length>100,reviewAccess:view(grant)};
    }),
    resource:(actor,id)=>read(actor,async(c,grant)=>{
      requireRule(typeof id==='string'&&uuid.test(id),'服务地址不正确');const row=await one(c,'SELECT * FROM service_resources WHERE id=$1',[id]);requireRule(full(row,grant,'resource'),'服务不存在或当前不可使用',404);
      return {...summary(row),body:row.body,action:{type:'unconfigured'},revision:safeInteger(row.revision),reviewAccess:view(grant)};
    }),
    async document(actor,id,preview,req,res){
      const row=await read(actor,async(c,grant)=>{
        requireRule(typeof id==='string'&&uuid.test(id)&&typeof preview==='boolean','报告地址不正确');
        const state=await articleState(c,grant,await one(c,'SELECT * FROM articles WHERE id=$1',[id]));
        requireRule(preview?state?.canPreview:state?.full,'内容不存在或当前不可阅读',404);
        const file=preview?state.preview:state.doc;requireRule(file,'报告原件不存在',404);return {...file,filename:preview?'试看-'+state.doc.filename:file.filename,byte_size:safeInteger(file.byte_size)};
      });
      // Recheck immediately before handing bytes to the existing bounded sender.
      await read(actor,async()=>{});
      return reportStorage==='postgres'?sendPostgresReport(pool,{schema},row,req,res):sendDocumentRow(row,documentsDirectory,req,res);
    },
    async logout(actor){requireEnabled();return run(async c=>{await owned(c,actor);await c.query('DELETE FROM _club_review_sessions WHERE token_hash=$1',[proofs.get(actor)]);proofs.delete(actor);return {ok:true};},true);},
    async handle(actor,{method,path,req,res}={}){
      // App integration must return this result directly for every review actor,
      // including refused GET/POST routes. Never call production handlers next.
      await read(actor,async()=>{});
      if(method==='POST'&&path==='/native/auth/logout')return {status:200,body:await service.logout(actor)};
      if(method==='GET'&&path==='/me')return {status:200,body:await service.me(actor)};
      if(method==='GET'&&path==='/articles')return {status:200,body:await service.articles(actor)};
      if(method==='GET'&&path==='/resources')return {status:200,body:await service.resources(actor)};
      const match=/^\/(articles|resources)\/([a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12})(?:\/(document|preview))?$/.exec(path||'');
      if(method==='GET'&&match){
        if(match[1]==='resources'&&!match[3])return {status:200,body:{resource:await service.resource(actor,match[2])}};
        if(match[1]==='articles'&&!match[3])return {status:200,body:{article:await service.article(actor,match[2])}};
        if(match[1]==='articles'&&match[3]){await service.document(actor,match[2],match[3]==='preview',req,res);return {sent:true};}
      }
      fail(notice);
    }
  };
  return Object.freeze(service);
}
