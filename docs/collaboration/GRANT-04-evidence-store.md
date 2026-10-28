# GRANT-04 人工核验与逐人批准持久化适配（默认关闭）

2026-10-28。按 Ethan「先审查集成 PR #6，把我们能做的完成，同时查清手机号绑定能不能复用」及已确认 userId 人工核验路线，新增独立服务模块。本节点只做本地虚构数据，不改变客户身份、管理员角色或线上资源。

## 实际调查结论

现有微信登录可复用：`miniprogram/utils/api.js` 的 loginWechat、`server/wechat.mjs` 的登录 code 交换及 access token 缓存、原生 Bearer 会话、`wechat_identities(app_id,open_id,user_id)` 唯一关联。当前代码没有 getPhoneNumber 授权按钮、服务端号码兑换方法或可信手机号绑定表；`postgres-core.mjs` 公开用户的 phoneVerified 固定 false，user_profiles 仅有头像与昵称。企业表单电话为自填信息，不能提升为已验证手机号。

PR #6 的 phoneResolver 可承接未来可信来源，但目前需保持 PHONE_VERIFICATION_UNAVAILABLE。未检查客户数据库、微信平台权限/资格或当前费用，因此本结论不是「云端没有手机号」「平台免费或已开通」。

## 本节点交付

- `grant-evidence-schema.sql`：本人核验、逐人逐等级批准两张独立表，无手机号字段。
- `grant-evidence-store.mjs`：显式初始化与校验、平台管理员管理服务、同事务读取 resolver。默认 writesEnabled=false，无 HTTP 路由、启动挂载、短信调用或生产配置。
- 管理服务仅接受真实 access 认证产生的 actor；每次操作重新检查会话与角色。伪造 `{id,role}` 无效。
- 所有管理写操作先取得现有 users 表锁，再锁会话和证据，遵守支付/赠送一致的锁序；证据与批准的 resolver 使用当前事务 FOR SHARE。
- recordIdentity 要求已注册消费账号与已有 appId/openId 一致，管理员提供外部核验依据编号和显式有效期。它记录人工核验结论，不冒称自动验证了本人；禁止页面自报 verified、phone 等字段。
- recordApproval 固定绑定 userId、basic/star、批准编号，并保存核验版本。改目标或等级必须另建批准编号；核验版本更新后旧批准失效，须重新批准。
- 每次变更需 expectedRevision；版本变化使既有预检凭据失效。撤回/到期阻断后续赠送，但不自动撤销已生效赠送；后者必须使用已有赠送撤销流程。
- 完全一致的首次请求重试可返回 duplicate，不重复写审计。撤回重复同样不会重复成功审计。审核依据与批准记录写入同一事务，审计失败全部回滚。
- 人工核验与手机号核验保持分开：本模块 phoneResolver 永远返回不可用，不能凭管理员输入电话声称已验证。

## 显式集成方式

安装者先在**已核准隔离库**显式调用 `initializeGrantEvidenceDatabase(pool,{schema})`，再调用 `validateGrantEvidenceDatabase`。初始化使用事务与 settings 锁，记录 SQL SHA256 和安装后物理列/约束/触发器指纹；重复初始化不清空记录，哈希/结构漂移、无标记已有表或部分表拒绝自动接管。不得改旧迁移哈希，不自动注册全局迁移编号。

仅在完成权限/数据来源及隔离验证后构建 `createGrantEvidenceStore(access,{writesEnabled:true})`；宿主通过 `prepareGrantHost` 的 `evidenceFactory(coordinatedAccess)` 服务端工厂创建 store，并返回其 identityVerifier、approvalResolver、phoneResolver。这使管理服务与赠送服务使用同一个 access 实例，actor 的 WeakMap 证明可复查；所有 resolver 继续检查 access.platform。工厂不是客户端配置，默认不提供；管理方法仍默认关闭。`grantEvidenceTables(client,schema)` 用于宿主只读检查：完全未安装返回 []，任何部分安装、缺标记或漂移都失败。未挂载 HTTP；将来管理接口须沿用受保护管理员会话、Origin/CSRF 策略和当前 actor 检查，不能直接给消费用户调用。

管理员管理方法：

- recordIdentity(actor, {userId, appId, openId, evidenceReference, expiresAt, expectedRevision})
- recordApproval(actor, {userId, level, reference, expiresAt, expectedRevision})
- revoke(actor, {kind: 'identity'|'approval', id, expectedRevision, reason})

首次 expectedRevision=0。返回新版本供后续修改。expiresAt 显式由实际批准记录给出，本节点不擅自规定核验期限、批准期限或双人审批制度。证据编号应是内部可追溯引用，不填原始身份证、电话、密码或真实名单。

关闭管理写入口即可回退使用；保留表、记录和审计，不 DROP 数据，不关闭既有赠送消费读取。正式使用前仍要明确业务上哪些平台管理员有核验/批准职责；本模块没有新增角色或给真实账号授权。

## 本地验证及边界

`node --test --test-concurrency=1 tests/collaboration/grant-evidence-store.test.mjs`：9/9 通过，0 跳过。

覆盖迁移重复/保留数据/结构及哈希漂移拒绝、默认关闭、伪造与协会 actor 拒绝、会话失效、既有微信身份关联、自报验证/电话拒绝、审计一次、批准等级绑定、持久化证据接真实 grant service 的星级和基础赠送/重放/撤销、核验与批准版本使预检失效、核验变更要求重批、到期/撤回/微信绑定变化阻断、审计失败回滚、事务过程中会话/证据自然到期回滚。

以上为 PGlite 本地串行验证，不是独立 PostgreSQL 多连接、真实手机号、真机或生产验收。没有真实发放、发布或新增费用。后续需实际管理员权限界定、核验依据及批准资料、微信工具登录和真实手机号授权能力验证。

## 本方宿主装配复验

`prepareGrantHost` 新增服务器内部 `evidenceFactory(coordinatedAccess)`，只接收 identityVerifier / approvalResolver / phoneResolver 三种回调，不允许从工厂覆盖写开关、策略或签名。默认不提供工厂、不启用写。fresh 数据库验证仅接纳校验通过的证据表，不自动初始化。

`tests/collaboration/grant-evidence-host.test.mjs` 2/2 本地 PGlite + 实际 HTTP 测试通过：持久化核验/批准→普通赠送→原编号恢复/重放；星级未经批准阻断；手机号来源不可用；结构漂移拒绝；工厂不能开启写入。可选 GRANT_TEST_DATABASE_URL 只允许 localhost/127.0.0.1 的 grant_test 库，供真实 PG 同一测试复验。

本方合计11个新增不同用例通过；宿主/消费/基础HTTP定向复验26/26（其中含这11项，不重复累加）。原PR6的19项页面回归和实际HTTPS完整闭环均已本方通过，后续宿主变化后完整闭环又复验通过。真实PG结果单独记录，不以PGlite代替。

2026-10-28 本方真实本机 PostgreSQL 18.6 复验：原13项并发/回滚/实际付款竞争 + 本模块2项宿主HTTP测试，共15/15通过、0跳过。独立新建任务数据目录、127.0.0.1专用端口、grant_test库，未连接其他项目库。两个新增宿主用例在PGlite和真实PG重复验证，不重复计数；证据管理本身的并发竞争尚未作为独立PG多连接场景覆盖。
