# GRANT-03 前端适配交接

已只读核对 GRANT-02B 提交 `6a8823b8aa5fc1045b502930b4b7377933e9c37f` 的 `src/grants/contract.ts`。该UI分支未合入后端；本说明由GRANT-03共享接入者应用，不改其公共类型或页面。

| UI端口 | HTTP DTO 映射 |
|---|---|
| checkSession | 复用宿主当前后台会话检查；检查结果只控制页面，所有后端动作仍重新鉴权 |
| lookup | POST `/lookup` 原样输入type/value；后台返回verified/userId/identitySummary/blockers。无userId或verified:false时阻断，不构造可赠送匹配；成功转为一项matches，displayName可显示稳定userId，maskedContact取phoneMasked（缺省展示“未提供”），evidence根据evidenceType显示，不编造姓名/真实号码 |
| preflight | POST `/preflight` 原样传Draft。userId取已提交且匹配的输入，existing取existingEntitlements并将planId映射level；level/start/expiry从proposal读取，confirmationExpiresAt取顶层expiresAt；blockers对象按code转可理解文本；ready:false时不得进入确认 |
| issue | POST根路径传IssueInput，后台平铺记录转 `{grant:record,duplicate:record.duplicate}`；校验grantId/userId/level/时间等，不能把畸形200视为成功或确定失败 |
| list | GET根路径传userId/cursor，返回items/nextCursor；null nextCursor按UI约定转undefined；保留服务器asOf用于解释分页时钟 |
| revoke | POST `/:grantId/revoke` **只传reason**；UI本地idempotencyKey不送此body（未知字段会400）。撤销本身以grantId永久幂等，重复返回原撤销结果且只一条成功审计；改原因不会覆盖原撤销原因 |
| 恢复赠送 | GET `/operations/:idempotencyKey`；found:true映射原grant；found:false/outcome:unknown保留待核对状态，不能新键重发。当前授权管理员可在新会话/设备查询 |
| 恢复撤销 | 以同grantId/reason重试撤销或查对应用户历史的grantId/status；不把赠送operations端点用于UI撤销的临时key。写开关关闭时仍可读历史确认 |

后台记录 `actorId` 映射UI `actor`；后台status包含scheduled/active/expired/revoked，UI当前类型只有active/revoked且其grantState按时间派生。可由适配器将未撤销记录映射active并保留真实起止供grantState推导，或由UI负责人扩类型，不能丢失到期显示。基础档不得显示星级期限/联系人。

响应异常处理：仅服务端明确未提交的业务拒绝才转换GrantRejection。网络错误、超时、503、无效JSON、缺必需字段以及操作结果unknown都保持“结果待核对”；保留原编号和请求。已提交后HTTP响应丢失时，先查operations或同键重放。禁止在浏览器或服务器请求日志记录lookup手机号/confirmationToken。

模块装配：导入 `createCollaborationAccess`、`createSingleGrants`、`createGrantIdentityVerifier`、`createGrantHttpHandler`；沿用宿主pool/schema/后台Origin/会话，不引入第二套管理员账号。迁移先显式执行并由 `grantMigrationTables`验证v2，两张表白名单由集成方登记。身份、手机号、批准resolver只读同事务的服务器已核验记录且锁住证据行，真实来源未具备时保持阻断。

写入口默认关闭；在共享付费写路径和权限修改遵守统一锁协议、后端/页面/手机实际闭环通过前，不设置writeCoordinationReady:true。报告与手机消费点详见GRANT-01-consumer-integration.md，公共文件仍由原负责人串行装配。
