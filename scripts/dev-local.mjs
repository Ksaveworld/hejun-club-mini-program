import {spawn} from 'node:child_process';
import {existsSync,mkdirSync} from 'node:fs';
import {fileURLToPath} from 'node:url';
import {resolve} from 'node:path';
const root=fileURLToPath(new URL('../',import.meta.url));
const external=Object.keys(process.env).filter(k=>/^(CLUB_|WECHAT_|DATABASE_URL$|PGHOST$|PGDATABASE$|PGUSER$|PGPASSWORD$|PGSERVICE$)/.test(k)&&process.env[k]);
if(external.length||['.env','.env.local','server/.env.local'].some(p=>existsSync(resolve(root,p)))){
  console.error('本地启动已阻止：请在不带云端/数据库业务环境变量及私有.env文件的终端启动。不会打印变量值。');process.exit(1);
}
mkdirSync(resolve(root,'work/local'),{recursive:true});
const env={...process.env,NODE_ENV:'development',CLUB_DB_PATH:resolve(root,'work/local/club-test.sqlite')};
const children=[spawn(process.execPath,['server/index.mjs'],{cwd:root,env,stdio:'inherit'}),
 spawn(process.execPath,['node_modules/vite/bin/vite.js','--config','vite.admin.config.ts','--host','127.0.0.1','--port','5186','--strictPort'],{cwd:root,env,stdio:'inherit'})];
let closing=false;
function stop(code=0){if(closing)return;closing=true;for(const c of children)c.kill();process.exitCode=code;}
for(const c of children){c.on('error',()=>stop(1));c.on('exit',code=>stop(code||0));}
process.on('SIGINT',()=>stop());process.on('SIGTERM',()=>stop());
console.log('仅本机测试：后台 http://127.0.0.1:5186/ops/ops/index.html；API 127.0.0.1:5187；测试库 work/local/。');
console.log('这是历史SQLite页面联调入口；生产PG路径请运行隔离PGlite测试，不把SQLite运行当PG验收。');
