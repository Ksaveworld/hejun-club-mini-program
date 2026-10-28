import {requireRule} from './domain.mjs';

const windowMs=60000;
// One-minute fixed windows keyed by scope and server-verified principal,
// falling back to direct socket address for anonymous requests.
// Forwarded headers are never trusted here. A full table rejects new keys while
// existing keys keep counting; expired windows release capacity.
export function createPostgresRateLimiter({now=()=>Date.now(),capacity=10000}={}){
  if(typeof now!=='function'||!Number.isSafeInteger(capacity)||capacity<1)throw new Error('限流配置不正确');
  const entries=new Map(),principals=new WeakMap();
  function limit(req,scope,max){
    const time=now();
    for(const [key,value] of entries)if(value.until<=time)entries.delete(key);
    const key=JSON.stringify([scope,principals.get(req)??['socket',req.socket?.remoteAddress??'unknown']]);
    requireRule(entries.has(key)||entries.size<capacity,'服务繁忙，请稍后重试',429);
    const value=entries.get(key)??{n:0,until:time+windowMs};
    value.n++;entries.set(key,value);
    requireRule(value.n<=max,'操作过于频繁，请稍后重试',429);
  }
  // Bind only identities returned by server authentication, never client hints.
  limit.bind=(req,kind,id)=>{
    requireRule(['member','admin','wechat'].includes(kind)&&typeof id==='string'&&id.length>0&&id.length<=512,'限流身份不正确',500);
    principals.set(req,[kind,id]);
  };
  return limit;
}

// Pre-authentication work has no trustworthy user identity. Bound concurrency
// and waiting work without imposing a shared proxy-IP quota on distinct users.
export function createLoginAdmission({concurrency=8,capacity=128,waitMs=8000}={}){
  for(const value of [concurrency,capacity,waitMs])if(!Number.isSafeInteger(value)||value<1)throw new Error('登录准入配置不正确');
  let active=0;const queue=[];
  const busy=()=>Object.assign(new Error('登录繁忙，请稍后重试'),{status:503});
  function drain(){while(active<concurrency&&queue.length){const item=queue.shift();active++;item.start();}}
  return async function admit(req,task,res){
    requireRule(!req.aborted,'登录请求已结束',400);
    if(active<concurrency)active++;
    else {
      if(queue.length>=capacity)throw busy();
      await new Promise((resolve,reject)=>{
        let timer;
        const cleanup=()=>{clearTimeout(timer);req.off?.('aborted',abort);res?.off('close',abort);};
        const remove=error=>{const index=queue.indexOf(item);if(index<0)return;queue.splice(index,1);cleanup();reject(error);};
        const abort=()=>remove(Object.assign(new Error('登录请求已结束'),{status:400}));
        const item={start:()=>{cleanup();resolve();}};
        queue.push(item);req.once?.('aborted',abort);res?.once('close',abort);timer=setTimeout(()=>remove(busy()),waitMs);
      });
    }
    try{return await task();}finally{active--;drain();}
  };
}
