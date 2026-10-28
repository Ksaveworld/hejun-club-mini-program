import {randomBytes,sign,verify,createDecipheriv,createPrivateKey,createPublicKey} from 'node:crypto';
import {BusinessError,requireRule} from './domain.mjs';

export function merchantOrderId(id){
  // Existing business IDs are HJ + UUID(32), longer than WeChat's 32-character limit.
  // Preserve the full 128-bit UUID; never truncate entropy or rewrite historical orders.
  requireRule(typeof id==='string'&&/^HJ[A-F0-9]{32}$/.test(id),'订单编号不适用于微信支付');
  return id.slice(2);
}

// Ordinary merchant API v3. Secrets are explicit server-only inputs; never read client configuration.
export function createWechatPay(config,{fetchImpl=globalThis.fetch,clock=Date.now}={}){
  if(!config)return {configured:false};
  const {appId,merchantId,merchantSerial,privateKey,apiV3Key,verificationKeys,notifyUrl,wechatPayPublicKeyId}=config;
  requireRule(/^wx[a-f0-9]{16}$/.test(appId)&&/^\d{6,32}$/.test(merchantId)&&/^[A-Fa-f0-9]{8,64}$/.test(merchantSerial),'微信支付商户配置不完整',503);
  const callback=new URL(notifyUrl);
  requireRule(callback.protocol==='https:'&&!callback.username&&!callback.password&&!callback.search&&!callback.hash&&callback.pathname.endsWith('/api/payments/wechat/notify'),'支付回调地址不正确',503);
  requireRule(typeof apiV3Key==='string'&&Buffer.byteLength(apiV3Key)===32,'微信支付APIv3密钥配置不完整',503);
  const merchantKey=createPrivateKey(privateKey),keys=new Map(Object.entries(verificationKeys||{}).map(([id,key])=>[id,createPublicKey(key)]));
  requireRule(merchantKey.asymmetricKeyType==='rsa'&&keys.size>0&&[...keys.values()].every(key=>key.asymmetricKeyType==='rsa'),'支付签名密钥配置不正确',503);
  const publicKeyIds=[...keys.keys()].filter(id=>id.startsWith('PUB_KEY_ID_'));
  const responseKeyId=wechatPayPublicKeyId??(publicKeyIds.length===1?publicKeyIds[0]:null);
  requireRule(publicKeyIds.every(id=>/^PUB_KEY_ID_\d{10,64}$/.test(id))&&(wechatPayPublicKeyId===undefined?publicKeyIds.length<=1:publicKeyIds.includes(wechatPayPublicKeyId)),'微信支付公钥ID配置不正确',503);
  const nonce=()=>randomBytes(16).toString('hex'),timestamp=()=>String(Math.floor(clock()/1000));
  const signed=message=>sign('RSA-SHA256',Buffer.from(message),merchantKey).toString('base64');
  function verifyMessage(headers,body){
    const get=name=>typeof headers.get==='function'?headers.get(name):headers[name.toLowerCase()];
    const time=get('Wechatpay-Timestamp'),random=get('Wechatpay-Nonce'),signature=get('Wechatpay-Signature'),key=keys.get(get('Wechatpay-Serial'));
    requireRule(typeof time==='string'&&/^\d{10}$/.test(time)&&Math.abs(clock()/1000-Number(time))<=300&&typeof random==='string'&&random.length>0&&random.length<=128&&typeof signature==='string'&&/^[A-Za-z0-9+/]+={0,2}$/.test(signature)&&key,'支付结果签名校验失败',502);
    requireRule(verify('RSA-SHA256',Buffer.from(`${time}\n${random}\n${body}\n`),key,Buffer.from(signature,'base64')),'支付结果签名校验失败',502);
  }
  async function call(method,path,data){
    const body=data===undefined?'':JSON.stringify(data),time=timestamp(),random=nonce();
    const signature=signed(`${method}\n${path}\n${time}\n${random}\n${body}\n`);
    let response,raw;
    try{
      // Select public-key response signatures; the merchant certificate serial stays in Authorization.
      response=await fetchImpl('https://api.mch.weixin.qq.com'+path,{method,redirect:'error',signal:AbortSignal.timeout(3500),headers:{Accept:'application/json','Content-Type':'application/json',...(responseKeyId?{'Wechatpay-Serial':responseKeyId}:{}),Authorization:`WECHATPAY2-SHA256-RSA2048 mchid="${merchantId}",nonce_str="${random}",timestamp="${time}",serial_no="${merchantSerial}",signature="${signature}"`},...(body?{body}:{})});
      raw=await response.text();
    }catch{throw new BusinessError('微信支付暂时无法确认，请稍后刷新支付结果，勿重复付款',503);}
    verifyMessage(response.headers,raw);
    let value;try{value=raw?JSON.parse(raw):{};}catch{throw new BusinessError('微信支付返回异常',502);}
    if(!response.ok)throw Object.assign(new BusinessError('微信支付请求未完成，请刷新订单或联系工作人员',502),{providerCode:/^[A-Z_]{1,60}$/.test(value.code)?value.code:null});
    return value;
  }
  return {
    configured:true,appId,merchantId,
    async prepay(order,openId){
      const result=await call('POST','/v3/pay/transactions/jsapi',{appid:appId,mchid:merchantId,description:'跨境企业家俱乐部会员服务',out_trade_no:merchantOrderId(order.id),notify_url:notifyUrl,amount:{total:order.amount_cents,currency:'CNY'},payer:{openid:openId}});
      requireRule(typeof result.prepay_id==='string'&&/^[A-Za-z0-9_-]{1,128}$/.test(result.prepay_id),'微信支付预支付结果异常',502);
      const timeStamp=timestamp(),nonceStr=nonce(),packageValue='prepay_id='+result.prepay_id;
      return {timeStamp,nonceStr,package:packageValue,signType:'RSA',paySign:signed(`${appId}\n${timeStamp}\n${nonceStr}\n${packageValue}\n`)};
    },
    query:orderId=>call('GET',`/v3/pay/transactions/out-trade-no/${merchantOrderId(orderId)}?mchid=${merchantId}`),
    async close(orderId){await call('POST',`/v3/pay/transactions/out-trade-no/${merchantOrderId(orderId)}/close`,{mchid:merchantId});},
    decodeNotification(headers,raw){
      verifyMessage(headers,raw);
      try{
        const event=JSON.parse(raw),resource=event.resource;
        requireRule(event.event_type==='TRANSACTION.SUCCESS'&&event.resource_type==='encrypt-resource'&&resource.algorithm==='AEAD_AES_256_GCM'&&resource.original_type==='transaction','不支持的支付通知');
        const bytes=Buffer.from(resource.ciphertext,'base64');requireRule(bytes.length>16,'支付通知内容不完整');
        const decipher=createDecipheriv('aes-256-gcm',Buffer.from(apiV3Key),Buffer.from(resource.nonce));
        decipher.setAuthTag(bytes.subarray(-16));decipher.setAAD(Buffer.from(resource.associated_data||''));
        return JSON.parse(Buffer.concat([decipher.update(bytes.subarray(0,-16)),decipher.final()]).toString('utf8'));
      }catch{throw new BusinessError('支付通知解密校验失败',400);}
    }
  };
}
