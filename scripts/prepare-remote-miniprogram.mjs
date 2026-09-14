import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { resolve, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { randomBytes } from 'node:crypto';
import { copyMiniProgramSources } from './prepare-lan-miniprogram.mjs';

const projectRoot = fileURLToPath(new URL('../', import.meta.url));
export const remoteApiBaseUrl = 'https://example.com/hejun-club-trial/api';
export function prepareRemoteMiniProgram({ apiBaseUrl = remoteApiBaseUrl,
  sourceDir = join(projectRoot, 'miniprogram'), outputRoot = join(projectRoot, 'work/wechat/remote-builds') } = {}) {
  // Only the reviewed deployment can receive this build's sessions. New domains need a reviewed change.
  if (apiBaseUrl !== remoteApiBaseUrl) throw new Error('远程测试包只允许已核验的 HTTPS 服务地址');
  const config = JSON.parse(readFileSync(join(sourceDir, 'project.config.json'), 'utf8'));
  if (!/^wx[0-9a-f]{16}$/i.test(config.appid)) throw new Error('缺少有效测试 AppID');
  const buildPath = resolve(outputRoot, new Date().toISOString().replace(/[:.]/g, '-') + '-' + randomBytes(3).toString('hex'));
  mkdirSync(buildPath, { recursive: true });
  copyMiniProgramSources(sourceDir, buildPath);
  writeFileSync(join(buildPath, 'config.js'), '// Reviewed remote test endpoint; credentials are scoped by this URL.\nmodule.exports = '
    + JSON.stringify({ apiBaseUrl }) + ';\n', 'utf8');
  writeFileSync(join(buildPath, 'project.config.json'), JSON.stringify({ ...config,
    description: '受控 HTTPS 内测，登录受名单限制，付款关闭', projectname: 'cabc-club-remote-test', miniprogramRoot: './',
    setting: { ...config.setting, urlCheck: true }, packOptions: { ignore: [], include: [] } }, null, 2) + '\n', 'utf8');
  writeFileSync(join(buildPath, 'project.private.config.json'), JSON.stringify({ setting: { urlCheck: true } }, null, 2) + '\n', 'utf8');
  return { createdAt: new Date().toISOString(), mode: 'remote-trial', appId: config.appid, apiBaseUrl, buildPath,
    phoneVerified: false, domainConfigured: false, loginVerified: false };
}
if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    if (process.argv.length !== 2) throw new Error('此构建入口不接受运行时地址覆盖');
    const manifest = prepareRemoteMiniProgram();
    writeFileSync(join(projectRoot, 'work/wechat/remote-project.json'), JSON.stringify(manifest, null, 2) + '\n', 'utf8');
    console.log(JSON.stringify(manifest));
  } catch (error) { console.error(error.message); process.exitCode = 1; }
}
