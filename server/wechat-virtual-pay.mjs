import {createHmac, timingSafeEqual} from 'node:crypto';

// References: official requestVirtualPayment/query_order/notify_provide_goods
// documents, checked 2026-10-28. This module has no DB or HTTP routes.
const QUERY = '/xpay/query_order', DELIVER = '/xpay/notify_provide_goods';
const BINDING_DOMAIN = 'club-virtual-order-v1&';
const BINDING_FIELDS = ['version','appId','offerId','env','orderId','outTradeNo','userId','openId',
  'planId','productId','goodsPrice','buyQuantity','amountCents','currencyType','attach','createdAt'];
const PAID_STATUSES = new Set([2,3,4]);
const PAYMENT_TYPES = new Set([0,7]);

export class VirtualPaymentError extends Error {
  constructor(message, status=400, code='VIRTUAL_PAYMENT_INVALID', providerCode) {
    super(message); this.status=status; this.code=code;
    if (Number.isSafeInteger(providerCode)) this.providerCode=providerCode;
  }
}
function need(condition,message,status=400,code) {
  if(!condition)throw new VirtualPaymentError(message,status,code);
}
function object(value){return value!==null&&typeof value==='object'&&!Array.isArray(value);}
function text(value,max=128){return typeof value==='string'&&value.length>0&&value.length<=max&&!/[\s\x00-\x1f\x7f]/.test(value);}
function cents(value){return Number.isSafeInteger(value)&&value>0;}
function hmac(key,message){return createHmac('sha256',key).update(message,'utf8').digest('hex');}
function equalHex(actual,expected){return typeof actual==='string'&&/^[a-f0-9]{64}$/.test(actual)&&timingSafeEqual(Buffer.from(actual,'hex'),Buffer.from(expected,'hex'));}
function orderNumber(id){
  // Preserve the complete existing UUID; the official outTradeNo limit is 8-32.
  need(typeof id==='string'&&/^HJ[A-F0-9]{32}$/.test(id),'订单编号不适用于虚拟支付');
  return id.slice(2);
}
function paymentData(binding){
  return JSON.stringify({offerId:binding.offerId,buyQuantity:binding.buyQuantity,env:binding.env,
    currencyType:binding.currencyType,productId:binding.productId,goodsPrice:binding.goodsPrice,
    outTradeNo:binding.outTradeNo,attach:binding.attach});
}

/**
 * Server-only inputs. getAccessToken({appId}) must return {appId, accessToken}.
 * prepare(order, identity) returns {payment, attempt}; expose ONLY payment to wx.
 * Persist attempt with the business order; query/confirmDelivery require that
 * server-owned snapshot and an independently authenticated owner identity.
 */
