# GRANT-01 后端交接与验证

日期：2026-10-28。状态：独立后端实现及验证完成，等待GRANT-03装配和独立验收；不是上线或真实赠送完成。

## 基线、范围及文件

base：`306d1ac53f06ff8315c35e7a05673a9abaf1d241`；分支 `feat/grant-01-backend`；PR基底 `chore/grant-00-public-source`。final以PR当前head SHA/`git rev-parse HEAD`为准，代码提交与文档提交分别在Git记录中，不将本快照整支合入内部历史。

已采用Issue评论6466871327的basic/star和phone范围，并核对评论6467075689的GRANT-02B页面交付；未合入对方UI分支。接口见GRANT-01-api.md，UI映射见GRANT-01-ui-adapter.md。

最小运行模块：single-grants.mjs、grant-identity.mjs、grant-http.mjs、entitlements.mjs、access.mjs的管理员会话锁增量，复用common.mjs/domain.mjs/articles.mjs/postgres.mjs；现有pg依赖不变。迁移为grant-schema.sql、grant-levels-v2.sql、grant-migration.mjs。没有修改共享postgres-app/core/content、package、公共类型、导航、手机或启动配置。

变更文件完整清单：`git diff --name-only 306d1ac53f06ff8315c35e7a05673a9abaf1d241 HEAD`。依赖未增加；开发验证用便携PG仅在忽略目录，未纳入运行时或仓库。

## 实际验证

环境：Windows，Node 24.22.1，PostgreSQL 18.4；所有身份/手机号/批准/支付响应均为虚构夹具，没有调用真实微信、支付或客户数据库。

| 检查 | 最终覆盖结果 | 边界 |
|---|---|---|
| 权益、单人服务、范围扩展、审查回归、K3保留、迁移 | 46项通过 | PGlite/确定性规则验证，不是PG并发 |
| 真实独立PG多连接 | 11/11通过，0跳过 | pg_blocking_pids证明实际锁等待；含同/异键、basic、撤权/撤销、审计失败、pg_terminate_backend断线回滚。付费两例仅共同锁协议模拟writer，不是宿主支付集成 |
| 独立真实HTTP | 9/9通过，0跳过 | Node真实回环请求，含完整后端单人流程、当前权限、CSRF、级别、恢复、错误脱敏；不是现有主路由装配或手机验收 |
| 仓库必需baseline | 9/9通过 | 现有订单/核验支付、表单和后台会话的虚构夹具 |
| TypeScript/Vite构建 | 通过 | 现有ExcelJS块约930KB构建提示保留，不等同运行时崩溃或容量证据 |

以上赠送范围共66个不同用例。最终整合时57项非HTTP全部通过；旧HTTP夹具缺新增必填level导致1失败，更新夹具及恢复适配后，由主代理对最终HTTP9项独立重跑全部通过，其他实现未再变更。未把失败轮次计为全套通过。

复现命令（Node24）：

```sh
node --test --test-concurrency=2 --test-timeout=60000 tests/collaboration/*.test.mjs
npm run test:baseline
npm run build
```

PG测试要求显式GRANT_TEST_DATABASE_URL，仅允许127.0.0.1/localhost、数据库grant_test、不许URL参数覆盖；无配置会明确跳过。每例随机schema，精确清理自身schema；实际验证已检查剩余测试schema为0。不使用共享库补证。旧数据文件、密钥、日志、依赖和测试PG均未提交。

扩大执行现有server全部测试时，发现三项虚拟支付失败且进程未正常收尾；已停止本轮测试树。独立冻结base与当前树的有界定向运行均复现3/3失败。两项为发货签名夹具与实现不一致，一项为取消行为与旧期望不一致。详见GRANT-01-baseline-findings.md；共享支付文件未改。故不能声称全小程序回归通过或上线就绪。

## 审查中修复的问题

- 服务器核验耗时后身份/批准到期仍可能开通：最终时钟重新检查证据期限及重叠，并以该时刻固定起止。
- TEXT时区偏移导致历史筛选状态与权益读取不一致：按真实时间比较、规范UTC输出、校验游标。
- node-postgres对catalog name[]返回字符串，与PGlite差异导致迁移误判：显式转换text[]，真实PG复验通过。
- 身份适配摘要采用白名单，原始OpenID/手机号/任意provider字段不从lookup或preflight透出。
- 管理员会话锁保持到事务结束，协会路径不增加相反顺序的会话锁。

## 迁移与回退

single-grant-v1 SHA256：`8d7cb64d0d3b360b90f86494b4095114edc95e840bb69eb34eb4c79da0723db3`。
single-grant-levels-v2 SHA256：`cb10a0615b659a00336d0504eaab46cb12d7108fde6a7919b9e751928f1db6a9`。
旧schema/hash不变，v2事务修改已验证的等级CHECK、保留所有行。迁移编号/登记由集成方处理。回退关闭写入口，保留两档赠送读取和审计；不DROP数据，不回退到不认识赠送的旧二进制并声称无损。

## 锁、重试与接入条件

服务内锁序：当前管理员session/user共享锁 → 全局幂等批次键（创建时）→ 目标user行排他锁 → 身份/批准证据行 → grant行（撤销时）→ 审计；成功才commit。跨目标相同key首先串行，冲突409。所有外部适配只做同事务数据库读取，不调用微信或发送消息。死锁/序列化失败/锁超时/断连映射503，不在事务内部盲目重跑；客户端保留原key查operations或完整同键重试。

宿主普通/虚拟支付、续费、售后、绑定修改及权限撤销必须由GRANT-03统一锁顺序与冲突处理。现有core表锁不能自动当成与赠送用户行锁等价；真实付款已发生的冲突须保留真实收款事实并进入适用对账流程，不能丢付款或虚构权益。默认writesEnabled和writeCoordinationReady为false，完成协议及集成验证前不可仅改true。

## 未完成与下一接续

1. 真实可信手机号绑定及本人核验/批准记录来源未提供。默认返回不可核验；不把自填手机或虚构夹具当真实证明。
2. GRANT-03负责API主路由、后台适配、手机/me、报告列表/正文/实际PDF及其他会员消费点的统一接入；当前没有该完整闭环证据。
3. 支付共同锁与冲突策略需实际宿主链路测试；三项旧支付回归问题由其负责人处理。
4. 真机、真实微信身份/支付、目标负载、长稳、监控告警送达、备份恢复及发布回退仍待冻结候选版本后验证；无生产容量或零故障保证。
5. 本次只交独立增量供审查，不合main、不迁移云库、不改真实账号、不赠送真实会籍、不部署。下一具体动作是GRANT-03接入并反馈冻结集成SHA与测试入口，再按A01–A08联合验收。
