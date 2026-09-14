import { copyFileSync, existsSync, lstatSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from 'node:fs';
import { resolve, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { randomBytes } from 'node:crypto';
import { isPrivateIPv4 } from '../server/lan-network.mjs';

const projectRoot = fileURLToPath(new URL('../', import.meta.url));
const roots = ['app.js', 'app.json', 'app.wxss', 'sitemap.json', 'assets', 'data', 'pages', 'utils'];
const allowedExtension = /\.(?:js|json|wxml|wxss|png|jpg|jpeg|svg)$/i;
function copySource(source, target) {
  const stat = lstatSync(source);
  if (stat.isSymbolicLink()) throw new Error('测试包不允许链接文件：' + source);
  if (stat.isDirectory()) {
    mkdirSync(target, { recursive: true });
    for (const name of readdirSync(source)) {
      if (name.startsWith('.') || !allowedExtension.test(name) && !lstatSync(join(source, name)).isDirectory()) continue;
      copySource(join(source, name), join(target, name));
    }
  } else if (stat.isFile() && allowedExtension.test(source)) copyFileSync(source, target);
  else throw new Error('不支持的小程序源文件：' + source);
}
export function copyMiniProgramSources(sourceDir, buildPath) {
  for (const name of roots) {
    const source = join(sourceDir, name);
    if (!existsSync(source)) throw new Error('小程序源文件缺失：' + name);
    copySource(source, join(buildPath, name));
  }
}

export function prepareLanMiniProgram({ address, sourceDir = join(projectRoot, 'miniprogram'), outputRoot = join(projectRoot, 'work/wechat/lan-builds') }) {
  if (!isPrivateIPv4(address)) throw new Error('手机内测地址必须为明确的私有 IPv4 地址');
  const config = JSON.parse(readFileSync(join(sourceDir, 'project.config.json'), 'utf8'));
  if (!/^wx[0-9a-f]{16}$/i.test(config.appid)) throw new Error('缺少有效测试 AppID');
  const buildId = new Date().toISOString().replace(/[:.]/g, '-') + '-' + randomBytes(3).toString('hex');
  const buildPath = resolve(outputRoot, buildId);
  mkdirSync(buildPath, { recursive: true });
  copyMiniProgramSources(sourceDir, buildPath);
  const apiBaseUrl = 'http://' + address + ':5198/api';
  writeFileSync(join(buildPath, 'config.js'), '// Generated only for a same-Wi-Fi development preview.\nmodule.exports = ' + JSON.stringify({ apiBaseUrl }) + ';\n', 'utf8');
  const buildConfig = { ...config, description: '同 Wi-Fi 手机开发内测，支付关闭', projectname: 'cabc-club-lan-test', miniprogramRoot: './',
    setting: { ...config.setting, urlCheck: true }, packOptions: { ignore: [], include: [] } };
  writeFileSync(join(buildPath, 'project.config.json'), JSON.stringify(buildConfig, null, 2) + '\n', 'utf8');
  // A simulator runs on the server's computer; this local IDE setting does not
  // replace the phone's separate same-subnet network acceptance.
  writeFileSync(join(buildPath, 'project.private.config.json'), JSON.stringify({ setting: { urlCheck: false } }, null, 2) + '\n', 'utf8');
  const manifest = { createdAt: new Date().toISOString(), appId: config.appid, address, apiBaseUrl, buildPath, phoneVerified: false };
  return manifest;
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    if (process.argv.length !== 4 || process.argv[2] !== '--address') throw new Error('用法：node scripts/prepare-lan-miniprogram.mjs --address <局域网IPv4>');
    const result = prepareLanMiniProgram({ address: process.argv[3] });
    const manifestPath = join(projectRoot, 'work/wechat/lan-project.json');
    writeFileSync(manifestPath, JSON.stringify(result, null, 2) + '\n', 'utf8');
    console.log(JSON.stringify(result));
  } catch (error) { console.error(error.message); process.exitCode = 1; }
}