export function createWechatVirtualPay(config,{fetchImpl,getAccessToken,clock=Date.now,timeoutMs=3500}={}) {
  if(!config||config.enabled===false)return Object.freeze({configured:false});
  const {appId,offerId,env}=config;
  const validConfig=(condition,message)=>need(condition,message,503,'VIRTUAL_CONFIG_INVALID');
  validConfig(config.enabled===true&&typeof appId==='string'&&/^wx[a-f0-9]{16}$/.test(appId)
    &&text(offerId)&&[0,1].includes(env),'虚拟支付基础配置不完整');
  validConfig(object(config.appKeys)&&text(config.appKeys[env],512),'当前环境的虚拟支付AppKey尚未配置');
  if(config.appKeys[0]!==undefined&&config.appKeys[1]!==undefined)
    validConfig(text(config.appKeys[0],512)&&text(config.appKeys[1],512)&&config.appKeys[0]!==config.appKeys[1],
      '虚拟支付现网与沙箱密钥必须分别配置');
  const appKey=config.appKeys[env];
  validConfig(typeof fetchImpl==='function'&&typeof getAccessToken==='function'&&typeof clock==='function'
    &&Number.isSafeInteger(timeoutMs)&&timeoutMs>0&&timeoutMs<=30000,'虚拟支付服务依赖不完整');
  validConfig(object(config.products)&&Object.keys(config.products).length===2
    &&['basic','star'].every(id=>Object.hasOwn(config.products,id)),'请配置基础及星级会员对应的虚拟商品');
  const products=new Map();
  for(const planId of ['basic','star']) {
    const product=config.products[planId];
    validConfig(object(product)&&text(product.productId)&&cents(product.goodsPriceCents),'虚拟商品或价格配置不正确');
    products.set(planId,Object.freeze({productId:product.productId,goodsPriceCents:product.goodsPriceCents}));
  }
  validConfig(products.get('basic').productId!==products.get('star').productId,'会员档位必须使用独立虚拟商品');
  function owner(identity,session=false) {
    need(object(identity)&&identity.appId===appId&&text(identity.userId)
      &&typeof identity.openId==='string'&&/^[A-Za-z0-9_-]{1,128}$/.test(identity.openId),'虚拟支付身份未核实',403,'VIRTUAL_OWNER_INVALID');
    if(session)need(text(identity.sessionKey,512),'微信支付登录态已失效，请重新登录',401,'VIRTUAL_SESSION_REQUIRED');
  }
  function validateBinding(binding) {
    const product=products.get(binding.planId);
    need(binding.version===1&&binding.appId===appId&&binding.offerId===offerId&&binding.env===env
      &&product&&binding.productId===product.productId&&binding.goodsPrice===product.goodsPriceCents
      &&binding.buyQuantity===1&&binding.amountCents===product.goodsPriceCents&&binding.currencyType==='CNY'
      &&binding.outTradeNo===orderNumber(binding.orderId)&&binding.attach===binding.orderId
      &&Number.isFinite(Date.parse(binding.createdAt)),'虚拟支付订单快照不一致',409,'VIRTUAL_BINDING_INVALID');
  }
  function checkedAttempt(attempt,identity) {
    owner(identity);
    need(object(attempt)&&Object.keys(attempt).length===BINDING_FIELDS.length+1
      &&BINDING_FIELDS.every(field=>Object.hasOwn(attempt,field))&&Object.hasOwn(attempt,'bindingSig'),
      '虚拟支付订单快照不完整',409,'VIRTUAL_BINDING_INVALID');
    const binding=Object.fromEntries(BINDING_FIELDS.map(field=>[field,attempt[field]]));
    need(equalHex(attempt.bindingSig,hmac(appKey,BINDING_DOMAIN+JSON.stringify(binding))),
      '虚拟支付订单快照校验失败',409,'VIRTUAL_BINDING_INVALID');
    validateBinding(binding);
    need(binding.userId===identity.userId&&binding.openId===identity.openId,'不能操作其他账号的虚拟支付订单',403,'VIRTUAL_OWNER_INVALID');
    return binding;
  }
  async function accessToken() {
    let token;
    try {token=await getAccessToken({appId});}
    catch {throw new VirtualPaymentError('虚拟支付接口凭证暂不可用',503,'VIRTUAL_TOKEN_UNAVAILABLE');}
    need(object(token)&&token.appId===appId&&text(token.accessToken,4096),
      '虚拟支付接口凭证与小程序不一致',503,'VIRTUAL_TOKEN_UNAVAILABLE');
    return token.accessToken;
  }
  async function call(path,data,{signed=false,noPayload=false}={}) {
    const body=JSON.stringify(data),token=await accessToken();
    const url=new URL('https://api.weixin.qq.com'+path);
    url.searchParams.set('access_token',token);
    if(signed)url.searchParams.set('pay_sig',hmac(appKey,path+'&'+body));
    let response,raw;
    try {
      response=await fetchImpl(url,{method:'POST',redirect:'error',signal:AbortSignal.timeout(timeoutMs),
        headers:{Accept:'application/json','Content-Type':'application/json'},body});
      raw=await response.text();
    } catch {
      // Upstream errors may contain access_token, appKey or URLs; never expose them.
      throw new VirtualPaymentError('虚拟支付请求结果暂未确认，请稍后查单',503,'VIRTUAL_UPSTREAM_UNAVAILABLE');
    }
    need(typeof raw==='string'&&Buffer.byteLength(raw,'utf8')<=1048576,'虚拟支付返回异常',502,'VIRTUAL_RESPONSE_INVALID');
    let value;
    try {value=raw?JSON.parse(raw):{};}catch {throw new VirtualPaymentError('虚拟支付返回异常',502,'VIRTUAL_RESPONSE_INVALID');}
    need(object(value),'虚拟支付返回异常',502,'VIRTUAL_RESPONSE_INVALID');
    if(!response.ok||(value.errcode!==undefined&&value.errcode!==0))
      throw new VirtualPaymentError('虚拟支付请求未完成，请查单后重试',502,'VIRTUAL_PROVIDER_ERROR',value.errcode);
    // notify_provide_goods documents no return payload. Acceptance is not proof of
    // delivery: confirmDelivery always queries the actual order again afterwards.
    need(noPayload||value.errcode===0,'虚拟支付返回缺少成功状态',502,'VIRTUAL_RESPONSE_INVALID');
    return value;
  }
  async function queryBinding(binding) {
    const value=await call(QUERY,{openid:binding.openId,env,order_id:binding.outTradeNo},{signed:true});
    const remote=value.order;
    // Unpaid or closed states may omit settlement amounts. Preserve them as
    // unknown, never as paid/zero proof; supplied values and other states stay strict.
    const amountsMayBeAbsent=[0,1,6].includes(remote?.status);
    const validAmount=amount=>(amountsMayBeAbsent&&amount===undefined)||(Number.isSafeInteger(amount)&&amount>=0&&amount<=binding.amountCents);
    const checks={
      response:object(remote),orderId:remote?.order_id===binding.outTradeNo,environment:remote?.env_type===env+1,
      orderAmount:remote?.order_fee===binding.amountCents,status:Number.isSafeInteger(remote?.status)&&remote.status>=0&&remote.status<=10,
      orderType:[0,1,7,8].includes(remote?.order_type),paidAmount:validAmount(remote?.paid_fee),
      remainingAmount:validAmount(remote?.left_fee)
    };
    const mismatch=Object.keys(checks).filter(key=>!checks[key]);
    function rejectMismatch(fields){
      const error=new VirtualPaymentError('虚拟支付查询结果与订单不一致',502,'VIRTUAL_ORDER_MISMATCH');
      error.mismatchFields=Object.freeze(fields);
      error.queryState=Object.freeze({status:Number.isSafeInteger(remote?.status)&&remote.status>=0&&remote.status<=10?remote.status:null,
        environment:Number.isSafeInteger(remote?.env_type)&&remote.env_type>=0&&remote.env_type<=2?remote.env_type:null});
      throw error;
    }
    if(mismatch.length)rejectMismatch(mismatch);
    const paid=PAID_STATUSES.has(remote.status)&&PAYMENT_TYPES.has(remote.order_type);
    if(paid){
      const paidChecks={paidTotal:remote.paid_fee===binding.amountCents,
        paidTime:Number.isSafeInteger(remote.paid_time)&&remote.paid_time>0&&remote.paid_time*1000>=Math.floor(Date.parse(binding.createdAt)/1000)*1000&&remote.paid_time*1000<=clock()+300000,
        transaction:text(remote.wx_order_id,256)};
      const paidMismatch=Object.keys(paidChecks).filter(key=>!paidChecks[key]);if(paidMismatch.length)rejectMismatch(paidMismatch);
    }
    // The documented response has no openid or productId; they come exclusively
    // from the server-signed attempt, and openid scopes the official query request.
    return Object.freeze({orderId:binding.orderId,outTradeNo:remote.order_id,env,status:remote.status,orderType:remote.order_type,
      orderFeeCents:remote.order_fee,paidFeeCents:remote.paid_fee===undefined?null:remote.paid_fee,leftFeeCents:remote.left_fee===undefined?null:remote.left_fee,
      paidTimeSeconds:remote.paid_time,provideTimeSeconds:remote.provide_time,wxOrderId:remote.wx_order_id,
      fulfillable:paid&&remote.left_fee===binding.amountCents,delivered:paid&&remote.status===4});
  }
  return Object.freeze({
    configured:true,appId,offerId,env,
    async checkAvailability() {
      // Credential acquisition only: never query, deliver, charge or return the
      // credential. Cached tokens are still validated for this configured AppID.
      await accessToken();return Object.freeze({available:true});
    },
    prepare(order,identity) {
      owner(identity,true);
      need(object(order)&&order.status==='pending'&&order.userId===identity.userId,'当前订单不能发起虚拟支付',409);
      const product=products.get(order.planId);
      need(product&&order.currency==='CNY'&&order.amountCents===product.goodsPriceCents,'会员商品、币种或金额不一致',409);
      need(typeof order.createdAt==='string'&&Number.isFinite(Date.parse(order.createdAt))&&Date.parse(order.createdAt)>0
        &&Date.parse(order.createdAt)<=clock(),'订单创建时间不正确');
      const binding={version:1,appId,offerId,env,orderId:order.id,outTradeNo:orderNumber(order.id),userId:identity.userId,
        openId:identity.openId,planId:order.planId,productId:product.productId,goodsPrice:product.goodsPriceCents,
        buyQuantity:1,amountCents:order.amountCents,currencyType:'CNY',attach:order.id,createdAt:order.createdAt};
      const signData=paymentData(binding);
      const payment=Object.freeze({mode:'short_series_goods',signData,
        paySig:hmac(appKey,'requestVirtualPayment&'+signData),signature:hmac(identity.sessionKey,signData)});
      const attempt=Object.freeze({...binding,bindingSig:hmac(appKey,BINDING_DOMAIN+JSON.stringify(binding))});
      return Object.freeze({payment,attempt});
    },
    query(attempt,identity){return queryBinding(checkedAttempt(attempt,identity));},
    async confirmDelivery(attempt,identity,{fulfillmentCommitted=false}={}) {
      const binding=checkedAttempt(attempt,identity);
      need(fulfillmentCommitted===true,'须先持久化会员权益再确认虚拟商品发货',409,'VIRTUAL_FULFILLMENT_REQUIRED');
      const before=await queryBinding(binding);
      need(before.fulfillable,'虚拟支付尚未核实或已涉及退款，不能确认发货',409,'VIRTUAL_NOT_FULFILLABLE');
      if(before.delivered)return Object.freeze({confirmed:true,alreadyDelivered:true,recovered:false,order:before});
      let notificationError;
      // The endpoint-specific official contract lists access_token only (unlike
      // query_order); do not apply the guide's generic pay_sig rule to this API.
      // https://developers.weixin.qq.com/miniprogram/dev/server/API/VirtualPayment/api_notify_provide_goods.html
      try {await call(DELIVER,{order_id:binding.outTradeNo,env},{noPayload:true});}
      catch(error){notificationError=error;}
      let after;
      try {after=await queryBinding(binding);}catch(error){throw notificationError??error;}
      if(after.fulfillable&&after.delivered)
        return Object.freeze({confirmed:true,alreadyDelivered:false,recovered:!!notificationError,order:after});
      if(notificationError)throw notificationError;
      return Object.freeze({confirmed:false,alreadyDelivered:false,recovered:false,order:after});
    }
    // No close or refund method: refund_order is a separate asynchronous refund
    // operation, not an equivalent of ordinary merchant API v3 order cancellation.
  });
}
