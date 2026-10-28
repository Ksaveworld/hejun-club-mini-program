import {randomBytes} from 'node:crypto';
import {digest, requireRule, hashPassword, insertUser, nowISO, captureReferral} from './domain.mjs';
import {transaction, audit} from './db.mjs';
import {recordLegalConsent} from './legal-consents.mjs';

export const callbackPath='/api/auth/wechat/callback';
const cookiePath='/hejun-club/api/auth/wechat';
export const clearOAuthCookie=`club_oauth=; Path=${cookiePath}; HttpOnly; Secure; SameSite=Lax; Max-Age=0`;
export function createWebWechat(db,config,{origin,legal,fetchImpl=fetch}={}) {
  if(!config)return null;
  if(!/^wx[0-9a-f]{16}$/.test(config.appId)||!/^[0-9a-f]{32}$/.test(config.appSecret)||!origin?.startsWith('https://')||!legal)throw Error('微信网页授权配置不完整');
  db.exec(`CREATE TABLE IF NOT EXISTS web_oauth_states (state_hash TEXT PRIMARY KEY,browser_hash TEXT NOT NULL,expires_at INTEGER NOT NULL,user_id TEXT REFERENCES users(id),payload TEXT NOT NULL); INSERT OR IGNORE INTO schema_version VALUES(13);`);
  const redirectUri=origin+'/hejun-club'+callbackPath;
  return {
    start(body,user){
      requireRule(body.legalConsent?.accepted===true&&body.legalConsent?.hongKongAccepted===true&&body.legalConsent?.releaseId===legal.id&&body.wechatConsent===true,'请阅读并同意微信登录说明及当前协议');
      requireRule(!user||user.role==='member','管理员请使用账号密码登录',403);
      requireRule(typeof body.referral==='string'&&/^[a-zA-Z0-9]{0,6}$/.test(body.referral),'推荐码格式不正确');
      const route=typeof body.returnTo==='string'&&/^\/(?:[a-zA-Z0-9/_?=&-]*)$/.test(body.returnTo)&&!body.returnTo.startsWith('//')&&body.returnTo.length<=250?body.returnTo:'/account';
      const state=randomBytes(24).toString('hex'),browser=randomBytes(32).toString('hex');
      db.prepare('DELETE FROM web_oauth_states WHERE expires_at<=?').run(Date.now());
      requireRule(db.prepare('SELECT COUNT(*) n FROM web_oauth_states').get().n<10000,'登录繁忙，请稍后重试',429);
      db.prepare('INSERT INTO web_oauth_states VALUES(?,?,?,?,?)').run(digest(state),digest(browser),Date.now()+600000,user?.id??null,JSON.stringify({route,referral:body.referral,legalConsent:body.legalConsent,releaseId:legal.id}));
      const url=new URL('https://open.weixin.qq.com/connect/oauth2/authorize');
      url.search=new URLSearchParams({appid:config.appId,redirect_uri:redirectUri,response_type:'code',scope:'snsapi_base',state}).toString();url.hash='wechat_redirect';
      return {url:url.href,cookie:`club_oauth=${browser}; Path=${cookiePath}; HttpOnly; Secure; SameSite=Lax; Max-Age=600`};
    },
    async finish(params,cookies){
      const state=params.get('state'),browser=/(?:^|;\s*)club_oauth=([a-f0-9]{64})(?:;|$)/.exec(cookies??'')?.[1];
      requireRule(/^[a-f0-9]{48}$/.test(state??'')&&browser,'登录校验失效，请重新发起',400);
      const row=transaction(db,()=>{
        const found=db.prepare('SELECT * FROM web_oauth_states WHERE state_hash=?').get(digest(state));
        requireRule(found&&found.expires_at>Date.now()&&found.browser_hash===digest(browser),'登录校验失效，请重新发起',400);
        db.prepare('DELETE FROM web_oauth_states WHERE state_hash=?').run(digest(state));return found;
      });
      const payload=JSON.parse(row.payload);requireRule(payload.releaseId===legal.id,'协议已更新，请重新登录',409);
      const code=params.get('code');requireRule(code&&code.length<=512&&/^[a-zA-Z0-9_-]+$/.test(code),'微信授权未完成，请重试',400);
      let identity;
      try {
        const url=new URL('https://api.weixin.qq.com/sns/oauth2/access_token');
        url.search=new URLSearchParams({appid:config.appId,secret:config.appSecret,code,grant_type:'authorization_code'}).toString();
        const response=await fetchImpl(url,{signal:AbortSignal.timeout(10000),redirect:'error'});
        const result=await response.json();
        if(!response.ok||result.errcode||typeof result.openid!=='string'||!result.openid||result.openid.length>128||!result.access_token)throw Error('exchange failed');
        identity=result.openid;
      }catch{throw Object.assign(Error('微信登录暂未完成，请重新尝试'),{status:502});}
      const passwordHash=await hashPassword(randomBytes(64).toString('hex'));
      return transaction(db,()=>{
        const linked=db.prepare('SELECT user_id FROM wechat_identities WHERE app_id=? AND open_id=?').get(config.appId,identity);
        requireRule(!row.user_id||!linked||linked.user_id===row.user_id,'此微信已绑定其他账号，请使用原账号',409);
        let userId=row.user_id??linked?.user_id;
        let user=userId?db.prepare('SELECT * FROM users WHERE id=?').get(userId):null;
        requireRule(!userId||user?.role==='member','账号不可用',403);
        if(!user){user=insertUser(db,'wxh_'+randomBytes(12).toString('hex'),passwordHash);userId=user.id;captureReferral(db,user.id,payload.referral);}
        const current=db.prepare('SELECT open_id FROM wechat_identities WHERE app_id=? AND user_id=?').get(config.appId,userId);
        requireRule(!current||current.open_id===identity,'当前账号已经绑定其他微信',409);
        if(!linked)db.prepare('INSERT INTO wechat_identities VALUES(?,?,?,?)').run(config.appId,identity,userId,nowISO());
        recordLegalConsent(db,{userId,scope:'registration',targetId:userId,body:payload.legalConsent,release:legal,withinTransaction:true});
        audit(db,userId,'account.web_wechat_login',userId,{appId:config.appId,boundExisting:!!row.user_id,noticeVersion:'wechat-openid-v1',wechatConsent:true,purpose:'OpenID用于登录、订单和会籍关联；不读取昵称头像手机号；腾讯云香港存储'});
        return {userId,route:payload.route};
      });
    }
  };
}
