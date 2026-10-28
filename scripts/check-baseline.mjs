import fs from 'node:fs';
import {execFileSync} from 'node:child_process';
const manifest=JSON.parse(fs.readFileSync(new URL('../docs/collaboration/GRANT-SOURCE-MANIFEST.json',import.meta.url),'utf8'));
for(const f of manifest.files){const actual=execFileSync('git',['hash-object',f.path],{encoding:'utf8'}).trim();if(actual!==f.gitBlob)throw new Error('Source differs: '+f.path);}
console.log('Verified source blobs: '+manifest.files.length);
