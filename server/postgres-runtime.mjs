import {readFileSync} from 'node:fs';
import {createHash} from 'node:crypto';
import {postgresTransaction} from './postgres.mjs';
import {plans} from './domain.mjs';
import {validateRewardRuntime} from './postgres-reward-runtime.mjs';
import {validatePhaseOneFeatures} from './postgres-feature-runtime.mjs';
import {postVersionMigrationTables} from './postgres-content.mjs';
import {renewalMigrationTables} from './postgres-renewals.mjs';
import {reminderMigrationTables} from './postgres-reminders.mjs';
import {reviewMigrationTables} from './postgres-review-access.mjs';
import {validateReviewRuntime} from './postgres-review-runtime.mjs';
import {createWechatPay} from './wechat-pay.mjs';
import {createWechatVirtualPay} from './wechat-virtual-pay.mjs';
import {createPostgresVirtualPayment,verifyVirtualPaymentSchema,virtualPaymentMigrationTables} from './postgres-virtual-payment.mjs';

const fail=()=>{throw new Error('迁移服务配置或数据检查失败；未启动，请核对私有配置与导入报告');};
const baseline=readFileSync(new URL('./migrations/postgres/001-baseline.sql',import.meta.url),'utf8');
const baselineHash=createHash('sha256').update(baseline).digest('hex');
const tables=[...baseline.matchAll(/CREATE TABLE (\w+)\s*\(/g)].map(match=>match[1]).sort();

// Explicit private config only. This entry never imports, seeds, or alters a database.
export function validatePostgresRuntime(config){
  validateRewardRuntime(config);
  validatePhaseOneFeatures(config);
  validateReviewRuntime(config);
  if(!['migration','fresh'].includes(config?.mode)||!/^club_migration_[a-z0-9_]{1,40}$/.test(config.schema||'')||
    (config.mode==='migration'?!/^[a-f0-9]{64}$/.test(config.sourceDigest||''):config.sourceDigest!==undefined)||config.appId!=='wx47d5e3e20fd77f65')fail();
  if(!['127.0.0.1','0.0.0.0'].includes(config.listenHost)||!Number.isInteger(config.port)||config.port<1024||config.port>65535)fail();
  if(!Array.isArray(config.hosts)||!config.hosts.length||!config.hosts.every(h=>typeof h==='string'&&/^[a-zA-Z0-9.-]+(?::\d{1,5})?$/.test(h)))fail();
  if(config.adminOrigin!==undefined){let origin;try{origin=new URL(config.adminOrigin);}catch{fail();}if(origin.origin!==config.adminOrigin||origin.protocol!=='https:'||!config.hosts.includes(origin.host))fail();}
  if(config.origins!==undefined&&(!Array.isArray(config.origins)||!config.origins.every(origin=>{try{return new URL(origin).origin===origin&&new URL(origin).protocol==='https:';}catch{return false;}})))fail();
  if(config.reportStorage!==undefined&&(config.mode!=='fresh'||config.reportStorage!=='postgres'))fail();
  let url;try{url=new URL(config.database?.connectionString);}catch{fail();}
  if(!['postgres:','postgresql:'].includes(url.protocol)||url.search||url.hash)fail();
  const local=['localhost','127.0.0.1','[::1]'].includes(url.hostname);
  const ssl=config.database.ssl;
  if(local?!(ssl===false||ssl?.rejectUnauthorized===true):ssl?.rejectUnauthorized!==true)fail();
  if(ssl?.host!==undefined&&ssl.host!==url.hostname)fail();
  if(config.wechat!==undefined&&(!config.wechat||typeof config.wechat.appSecret!=='string'||!config.wechat.appSecret.trim()))fail();
  if(config.paymentChannel!==undefined&&!['virtual','ordinary'].includes(config.paymentChannel))fail();
  if(virtualPaymentApproved(config)){
    const v=config.virtualPayment;
    if((config.paymentChannel??'virtual')!=='virtual'||!config.wechat||v.appId!==config.appId||![0,1].includes(v.env)
      ||!v.products||!['basic','star'].every(id=>v.products[id]?.goodsPriceCents===plans[id].amountCents))fail();
  }
  if(config.wechat||config.payment){
    const legal=config.legal;
    if(legal?.status!=='approved'||typeof legal.id!=='string'||!legal.id||typeof legal.requireHongKongConsent!=='boolean'||
      !Array.isArray(legal.documents)||legal.documents.length!==2||new Set(legal.documents.map(d=>d.id)).size!==2)fail();
    for(const d of legal.documents){
      if(!['privacy','terms'].includes(d.id)||!d.version||!/^legal\/[a-zA-Z0-9-]+\.pdf$/.test(d.url||'')||!/^[a-f0-9]{64}$/.test(d.sha256||''))fail();
      try{if(createHash('sha256').update(readFileSync(new URL('../public/'+d.url,import.meta.url))).digest('hex')!==d.sha256)fail();}catch{fail();}
    }
  }
  if(config.payment){
    let callback;try{callback=new URL(config.payment.notifyUrl);}catch{fail();}
    if(!config.wechat||config.payment.appId!==config.appId||!config.hosts.includes(callback.host)||callback.pathname!=='/api/payments/wechat/notify')fail();
  }
  return config;
}

export async function verifyPostgresImport(pool,{schema,sourceDigest}){
  if(!/^club_migration_[a-z0-9_]{1,40}$/.test(schema||'')||!/^[a-f0-9]{64}$/.test(sourceDigest||''))fail();
  return postgresTransaction(pool,async client=>{
    await client.query('SET TRANSACTION READ ONLY');
    await client.query(`SET LOCAL search_path TO "${schema}"`);
    const markers=(await client.query('SELECT * FROM _club_pg_migrations ORDER BY version')).rows;
    if(markers.length!==1||Number(markers[0].version)!==1||markers[0].baseline_sha256!==baselineHash||markers[0].source_digest!==sourceDigest||Number(markers[0].source_tables)!==tables.length)fail();
    const actual=(await client.query('SELECT table_name FROM information_schema.tables WHERE table_schema=$1 AND table_type=$2',[schema,'BASE TABLE'])).rows.map(r=>r.table_name).filter(n=>n!=='_club_pg_migrations').sort();
    const optional=await virtualPaymentMigrationTables(client,schema);
    optional.push(...await postVersionMigrationTables(client,schema));
    optional.push(...await renewalMigrationTables(client,schema),...await reminderMigrationTables(client,schema));
    optional.push(...await reviewMigrationTables(client,schema));
    const reward=(await client.query("SELECT value FROM settings WHERE key='_club_reward_ledger_migration'")).rows[0];
    if(reward){if(reward.value!=='003-reward-ledger-v1')fail();optional.push('_club_reward_ledger_state','_club_reward_ledger_commands','_club_reward_order_snapshots');}
    if(JSON.stringify(actual)!==JSON.stringify([...tables,...optional].sort()))fail();
    return {storage:'postgres',tables:tables.length,importVerified:true,releaseReady:false};
  });
}

export function virtualPaymentApproved(config){return config?.virtualPayment?.enabled===true&&config.virtualPayment.status==='approved';}

// Native memberships default to the virtual channel. An ordinary channel must
// be explicitly selected; incomplete virtual configuration never falls back.
export async function createPostgresPaymentRuntime(pool,config,wechat,core,{fetchImpl=globalThis.fetch,rewards,renewals}={}){
  const paymentChannel=config.paymentChannel??'virtual';
  if(paymentChannel==='ordinary')return {paymentChannel,payment:createWechatPay(config.payment)};
  if(!virtualPaymentApproved(config))return {paymentChannel,payment:{configured:false},virtualPayment:{configured:false}};
  requireVirtualPrices(config);
  await verifyVirtualPaymentSchema(pool,config);
  const provider=createWechatVirtualPay(config.virtualPayment,{fetchImpl,getAccessToken:input=>wechat.getAccessToken(input)});
  return {paymentChannel,payment:{configured:false},virtualPayment:createPostgresVirtualPayment(pool,{...config,provider,wechat,core,rewards,renewals})};
}
function requireVirtualPrices(config){
  if(config.virtualPayment.appId!==config.appId||!['basic','star'].every(id=>config.virtualPayment.products?.[id]?.goodsPriceCents===plans[id].amountCents))fail();
}
