import { isIP } from 'node:net';
import { BusinessError } from './domain.mjs';

function origin(value) {
  let url;
  try { url = new URL(value); } catch { throw new Error('远程测试需要明确的 HTTPS 域名'); }
  if (url.protocol !== 'https:' || url.origin !== value || url.port || url.username || url.password
    || isIP(url.hostname) || !/^[a-z0-9](?:[a-z0-9.-]*[a-z0-9])?\.[a-z]{2,}$/.test(url.hostname))
    throw new Error('远程地址必须是无路径、端口和凭据的 HTTPS 域名');
  return url;
}
export function normalizedIp(value) {
  if (typeof value !== 'string' || !isIP(value)) return null;
  if (value.startsWith('::ffff:') && isIP(value.slice(7)) === 4) return value.slice(7);
  return isIP(value) === 6 ? new URL(`http://[${value}]/`).hostname.slice(1, -1) : value;
}

export function createRemotePolicy(config) {
  if (!config || config.mode !== 'remote-trial') throw new Error('须明确选择 remote-trial 测试模式');
  const api = origin(config.apiOrigin);
  const admin = config.adminOrigin ? origin(config.adminOrigin) : null;
  if (admin && admin.hostname === api.hostname) throw new Error('管理后台必须使用独立域名');
  if (config.adminIps !== undefined && !Array.isArray(config.adminIps)) throw new Error('管理员来源名单必须是数组');
  const adminIps = new Set((config.adminIps ?? []).map(value => {
    const ip = normalizedIp(value);
    if (!ip) throw new Error('管理员来源必须是明确的 IP，不能使用范围或通配符');
    return ip;
  }));
  if (admin && !adminIps.size) throw new Error('管理入口需要管理员来源 IP 名单');
  if (!/^wx[a-f0-9]{16}$/.test(config.wechat?.appId ?? '')) throw new Error('请配置有效的小程序 AppID');
  if (!Array.isArray(config.wechat.openIds) || config.wechat.openIds.length > 100)
    throw new Error('请提供最多 100 个受邀微信身份，未配置时使用空名单');
  const openIds = new Set(config.wechat.openIds.map(value => {
    if (typeof value !== 'string' || !/^[a-zA-Z0-9_-]{1,128}$/.test(value)) throw new Error('受邀微信身份格式不正确');
    return value;
  }));
  const appId = config.wechat.appId;
  return Object.freeze({
    apiOrigin: api.origin, adminOrigin: admin?.origin ?? null, appId,
    hosts: Object.freeze([api.host, ...(admin ? [admin.host] : [])]),
    origins: Object.freeze([api.origin, ...(admin ? [admin.origin] : [])]),
    invited: openIds.size > 0,
    allowsIdentity(identity) { return identity?.appId === appId && openIds.has(identity.openId); },
    checkRequest(req, path) {
      if (normalizedIp(req.socket.remoteAddress) !== '127.0.0.1')
        throw new BusinessError('仅接受本机 HTTPS 入口转发', 403);
      const clientIp = normalizedIp(req.headers['x-real-ip']);
      if (!clientIp || req.headers['x-forwarded-proto'] !== 'https')
        throw new BusinessError('HTTPS 转发信息不完整', 403);
      const isAdmin = admin && req.headers.host === admin.host;
      if (isAdmin && !adminIps.has(clientIp)) throw new BusinessError('管理入口暂未向此来源开放', 403);
      if ((path.startsWith('/api/auth/') || path.startsWith('/api/admin/')) && !isAdmin)
        throw new BusinessError('接口不存在', 404);
      if (isAdmin && (path.startsWith('/api/native/') || req.headers.authorization !== undefined))
        throw new BusinessError('请使用小程序专用接口地址', 403);
      if (req.headers.origin && req.headers.origin !== (isAdmin ? admin.origin : api.origin))
        throw new BusinessError('请求来源不受支持', 403);
      return { clientIp, isAdmin: !!isAdmin };
    },
  });
}
