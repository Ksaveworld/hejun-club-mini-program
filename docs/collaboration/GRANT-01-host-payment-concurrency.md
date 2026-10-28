# GRANT-01 宿主实际付款与赠送并发验证

本记录属于独立集成候选；没有生产支付、真实客户账号开通或部署操作。

## 实际调用链

`prepareGrantHost` 装配真实 `createSingleGrants`、后台 cookie 鉴权及 HTTP 适配器；测试通过实际 HTTP `/api/admin/membership-grants/preflight` 和确认入口调用该服务。付款侧调用真实 `createPostgresCore(...).applyPayment`，传入虚构但结构有效的服务端已核验付款结果，启用宿主 `grantPaymentConflict`。

两侧共享同一真实 PostgreSQL pool/schema，使用多个独立连接；测试通过 `pg_blocking_pids` 确认竞争一方确实等待 `users` 表锁。不是 PGlite 串行连接，也不是模拟付款 writer。

## 两种交错结果

| 交错 | 实际结果 |
| --- | --- |
| 真实 `core.applyPayment` 先取得 `users` 表锁 | 赠送 HTTP 请求等待；付款正常生成 paid order、basic membership 和 activated receipt；赠送随后返回 409 `PREFLIGHT_BLOCKED`，无赠送或幂等占位残留 |
| 真实赠送确认先取得 `users` 表锁 | 付款等待；赠送成功后，真实付款回执保存为 `needs_reconciliation`；不伪造付款失败、不覆盖赠送、不生成 paid membership、不锁推荐或调用奖励记录；原订单留待对账处理 |

另验证了付款同流水重放、赠送同键重放和 `/operations/:key` 已提交结果恢复；均返回原结果，没有重复回执或新赠送。

## 可复跑入口与实际结果

仅接受显式 `GRANT_TEST_DATABASE_URL`，且必须是 `127.0.0.1/localhost` 的 `grant_test` 数据库，不接受 URL 参数覆盖。每个测试创建并清理自身随机 `club_migration_grant_host_*` schema，账号和记录全部虚构。

```text
node --test tests/collaboration/grant-host.pg.test.mjs
```

2026-10-28 使用 Node 24 和任务专用便携 PostgreSQL 实跑：**2/2 通过，0 失败，0 跳过**。

这证明了独立集成候选中普通微信付款处理函数与赠送的数据库交错行为，不等于微信真实扣款/回调签名、虚拟支付、全部续费/售后路径、前端按钮、真机或生产容量验收。那些路径须按各自测试和发布证据单列。
