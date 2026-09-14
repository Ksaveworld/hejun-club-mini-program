import { BusinessError } from './domain.mjs';
import { normalizedIp } from './remote-policy.mjs';
export function createWebPolicy(config) {
  if(config?.mode !== 'web-trial' || config.origin !== 'https://example.com') throw new Error('网页业务体验需要明确的 HTTPS 入口');
  return {
    hosts:['example.com'], origins:[config.origin], cookiePath:'/hejun-club/api',
    checkRequest(req,path) {
      if(normalizedIp(req.socket.remoteAddress)!=='127.0.0.1' || req.headers['x-forwarded-proto']!=='https' || !normalizedIp(req.headers['x-real-ip']))
        throw new BusinessError('仅接受本机 HTTPS 入口转发',403);
      if(path.startsWith('/api/native/') || req.headers.authorization!==undefined) throw new BusinessError('请使用网页账号入口',403);
      if(req.method!=='GET' && req.headers.origin!==config.origin) throw new BusinessError('请求来源不受支持',403);
      return {clientIp:normalizedIp(req.headers['x-real-ip'])};
    }
  };
}
