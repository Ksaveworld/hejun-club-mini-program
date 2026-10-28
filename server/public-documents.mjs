import {readFileSync} from 'node:fs';
import {createHash} from 'node:crypto';
import {BusinessError} from './domain.mjs';
import {readActivity} from './activities.mjs';
const applicationTemplates = Object.freeze({
  partner: {file: 'forms/partner-application-20261013.docx', sha256: 'd3f9c87526354f686c4668867b67d1ca0add210ede159664d5039b612768ff43'},
  organization: {file: 'forms/organization-application-20261013.docx', sha256: 'efca447f49ad607ddf35a6c4d9a7fea74c6a3eb8a74f1c8845e7dc5b3f1ff270'},
});
// Only published documents and fixed blank templates, never user attachments.
export function sendPublicDocument(res, path, legal, db) {
  let file, type, expectedHash;
  const template = /^\/api\/enterprise-intake\/template\/(docx|pdf)$/.exec(path);
  const application = /^\/api\/application-templates\/(partner|organization)\/docx$/.exec(path);
  const policy = /^\/api\/legal\/(privacy|terms)\/document$/.exec(path);
  const poster = /^\/api\/activities\/([a-f0-9-]{36})\/poster$/.exec(path);
  if (template) {type = template[1]; file = `forms/enterprise-template-20260923.${type}`;}
  else if (application) {
    const document = applicationTemplates[application[1]];
    type = 'docx'; file = document.file; expectedHash = document.sha256;
  }
  else if (policy) {
    const document = legal?.documents.find(d => d.id === policy[1]);
    if (!document) throw new BusinessError('当前协议尚未发布', 404);
    if (!/^legal\/[a-zA-Z0-9-]+\.pdf$/.test(document.url)) throw new BusinessError('协议文件配置异常', 503);
    file = document.url; type = 'pdf'; expectedHash = document.sha256;
  } else if (poster) {
    file=readActivity(db,poster[1]).posterUrl;
    if(!/^images\/[a-z0-9-]+\.(jpg|png|webp)$/.test(file||''))throw new BusinessError('此活动没有已发布原图',404);
    type=file.split('.').at(-1);
  } else return false;
  let bytes;
  try {bytes = readFileSync(new URL('../public/' + file, import.meta.url));}
  catch {throw new BusinessError('文件暂时不可读取，请稍后重试', 503);}
  if (expectedHash && createHash('sha256').update(bytes).digest('hex') !== expectedHash)
    throw new BusinessError('文件与当前发布版本不一致', 503);
  const mime={pdf:'application/pdf',docx:'application/vnd.openxmlformats-officedocument.wordprocessingml.document',jpg:'image/jpeg',png:'image/png',webp:'image/webp'};
  res.writeHead(200, {'Content-Type': mime[type],
    'Content-Length': bytes.length, 'Cache-Control': 'no-store', 'X-Content-Type-Options': 'nosniff'});
  res.end(bytes); return true;
}
