import { spawn } from 'node:child_process';
const children = [];
let stopping = false;
function stop(code = 0) {
  if (stopping) return;
  stopping = true;
  for (const child of children) child.kill();
  process.exitCode = code;
}
for (const args of [['server/index.mjs'],['node_modules/vite/bin/vite.js','--host','127.0.0.1','--port','5186','--strictPort']]) {
  const child = spawn(process.execPath,args,{ stdio:'inherit',windowsHide:true });
  children.push(child);
  child.on('error',error=>{ console.error(error.message); stop(1); });
  child.on('exit',code=>{ if (!stopping) stop(code ?? 1); });
}
process.on('SIGINT',()=>stop());
process.on('SIGTERM',()=>stop());
