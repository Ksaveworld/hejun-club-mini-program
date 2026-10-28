import { resolve } from 'node:path';
import { existsSync, mkdirSync, writeFileSync, readFileSync } from 'node:fs';
import { loadEnvFile } from 'node:process';
import { randomBytes } from 'node:crypto';
import { openDatabase } from './db.mjs';
import { hashPassword, insertUser } from './domain.mjs';
import { createApplication } from './app.mjs';
import { createWechatAdapter } from './wechat.mjs';
import { createWechatPay } from './wechat-pay.mjs';

// Only the server reads this ignored local file; inherited environment values win.
const localEnv = resolve('server/.env.local');
if (existsSync(localEnv)) loadEnvFile(localEnv);
if (process.env.NODE_ENV === 'production') throw new Error('当前为本机内测服务。部署、HTTPS、身份验证及支付验收完成前不得作为生产环境启动。');
const db = openDatabase(resolve(process.env.CLUB_DB_PATH || 'work/data/club.sqlite'));
if (!db.prepare("SELECT 1 FROM users WHERE role='admin'").get()) {
  const password = randomBytes(18).toString('base64url');
  const user = insertUser(db,'club_admin',await hashPassword(password),'admin');
  mkdirSync('work',{ recursive:true });
  writeFileSync('work/local-admin.txt',`本机内测管理员（请保管好，不提交 Git）\n入口：http://127.0.0.1:5186/#/admin\n账号：${user.username}\n密码：${password}\n仅供当前数据库使用；会员请自行注册。\n`,'utf8');
  console.log('已创建本机管理员。登录资料保存在 work/local-admin.txt（不会显示在日志）。');
}
let wechatPay;
if(process.env.CLUB_WECHAT_PAY_CONFIG){
  try{wechatPay=createWechatPay(JSON.parse(readFileSync(process.env.CLUB_WECHAT_PAY_CONFIG,'utf8')));}
  catch{throw new Error('微信支付服务端私有配置无效，请核对商户号、证书、密钥和回调地址');}
}
const server = createApplication(db, { allowNativeTrialAuth: true, wechatPay, manualPayment: process.env.CLUB_MANUAL_PAYMENT === '1',
  wechat: createWechatAdapter({ appId: process.env.WECHAT_MINI_APP_ID, appSecret: process.env.WECHAT_MINI_APP_SECRET }) });
server.listen(5187,'127.0.0.1',()=>console.log('会员数据服务：http://127.0.0.1:5187（仅本机开发；商户真实联调状态需另行验证）'));
server.on('error',error=>{ console.error('数据服务启动失败：',error.message); db.close(); process.exit(1); });
for (const signal of ['SIGINT','SIGTERM']) process.on(signal,()=>server.close(()=>{ db.close(); process.exit(0); }));
