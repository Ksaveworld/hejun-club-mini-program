# GRANT-01 权益消费接入清单

日期：2026-10-28。静态核对基线：`306d1ac53f06ff8315c35e7a05673a9abaf1d241`。本清单由后端交付，供共享入口负责人串行接入；没有修改下面的宿主文件，也不表示 HTTP、后台或手机已经装配。

后续范围更新：单人赠送可明确选择 `basic` 或 `star`，不设置隐式默认等级；可信手机号可作为定位入口，仍须唯一已注册消费账号及服务端核验/逐人批准。以下统一权益按所选精确档位处理，基础赠送不自动取得星级专属联系人或星级内容。

## 1. 统一返回与兼容

`effectiveEntitlements(client, userId, now)` 是只读函数，使用当前事务的 `memberships` 与 `collab_grants`，不依赖协会配置表。调用者先验证当前消费账号及其会话，使用同一事务快照读取内容和权益；不要把客户端自报 userId 或角色直接传入。缺表或不可用的数据库仍失败，不自动退回只看付费而静默剥夺赠送。

保留原返回 `active / planIds / sources / paid / paidActive`，新增：

- `evaluatedAt`：本次计算的 UTC ISO 时间。
- `byPlan`：每个当前有效的精确档位，含 `planId / active / startsAt / expiresAt / sourceIds`。相同档位当前有效来源的区间均覆盖计算时刻，使用其中最早开始、最晚结束；未来来源不提前拼接。完整原区间仍在 `sources`。
- `displayMembership`：最高当前等级的上述摘要，或 `null`。赠送来源的 `basic`、`star` 与同档付费来源共用解析规则，等级顺序只用于标签，不代表高等级自动继承低等级内容。没有 `orderId`，不可伪装付费记录。

所有来源以真实 ISO 日期校验、规范化 UTC 后比较。有效区间为 `[startsAt, expiresAt)`；空的付费区间无效但可保留，反向或损坏区间报 `503 ENTITLEMENT_DATA_INVALID`，不能错放权。已撤销记录不进入来源并集。未知/不真实日期不能被 JavaScript 日期自动滚转为另一天。

建议 `/api/me` 增加经白名单投影的 `effectiveEntitlements` 和 `displayMembership`。原 `membership` 保留付费语义，`renewals` 保留原有服务端资格结果。不要把含原始 paid 行的完整内部对象机械展开到响应；客户端只需计算时刻、有效档位、脱敏来源 ID 及各来源区间。原有付费字段继续沿用原字段投影。

例如基础付费到 2029 年、星级赠送到 2027 年：展示星级到 2027 年，基础期限单独保留；星级到期后重新读取显示基础，而不是把星级标到 2029 年。

## 2. 必须接入的消费点

| 文件与函数/入口 | 接入方式 | 必要回归 |
| --- | --- | --- |
| `server/postgres-core.mjs`：`me`、后台 `members` | 增加统一权益和展示摘要；保留原付费 `membership`；单次响应使用一致读取时刻/事务快照 | 赠送可见；基础长于星级时不延长期限；退出/换账号不串数据 |
| `server/postgres-content.mjs`：`articles`、`articleState`、`assembleArticleState`、`article` | 用同一 resolver 的精确 `planIds` 判断全文；保留用户角色检查、发表状态、目录可见、试看规则与原文外链约束 | basic 不读 star 专属，star 也不自动可读 basic 专属；公开仍公开；草稿/撤下仍拒绝；仅试看不返回正文 |
| 同上：`document` | 每次完整 PDF 和 Range 请求重新鉴权；在现有一致快照内取内容、原件/试看元数据和权益；原全文与试看文件仍分开 | 赠送后实际文件可读；撤销/到期的新全文请求拒绝；其他合法付费仍放行；旧链接不可绕过 |
| 同上：`resources`、`resource` | 继续先用 `resourceAccessPolicy` 校验服务配置，再判断公开或精确档位集合；保持服务发布状态、操作入口配置 | 列表和详情结果一致；撤下立即影响新请求；无合法权益不能取得受限服务入口 |
| 同上：`activeAuthor`、`ownedPosts` | 经验证消费身份 + 统一 `active`；保持投稿版本、本人所有权及复审规则 | 有效赠送可新增/修改；到期不能提交；历史稿件和本人记录仍按原规则可查 |
| `server/postgres-app.mjs`：`/api/exclusive-contacts`；`server/exclusive-contacts.mjs` | 取 `byPlan` 中精确 `star` 的时间摘要调用原联系人规则，不能用最高等级摘要推定包含 star | 仅当前星级来源可读；撤销后有其他star来源仍可读；公开服务人员接口继续不含联系方式 |
| `miniprogram/pages/account/index.js` | 标签/期限使用新增 `displayMembership`，详情可展示来源；原 `membership` 保留供付费办理流程使用 | 刷新、重开、切账号、前后台恢复、到期清理；审核只读体验身份分支不能变真实会籍 |
| `miniprogram/pages/posts/index.js` | `canSubmit` 来自新的消费权益，实际提交仍以服务器校验为准 | 按钮与服务器状态一致；过期或撤销后失败要清理旧可提交状态 |
| `miniprogram/pages/articles/index.js` 与下载工具 | 继续信服务器 `fullAccess`；下载失败刷新权益并清理旧显示；区分授权失效与网络失败 | 实际打开全文/试看、弱网重试、退出/换账号、旧下载链接；已下载副本不能远程收回 |
| `src/MemberPages.tsx` 及共享 session/types/API | 显示与投稿消费使用新增字段；订单、价格、续费和售后保持原付费字段 | 网页与手机同账号结果相同；无假订单号或付款状态；后台记录可追溯 |

