# GRANT-01 消费端独立接入与验证

本次为独立集成候选的后端消费点改动；不代表已部署，也不代表手机真机验收。

## 构造器契约

```js
createPostgresCore(pool, {
  schema, appId,
  entitlementResolver, // async (client, userId, evaluatedAt) => effectiveEntitlements
  grantPaymentConflict // async (client, userId, {startsAt, expiresAt}) => boolean
});
createPostgresContent(pool, {
  schema, documentsDirectory, reportStorage, postVersions,
  entitlementResolver
});
```

两个回调均由服务端运行时注入，不来自请求。读取解析器可直接使用 `server/collaboration/entitlements.mjs` 的 `effectiveEntitlements`，与宿主使用同一事务连接和 schema。未注入时保留原付费返回及权限行为；注入后解析器异常不得静默降级为仅付费。

## 会员信息与消费

- `core.me`、`core.managedMembers` 增加顶层 `effectiveEntitlements` 和 `displayMembership`。原 `membership` 保持付费语义；`renewals` 继续使用原续费服务结果。
- 白名单只输出有效档位、计算时刻、来源类型/ID/档位/起止、按档位期限及 `paidActive`；不展开内部 `paid` 行、不输出批准依据或未声明字段，不制造 `orderId`。
- 展示等级和期限取同档摘要。基础付费比星级赠送长时，星级展示只到其真实期限；撤销/到期后重新显示仍有效的基础会籍。
- 启用解析器时，消费前核对当前数据库 member 角色并排除 `collab_accounts` 中的运营身份。`core.authenticate` 同样排除运营身份；实际 HTTP 入口仍须每次验证会话，不以页面缓存角色代替。
- 文章列表/正文/报告完整文件及 Range、资源列表/详情均使用精确档位集合。basic 不继承 star，star 也不自动继承 basic 专属内容。公开、目录、独立试看、草稿及撤下规则保持原意。
- 有效赠送可新增或修改本人稿件；到期后可继续查询本人历史，但不能继续编辑或新增。版本、所有权与复审规则保持。

## 付款交错

`core.applyPayment` 在宿主已有写事务锁内，原逻辑准备 `activated` 后、修改订单/会员前调用 `grantPaymentConflict`。区间取 `renewal.startsAt / renewal.expiresAt`，首购取真实 `paidAt / yearAfter(paidAt)`。

存在赠送区间冲突时保留核验后的 `payment_receipts`，结果为 `needs_reconciliation`；不伪造支付失败、不吞掉收款事实，也不新建付费会籍、修改推荐锁定、记奖励或提交续费履约。重复真实流水返回原回执结果。付款资格判断仍基于原付费记录，不用赠送展示对象冒充付费。

该回调不能单独解决并发：运行时必须让赠送、付款、身份及相关变更遵守同一锁协议；由主集成者装配。虚拟支付对应路径由主集成者单独接入，此文件不代称已覆盖。

## 本次实际证据

执行 Node 24：

```text
node --test tests/collaboration/grant-consumption.test.mjs tests/server/postgres-core.test.mjs tests/server/postgres-content.test.mjs
```

结果 **16/16 通过，0 失败，0 跳过**：新增消费 6 组、原核心付费 4 组、原内容 6 组。使用虚构账号、PGlite 隔离数据库、本机随机 HTTP 端口和临时 PDF 文件。

新增测试实际覆盖白名单响应和正确展示期限、basic/star 精确权限、公开/撤下、HTTP `/me`、全文/PDF/Range、切账号、无效会话、撤销及付费回退、到期、投稿复审编辑和历史、运营身份与角色改变、付款冲突回执及推荐/奖励不变。原测试覆盖未配置解析器时的既有订单/支付和内容流程。

PDF 测试使用虚构字节验证实际传输与授权，不声称完成 PDF 阅读器渲染。直接消费测试中的赠送记录是隔离夹具，不替代后台确认到手机的整条链路。真实 PostgreSQL HTTP 装配、后台浏览器、原生运行时、真机、线上资源容量及部署恢复，仍由统一集成记录分别取证。
