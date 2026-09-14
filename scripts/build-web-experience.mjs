import {build} from 'vite';
import {readFile,writeFile,readdir,rename} from 'node:fs/promises';
import {resolve,join,extname} from 'node:path';
const out=resolve('work/deploy/cabc-club-app'),base='/hejun-club';
await build({mode:'web-trial',base:base+'/',build:{outDir:out,rolldownOptions:{input:resolve('hosted.html')}}});
await rename(join(out,'hosted.html'),join(out,'index.html'));
// Public images referenced directly by existing React components also need the project prefix.
for(const entry of await readdir(out,{recursive:true,withFileTypes:true})){
 if(!entry.isFile()||!['.html','.js','.css'].includes(extname(entry.name)))continue;
 const file=join(entry.parentPath,entry.name);let text=await readFile(file,'utf8');
 for(const prefix of ['/images/','/icons/','/fonts/'])text=text.replaceAll(new RegExp('(?<!'+base+')'+prefix,'g'),base+prefix);
 await writeFile(file,text);
}
console.log('Business web build ready: '+out);
