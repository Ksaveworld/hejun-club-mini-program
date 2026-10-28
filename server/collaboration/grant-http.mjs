import {randomUUID} from 'node:crypto';

const prefix='/api/admin/membership-grants';
const bodyLimit=16384;
const errors={
  INVALID_REQUEST:[400,'请求格式不正确'],AUTH_AMBIGUOUS:[400,'请仅使用后台会话身份'],
  AUTH_REQUIRED:[401,'请重新登录管理后台'],FORBIDDEN:[403,'无权执行此操作'],
  ACCOUNT_DISABLED:[403,'当前账号不可用'],OPERATIONAL_ACCOUNT:[403,'运营账号不能作为受赠账号'],
  ORIGIN_REJECTED:[403,'请求来源不受支持'],CSRF_REJECTED:[403,'缺少有效请求校验'],
  ACTOR_CHANGED:[409,'当前账号已变化，请刷新后重试'],NOT_FOUND:[404,'请求对象不可用'],
  USER_UNAVAILABLE:[404,'消费账号不可用'],METHOD_NOT_ALLOWED:[405,'不支持此请求方法'],
  PAYLOAD_TOO_LARGE:[413,'请求内容过大'],UNSUPPORTED_MEDIA_TYPE:[415,'请使用JSON请求'],
  BUSINESS_DECISIONS_UNCONFIRMED:[409,'业务策略尚未确认'],PREFLIGHT_BLOCKED:[409,'预检未通过，请重新核对'],
  PREFLIGHT_CHANGED:[409,'核对信息已变化，请重新预检'],IDEMPOTENCY_CONFLICT:[409,'提交编号已用于另一请求'],
  CONFIRMATION_INVALID:[409,'确认凭据无效，请重新预检'],CONFIRMATION_EXPIRED:[409,'确认凭据已过期，请重新预检'],
  FEATURE_DISABLED:[503,'赠送写入入口暂未开放'],WRITE_COORDINATION_REQUIRED:[503,'赠送写入条件尚未就绪'],
  CONFIRMATION_NOT_CONFIGURED:[503,'确认服务尚未就绪'],CLOCK_UNAVAILABLE:[503,'服务时钟不可用'],
  ENTITLEMENT_DATA_INVALID:[503,'权益数据需核查'],MIGRATION_NOT_READY:[503,'赠送数据结构尚未就绪'],
  GRANT_MIGRATION_INCONSISTENT:[503,'赠送数据结构需核查'],
  DATABASE_UNAVAILABLE:[503,'请求结果暂不能确认，请按原提交编号查询；不要更换编号重发'],
  INTERNAL_ERROR:[500,'服务暂时无法完成请求，请保留请求编号']
};
const transientCodes=new Set(['40001','40P01','55P03','57014','57P01','57P02','57P03',
  'ECONNRESET','ECONNREFUSED','EPIPE','ETIMEDOUT','ENETUNREACH','EHOSTUNREACH','ERR_STREAM_DESTROYED']);
function publicErrorCode(error){
  if(Object.hasOwn(errors,error?.code))return error.code;
  if(error?.code==='42P01')return 'MIGRATION_NOT_READY';
  if(transientCodes.has(error?.code)||/^08[0-9A-Z]{3}$/.test(error?.code??'')||
    ['Connection terminated unexpectedly','Connection terminated','Connection terminated due to connection timeout',
      'timeout exceeded when trying to connect'].includes(error?.message))return 'DATABASE_UNAVAILABLE';
  return error?.status===400&&!error?.code?'INVALID_REQUEST':'INTERNAL_ERROR';
}
function reject(code){throw Object.assign(new Error(code),{code});}
function send(res,status,value){
  if(res.destroyed||res.writableEnded)return;
  res.writeHead(status,{'content-type':'application/json; charset=utf-8','cache-control':'no-store','x-content-type-options':'nosniff'});
  res.end(JSON.stringify(value));
}
function body(req){
  if(typeof req.headers['content-type']!=='string'||req.headers['content-type'].split(';')[0].trim().toLowerCase()!=='application/json') {
    req.resume();reject('UNSUPPORTED_MEDIA_TYPE');
  }
  if(req.headers['content-length']!==undefined && (!/^\d+$/.test(req.headers['content-length']) || Number(req.headers['content-length'])>bodyLimit)) {
    req.resume();reject('PAYLOAD_TOO_LARGE');
  }
  return new Promise((resolve,rejectPromise)=>{
    let size=0,failed=false;const chunks=[];
    req.on('data',chunk=>{
      if(failed)return;
      size+=chunk.length;
      if(size>bodyLimit){failed=true;chunks.length=0;rejectPromise(Object.assign(new Error('PAYLOAD_TOO_LARGE'),{code:'PAYLOAD_TOO_LARGE'}));return;}
      chunks.push(chunk);
    });
    req.on('error',()=>{if(!failed){failed=true;rejectPromise(Object.assign(new Error('INVALID_REQUEST'),{code:'INVALID_REQUEST'}));}});
    req.on('end',()=>{
      if(failed)return;
      try {
        const value=JSON.parse(Buffer.concat(chunks).toString('utf8'));
        if(value===null||typeof value!=='object'||Array.isArray(value)||Object.getPrototypeOf(value)!==Object.prototype)reject('INVALID_REQUEST');
        resolve(value);
      } catch {rejectPromise(Object.assign(new Error('INVALID_REQUEST'),{code:'INVALID_REQUEST'}));}
    });
  });
}

