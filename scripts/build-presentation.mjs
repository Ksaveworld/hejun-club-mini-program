import { build } from 'vite';
import { writeFile, readFile, readdir, mkdir } from 'node:fs/promises';
import { resolve, join } from 'node:path';
const output = resolve('work/deploy/cabc-club-preview');
await build({mode:'presentation',build:{outDir:output}});
const config = {
  framework:null, buildCommand:null, installCommand:null, outputDirectory:'.',
  headers:[{source:'/(.*)',headers:[
    {key:'X-Robots-Tag',value:'noindex, nofollow'},
    {key:'X-Content-Type-Options',value:'nosniff'},
    {key:'Referrer-Policy',value:'strict-origin-when-cross-origin'}
  ]}]
};
await writeFile(join(output,'vercel.json'),JSON.stringify(config,null,2)+'\n');
await writeFile(join(output,'robots.txt'),'User-agent: *\nDisallow: /\n');
await writeFile(join(output,'.vercelignore'),'.env*\n.gitignore\n.vercel\n');
await mkdir(join(output,'.vercel'),{recursive:true});
await writeFile(join(output,'.vercel/project.json'),await readFile('deployment/presentation-project.json','utf8'));
const files = await readdir(output,{recursive:true,withFileTypes:true});
const forbidden = files.filter(file=>file.isFile()&&(/(?:\.sqlite(?:-wal|-shm)?|\.env|local-admin|\.map$)/i.test(file.name)||['server','tasks','tests','scripts','交付文件'].some(name=>file.parentPath.split(/[\\/]/).includes(name))));
if(forbidden.length)throw Error('Private files found in presentation package');
console.log(JSON.stringify({output,publicFiles:files.filter(f=>f.isFile()).length,privateFiles:forbidden.length,mode:'presentation'}));
