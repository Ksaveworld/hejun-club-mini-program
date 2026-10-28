# GRANT-01 API 契约 v1

日期：2026-10-28。基线：306d1ac53f06ff8315c35e7a05673a9abaf1d241。供后台并行开发；这些是待宿主装配的端点，不是线上已启用能力。

## 会话与传输

前缀 `/api/admin/membership-grants`。沿用 `club_pg_admin` 管理员Cookie，拒绝混用Bearer/协会身份。所有操作均由服务端重新核验当前会话和平台管理员权限，禁止body传actor/role。
写请求（包括lookup、preflight）使用JSON、同源Origin、`X-Club-Request: 1`、`X-Club-Actor: 当前管理员userId`；响应 `Cache-Control: no-store`。HTTP适配器独立交付，主路由由集成方串行装配。

| 方法与路径 | 输入 | 成功输出 |
|---|---|---|
| POST `/lookup` | `{type:"userId",value:"精确消费userId"}` | 脱敏身份摘要、核验结果与阻断项；不按姓名/未核验手机认人 |
| POST `/preflight` | `{userId,reason,approvalReference}` | `{ready,blockers,identitySummary,existingEntitlements,proposal,confirmationToken?,expiresAt?}` |
| POST 根路径 | `{userId,reason,approvalReference,confirmationToken,idempotencyKey}` | `{grantId,userId,level,startsAt,expiresAt,status,duplicate,source:"grant",effectiveEntitlements}` |
| GET 根路径 | `userId?&status?&cursor?&limit?` | `{items,nextCursor}`；默认20，上限100；status为scheduled/active/expired/revoked |
| POST `/:grantId/revoke` | `{reason}` | 来源撤销结果、duplicate及剩余有效权益；实际字段见服务实现与测试 |

仅单人，不接受userIds数组、客户端等级/起止/approved字段。批准引用必须解析到服务器已核定且与该消费userId匹配的星级赠送批准记录；填写引用本身不构成批准。没有可靠身份绑定/批准记录时预检阻断，不临时收费核验或创建真实用户。

## 确认与幂等

- 策略由服务器持有：`approved:true,version,startRule:'confirmation-time',timeZone:'Asia/Shanghai',yearRule:'calendar-anniversary-clamp',overlap:'block-active'`。
- HMAC签名确认凭据绑定管理员、目标、原因、批准引用、策略、身份/批准证据与权益快照，默认5分钟；密钥仅在服务器配置，不纳入源码。原OpenID/完整手机不进入凭据或响应。
- 预检时间为预计值；首次确认成功以服务端当时取时固定起止，按北京时间一日历年，闰日次年2月28日同刻。生效区间 `[startsAt,expiresAt)`，UTC ISO传输，界面上海时间展示。
- 同键同业务请求恢复原grantId和固定时间；动态时间和token不进入业务请求摘要。重试仍核验当前权限、身份及批准；不同业务请求复用同键返回409。
- 超时或断网不得用新键再送。保留原完整请求，同键重试；若身份/批准撤销导致无法重试，由授权管理员查历史处理，不显示假成功。
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

最终错误码、lookup/revoke详细字段以本分支测试与交接记录为准，接口修订在此记录。

## 集成不可省略项

`writesEnabled` 与 `writeCoordinationReady` 默认false。后者只有在付费开通、续费、虚拟支付、售后、授权撤销与赠送遵守已验证的锁协议后才能开启；单方面配置true不是验收。关闭新写入不关闭历史或有效赠送读取。
`/api/me`新增effectiveEntitlements及展示结构，原付费membership不伪造orderId、不改付费语义。报告列表/详情/实际PDF以及其他消费点见配套接入清单。购买、售后、推荐和奖励继续按真实付费来源判断。
