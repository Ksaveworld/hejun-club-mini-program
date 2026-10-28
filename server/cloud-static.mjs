import {readFileSync} from 'node:fs';
const types={html:'text/html; charset=utf-8',js:'text/javascript; charset=utf-8',css:'text/css; charset=utf-8',png:'image/png',jpg:'image/jpeg',jpeg:'image/jpeg',webp:'image/webp',svg:'image/svg+xml'};
// Only compiled operations assets and public brand images; never workspace,
// uploaded enterprise files, report chunks or runtime credentials.
export function sendCloudStatic(req,res,path,{adminOrigin}={}){
  if(!['GET','HEAD'].includes(req.method))return false;
  let file;
  if(/^\/images\/[a-zA-Z0-9-]+\.(png|jpg|jpeg|webp|svg)$/.test(path))file=path;
  else if(adminOrigin&&req.headers.host===new URL(adminOrigin).host){
    if(path==='/ops/'||path==='/ops/index.html')file='/ops/ops/index.html';
    else if(/^\/ops\/assets\/[a-zA-Z0-9_][a-zA-Z0-9_.-]*-[a-zA-Z0-9_-]{8}\.(js|css)$/.test(path))file=path;
  }
  if(!file)return false;
  let bytes;try{bytes=readFileSync(new URL('../public'+file,import.meta.url));}catch{return false;}
  res.writeHead(200,{'Content-Type':types[file.split('.').at(-1)],'Content-Length':bytes.length,'Cache-Control':'no-store','X-Content-Type-Options':'nosniff','X-Frame-Options':'DENY','Referrer-Policy':'same-origin',
    'Content-Security-Policy':"default-src 'none'; script-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' data:; connect-src 'self'; font-src 'self' data:; base-uri 'none'; form-action 'self'; frame-ancestors 'none'"});
  res.end(req.method==='HEAD'?undefined:bytes);return true;
}
