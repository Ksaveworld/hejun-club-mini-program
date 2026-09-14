import {mkdirSync,existsSync,writeFileSync,lstatSync,readFileSync,realpathSync} from 'node:fs';
import {join,resolve} from 'node:path';
import {randomBytes} from 'node:crypto';
import {openDatabase,transaction} from './db.mjs';
import {insertUser,hashPassword} from './domain.mjs';
import {createApplication} from './app.mjs';
if(process.env.NODE_ENV==='production')throw new Error('业务体验尚未完成正式上线验收');
const directory='/var/lib/hejun-club-web';
mkdirSync(directory,{recursive:true,mode:0o700});
if(realpathSync(directory)!==directory || lstatSync(directory).mode&0o077)throw new Error('数据目录必须独立且权限为0700');
const marker=join(directory,'environment.json');
if(existsSync(marker)){if(JSON.parse(readFileSync(marker,'utf8')).mode!=='web-trial')throw new Error('数据目录属于其他环境');}
else {const {readdirSync}=await import('node:fs');if(readdirSync(directory).length)throw new Error('不能接管已有数据目录');writeFileSync(marker,JSON.stringify({mode:'web-trial'}),{flag:'wx',mode:0o600});}
for(const name of ['club.sqlite','club.sqlite-wal','club.sqlite-shm','admin.txt']){const st=lstatSync(join(directory,name),{throwIfNoEntry:false});if(st&&(!st.isFile()||st.isSymbolicLink()))throw new Error('数据文件类型异常');}
const db=openDatabase(join(directory,'club.sqlite'));
if(!db.prepare("SELECT 1 FROM users WHERE role='admin'").get()){
 const file=join(directory,'admin.txt');if(existsSync(file))throw new Error('管理员文件与数据库不一致');
 const password=randomBytes(24).toString('base64url'),hash=await hashPassword(password);
 transaction(db,()=>{insertUser(db,'web_admin',hash,'admin');writeFileSync(file,'业务体验管理员\n账号：web_admin\n密码：'+password+'\n',{flag:'wx',mode:0o600});});
}
const server=createApplication(db,{documentsDirectory:join(directory,'report-files'),webTrial:{mode:'web-trial',origin:'https://example.com'}});
server.requestTimeout=30000;server.headersTimeout=10000;
server.listen(5211,'127.0.0.1',()=>console.log('网页业务体验已启动，数据独立保存，支付关闭。'));
for(const signal of ['SIGINT','SIGTERM'])process.once(signal,()=>server.close(()=>{db.close();process.exit(0);}));