`canReadWithEntitlements` 只判断文章状态和策略，不代替会话、消费身份和对象所有权鉴权。管理员内容管理读取、审核只读访问与普通会员读取是不同入口，不能通过并集绕开其独立权限。

## 3. 明确保留付费语义的点

以下不能全局替换为赠送并集：

- `postgres-core.mjs`：下单、付款核验、付款开通和续费处理；`postgres-virtual-payment.mjs`：虚拟付款/查单开通。
- `postgres-renewals.mjs`：同档续费资格、订单快照、付款后的会籍区间。
- `postgres-manual-aftercare.mjs`：实际付费订单、回执、退款依据、付费会籍快照与截短。
- `postgres-rewards.mjs`：受益人的付费资格和订单奖励；`postgres-support.mjs` 的 `active` 用于推广大使资格，不是普通帮助反馈入口，保持付费判定。
- `postgres-reminders.mjs`：目前绑定 `membership_order_id` 的提醒。赠送没有订单，不伪造订单接进去；赠送提醒不在本次范围。
- `miniprogram/utils/member-journey.js` 及账号页须拆开“使用当前权益”与“付费办理”判断：有效赠送应能进入使用权益，不显示“尚未入会”；真实订单/付款/续费引导仍根据付费 `membership`、真实订单及服务器续费结果。不能把统一展示对象直接替换整个原参数，用显示星级推导可续费或已付款。
- SQLite 的 `domain.mjs / manual-payments.mjs` 不属于此次 PostgreSQL 赠送接入；不能把未接入的运行模式宣传为已有赠送能力。

## 4. 写入协调与回退条件

已核对当前 `postgres-core.mjs` 的写事务采用 `LOCK TABLE users IN SHARE ROW EXCLUSIVE MODE`。赠送仅锁某个用户行不与该表锁天然互斥。还须覆盖 `postgres-virtual-payment.mjs`、`postgres-renewals.mjs`、`postgres-manual-aftercare.mjs`、账号身份/角色改变及赠送撤销路径，统一锁顺序并在锁后重读权益；接入前保持写入口关闭。

赠送与付款交错不仅是互斥问题：付款先完成时赠送预检应阻断；赠送先完成后真实付款成功如何记录、开通或转人工核对，必须使用既有付款对账规则并经集成者明确，不能吞掉真实收款、假装付款失败或自动覆盖赠送。纯付费购买资格仍按付费来源判断。

关闭赠送写入口后仍保留上述消费读取和历史审计。不能通过退回完全不识别赠送的二进制来声称无损回退。损坏迁移/连接失败要给出可追踪的503或业务错误；不要把异常降级为前端标签变化。

## 5. 发布前证据与稳定性缺口

本次静态确认已有连接超时、SQL执行超时、HTTP请求/头部超时、事务回滚和丢弃失败连接、进程优雅退出代码。这些是已有代码能力，不是实测容量或线上可用性证明。当前健康响应还明确 `releaseReady:false`，不能将 HTTP 200 当发布验收。

发布前至少取得：真实隔离 PostgreSQL 多连接竞争/断连回滚证据；冻结版本的后台→手机→实际PDF闭环；账号/会话失效及弱网恢复；按已确认流量模型测报告下载与业务JSON竞争；数据库恢复和保留赠送读取的回退演练；错误率、延迟、连接池和存储容量告警的实际触达。并发上限、可用性目标与恢复时间需依当前资源和业务约定定标，不能由模块测试推定“永不崩溃”。

本模块定向验证：新测试覆盖区间边界、跨UTC日期/闰日、来源级期限、未来来源、撤销保留付费、空付费区间、精确内容权限和坏数据；旧K3用例也应保留通过。它们不包含真实PG并发、HTTP接入、手机或正式部署证据。