// This is an isolated adapter. The integrator mounts it before the shared host
// application's fallback route and continues to own production wiring/config.
export function createGrantHttpHandler({access,grants,adminOrigin}) {
  const origin=new URL(adminOrigin);
  if(!(origin.protocol==='https:'||(origin.protocol==='http:'&&['127.0.0.1','localhost'].includes(origin.hostname)))||origin.username||origin.password||origin.pathname!=='/'||origin.search||origin.hash)throw new Error('An explicit HTTPS administrator origin or HTTP loopback origin is required');
  if(!access?.run||!access?.authenticateInTransaction||!grants)throw new Error('Grant service and session access are required');
  return async (req,res)=>{
    let url;
    try{url=new URL(req.url,origin.origin);}catch{return false;}
    if(url.pathname!==prefix&&!url.pathname.startsWith(prefix+'/'))return false;
    const requestId=randomUUID(),method=req.method;
    try {
      if(req.headers.host!==origin.host||req.headers.authorization!==undefined||req.headers['sec-fetch-site']==='cross-site')reject('ORIGIN_REJECTED');
      if(req.headers.origin!==undefined&&req.headers.origin!==origin.origin)reject('ORIGIN_REJECTED');
      if(method==='POST'&&(req.headers.origin!==origin.origin||req.headers['x-club-request']!=='1'))reject('CSRF_REJECTED');
      const actor=await access.run(c=>access.authenticateInTransaction(c,req,{write:method==='POST'}));
      if(actor.role!=='admin')reject('FORBIDDEN');
      const route=url.pathname.slice(prefix.length),revoke=/^\/([^/]+)\/revoke$/.exec(route),operation=/^\/operations\/([^/]+)$/.exec(route);
      if(route!==''&&route!=='/lookup'&&route!=='/preflight'&&!revoke&&!operation)reject('NOT_FOUND');
      if((route===''&&!['GET','POST'].includes(method))||(operation&&method!=='GET')||(route!==''&&!operation&&method!=='POST'))reject('METHOD_NOT_ALLOWED');
      const filters={};
      for(const [key,value] of url.searchParams) {
        if(method!=='GET'||route!==''||!['userId','status','cursor','limit'].includes(key)||Object.hasOwn(filters,key))reject('INVALID_REQUEST');
        filters[key]=value;
      }
      let value;
      if(operation){let key;try{key=decodeURIComponent(operation[1]);}catch{reject('INVALID_REQUEST');}value=await grants.operation(actor,key);}
      else if(method==='GET')value=await grants.list(actor,filters);
      else {
        const input=await body(req);
        if(route==='/lookup')value=await grants.lookup(actor,input);
        else if(route==='/preflight')value=await grants.preflight(actor,input);
        else if(revoke){let id;try{id=decodeURIComponent(revoke[1]);}catch{reject('INVALID_REQUEST');}value=await grants.revoke(actor,id,input);}
        else value=await grants.issue(actor,input);
      }
      send(res,200,value);
    } catch(error) {
      // SQL text, raw driver errors, credentials and resolver data never cross
      // this boundary. Even known codes use fixed messages, not error.message.
      const code=publicErrorCode(error);
      const [status,message]=errors[code];send(res,status,{code,message,requestId});
    }
    return true;
  };
}
