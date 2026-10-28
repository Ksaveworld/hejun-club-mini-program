// Official getUnlimitedQRCode: page has no leading slash/query; scene is public.
// Authenticated routing, eligibility, quotas and approved release selection stay
// with the application. This adapter never grants referral/reward membership.
export class InviteCodeError extends Error {
  constructor(message,status=503,code='INVITE_CODE_UNAVAILABLE') {super(message);this.status=status;this.code=code;}
}
const need=(condition,message,status=503,code)=>{if(!condition)throw new InviteCodeError(message,status,code);};
const page='pages/home/index',maxBytes=512*1024;
export function createNativeInviteCode(config,{fetchImpl,getAccessToken,getMember,clock=Date.now,timeoutMs=8000}={}) {
  if(!config||config.enabled!==true)return Object.freeze({configured:false});
  const {appId,envVersion,checkPath}=config;
  need(/^wx[a-f0-9]{16}$/.test(appId||'')&&['release','trial','develop'].includes(envVersion)
    &&typeof checkPath==='boolean','邀请扫码环境尚未明确配置',503,'INVITE_CODE_CONFIG_INVALID');
  // A historical public package may contain the page but not parse referral
  // scene. check_path cannot establish that the current release supports R06.
  if(envVersion==='release'&&config.releaseEntryVerified!==true)return Object.freeze({configured:false});
  need(typeof fetchImpl==='function'&&typeof getAccessToken==='function'&&typeof getMember==='function'
    &&typeof clock==='function'&&Number.isSafeInteger(timeoutMs)&&timeoutMs>0&&timeoutMs<=30000,
    '邀请扫码服务依赖未配置',503,'INVITE_CODE_CONFIG_INVALID');
  const cache=new Map(),ttl=10*60*1000;
  async function generate(code) {
    let token;
    try{token=await getAccessToken({appId});}catch{throw new InviteCodeError('邀请扫码服务暂不可用，请稍后重试');}
    need(token?.appId===appId&&typeof token.accessToken==='string'&&token.accessToken.length>0&&token.accessToken.length<=4096
      &&!/[\s\x00-\x1f\x7f]/.test(token.accessToken),'邀请扫码接口凭证未核实');
    const url=new URL('https://api.weixin.qq.com/wxa/getwxacodeunlimit');url.searchParams.set('access_token',token.accessToken);
    let bytes,response;
    try {
      response=await fetchImpl(url,{method:'POST',redirect:'error',signal:AbortSignal.timeout(timeoutMs),
        headers:{'Content-Type':'application/json',Accept:'image/png,image/jpeg'},
        body:JSON.stringify({scene:code,page,check_path:checkPath,env_version:envVersion,width:430,
          auto_color:false,line_color:{r:0,g:0,b:0},is_hyaline:false})});
      const length=Number(response.headers.get('content-length'));
      if(length>maxBytes)throw Error('oversized');
      bytes=Buffer.from(await response.arrayBuffer());
    }catch{throw new InviteCodeError('官方小程序码暂未生成，请稍后重试');}
    need(response.ok&&bytes.length>0&&bytes.length<=maxBytes,'官方小程序码暂未生成，请稍后重试');
    // Upstream failures are JSON. Do not reflect its errmsg or token-bearing URL.
    const png=bytes.length>=33&&bytes.subarray(0,8).equals(Buffer.from([137,80,78,71,13,10,26,10]))
      &&bytes.toString('ascii',12,16)==='IHDR';
    const jpeg=bytes.length>=4&&bytes[0]===255&&bytes[1]===216&&bytes[2]===255&&bytes.at(-2)===255&&bytes.at(-1)===217;
    need(png||jpeg,'官方小程序码返回异常，请稍后重试');
    return Object.freeze({code,contentType:png?'image/png':'image/jpeg',imageBase64:bytes.toString('base64')});
  }
  return Object.freeze({configured:true,appId,envVersion,page,
    async generate(actor) {
      need(typeof actor?.id==='string'&&actor.id.length>0&&actor.id.length<=128,'请先登录会员账号',401,'INVITE_CODE_AUTH_REQUIRED');
      const user=await getMember(actor.id);
      need(user?.id===actor.id&&user.role==='member'&&/^[A-Z0-9]{6}$/.test(user.referralCode||''),
        '请使用现有会员账号生成邀请图片',403,'INVITE_CODE_MEMBER_REQUIRED');
      const key=user.referralCode,cached=cache.get(key);
      if(cached&&cached.until>clock())return cached.promise;
      const entry={until:clock()+ttl,promise:null};
      entry.promise=generate(key).catch(error=>{if(cache.get(key)===entry)cache.delete(key);throw error;});
      cache.delete(key);cache.set(key,entry);
      if(cache.size>256)cache.delete(cache.keys().next().value);
      return entry.promise;
    }
  });
}
