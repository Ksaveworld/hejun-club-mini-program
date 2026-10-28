# GRANT-01 API 契约 v2

日期：2026-10-28。基线：306d1ac53f06ff8315c35e7a05673a9abaf1d241。供后台并行开发；这些是待宿主装配的端点，不是线上已启用能力。

v2依据：[Issue #2 最新范围](https://github.com/Ksaveworld/hejun-club-mini-program/issues/2#issuecomment-6466871327)，覆盖v1仅星级/仅userId约束，支持基础/星级与可信手机号查找；原历史文档不回改。

## 会话与传输

前缀 `/api/admin/membership-grants`。沿用 `club_pg_admin` 管理员Cookie，拒绝混用Bearer/协会身份。所有操作均由服务端重新核验当前会话和平台管理员权限，禁止body传actor/role。
写请求（包括lookup、preflight）使用JSON、同源Origin、`X-Club-Request: 1`、`X-Club-Actor: 当前管理员userId`；响应 `Cache-Control: no-store`。HTTP适配器独立交付，主路由由集成方串行装配。

| 方法与路径 | 输入 | 成功输出 |
|---|---|---|
| POST `/lookup` | `{type:"userId"或"phone",value:"精确标识"}` | `{userId,verified,identitySummary,blockers}`；phone失败可userId:null；不按姓名/未核验手机认人 |
| POST `/preflight` | `{userId,level:"basic"或"star",reason,approvalReference}` | `{ready,blockers,identitySummary,existingEntitlements,proposal,confirmationToken?,expiresAt?}` |
| POST 根路径 | `{userId,level:"basic"或"star",reason,approvalReference,confirmationToken,idempotencyKey}` | `{grantId,userId,level,startsAt,expiresAt,status,duplicate,source:"grant",effectiveEntitlements,...历史字段}` |
| GET 根路径 | `userId?&status?&cursor?&limit?` | `{items,asOf,nextCursor}`；默认25，上限100；status为scheduled/active/expired/revoked |
| GET `/operations/:idempotencyKey` | 原操作编号 | 已提交：`{found:true,outcome:"committed",grant}`；未查到：`{found:false,outcome:"unknown",grant:null}`，可能仍在提交，不表示确定失败 |
| POST `/:grantId/revoke` | `{reason}` | 与确认同一记录DTO，status:"revoked"、duplicate及剩余有效权益 |

仅单人，不接受userIds数组、客户端起止/approved字段。level必填且只能basic/star，服务端批准记录必须同时匹配userId与level；改等级重新预检，同键换等级409。批准引用本身不构成批准。没有可靠身份绑定/批准记录时预检阻断，不临时收费核验或创建真实用户。

手机号仅POST body，禁止URL/日志/审计中记录完整号码；默认大陆11位移动号码转+86，支持+86/0086及显式其他国际区号，去空格/短横线/括号。规范化不代表验证。返回phoneMasked及证据类型，不返回完整号码。匹配查询必须读取可信已核验绑定，不能把表单里的手机号当成该数据源。

当前快照core明确phoneVerified:false，user_profiles只有昵称/头像；申请/表单中的联系电话均不能证明绑定。默认phoneResolver缺省时返回200、verified:false、blockers:[{code:"PHONE_VERIFICATION_UNAVAILABLE"}]；零匹配PHONE_NOT_FOUND，多匹配IDENTITY_AMBIGUOUS，证据不足IDENTITY_UNVERIFIED。集成方需提供服务器适配器 `phoneResolver(c,{phone,actor,now}) -> {available:true,matches:[{userId,phone,verified,reference,revision,expiresAt?}]}`，只读同事务且锁住证据行。测试全部为虚构绑定。

手机号lookup负责定位，预检/确认仍须独立identityVerifier和批准记录核对本人→消费账号。如果将可信手机号绑定作为本人证据，该绑定的版本和有效期必须进入identityVerifier的fingerprint/validUntil，不能只在lookup查一次。无证据仍阻断，不放宽到任意填手机号开通。

## 确认与幂等

- 策略由服务器持有：`approved:true,version,startRule:'confirmation-time',timeZone:'Asia/Shanghai',yearRule:'calendar-anniversary-clamp',overlap:'block-active'`。
- HMAC签名确认凭据绑定管理员、目标、等级、原因、批准引用、策略、身份/批准证据与权益快照，默认5分钟；密钥仅在服务器配置，不纳入源码。原OpenID/完整手机不进入凭据或响应。
- 预检时间为预计值；首次确认成功以服务端当时取时固定起止，按北京时间一日历年，闰日次年2月28日同刻。生效区间 `[startsAt,expiresAt)`，UTC ISO传输，界面上海时间展示。
- 同键同业务请求恢复原grantId和固定时间；动态时间和token不进入业务请求摘要。重试仍核验当前权限、身份及批准；不同业务请求复用同键返回409。
- 超时、断网或畸形响应不得当成确定失败、不得用新键再送。按operations接口查原操作编号可跨设备恢复；未查到仍unknown，保留原完整请求同键重试。幂等已提交结果先于token到期检查恢复；若身份/批准撤销导致无法重试，由授权管理员查历史处理，不显示假成功。
- 目标、策略、身份/批准证据或原权益变化需重做预检。成功后旧凭据不能用新键绕过重叠限制。

## 错误与界面处理

外层 `{code,message,requestId}`；不得返回SQL、堆栈、凭据或原始第三方错误。预检业务阻断可200并ready:false，不能据HTTP200显示已赠送。

| 状态 | 场景与处理 |
|---|---|
| 400 | 输入格式/多人/未知字段错误；修正输入 |
| 401 | 未登录、会话失效；重新登录 |
| 403 | 非平台管理员、跨站或身份无权限；停止操作 |
| 404 | 对象不可用；刷新核对 |
| 409 | ACTOR_CHANGED、PREFLIGHT_BLOCKED、PREFLIGHT_CHANGED、IDEMPOTENCY_CONFLICT等；按具体code重新核对，不能自动另起赠送 |
| 413/415 | 请求体超限/非JSON；修正请求 |
| 503 | 写入口关闭、迁移/并发协调未就绪或暂时不可用；保留原请求，不改前端标签冒充开通 |

审计/历史字段包括reason、approvalReference、actorId、idempotencyKey、createdAt、revokedAt、revokedBy、revokeReason。PHONE_*及APPROVAL_REQUIRED等是预检/查找阻断code。原始数据库错误不透出，暂时断连/锁超时为503，可先按操作编号查结果。

## 集成不可省略项

`writesEnabled` 与 `writeCoordinationReady` 默认false。后者只有在付费开通、续费、虚拟支付、售后、授权撤销与赠送遵守已验证的锁协议后才能开启；单方面配置true不是验收。关闭新写入不关闭历史或有效赠送读取。
`/api/me`新增effectiveEntitlements及展示结构，原付费membership不伪造orderId、不改付费语义。报告列表/详情/实际PDF以及其他消费点见配套接入清单。购买、售后、推荐和奖励继续按真实付费来源判断。
