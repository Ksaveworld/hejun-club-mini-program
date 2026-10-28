# GRANT-01 增量迁移与回退提案

此提案不占用宿主迁移编号，不更改启动配置或迁移登记，不执行云迁移。集成者评审后串行登记；导入模块不会创建连接或启动迁移。

## 最小依赖与调用

- 原 v1 SQL：`server/collaboration/grant-schema.sql` 保持不变，只定义 `collab_grants`、`collab_grant_batches` 及用户索引；不创建协会工作台表。
- 根据 Issue #2 后续确认的 basic/star 范围，新增 `server/collaboration/grant-levels-v2.sql`：仅将已验证的 `collab_grants_level_check` 更换为 `level IN ('basic','star')`，保留全部原行。不得将旧 SQL 直接改成两档来制造旧哈希变化。
- 依赖宿主已存在的 `users`、`settings`；服务审计使用宿主 `audit_log`。不更新原订单、会员、付款回执、价目、推荐或奖励记录。
- `grantMigration` 导出提案版本 `single-grant-v1`、SQL 的 SHA-256 和两表白名单。新提案哈希按 LF 规范化，避免 Windows 检出换行差异；旧协作标记仍按旧迁移原文件字节核对，不改写其历史算法。
- `grantLevelsMigration` 导出 `single-grant-levels-v2`、新增增量 SQL 的独立 SHA-256 和同一两表白名单；新标记为 `_club_single_grant_levels_migration`。
- `initializeGrantDatabase(pool,{schema})` 为显式迁移入口。仅接受 `club_migration_...` 隔离 schema，在同一事务内锁定 `settings`，检查现状、建表或接纳旧表、保存 v1 标记，再执行 CHECK 增量和 v2 标记。升级已有 v1 时不更新其标记。
- `grantMigrationTables(client,schema)` 是只读校验。返回两表表示 v2 已初始化；返回空数组表示尚未达到 v2，不能打开两档赠送写入口。结构或哈希不一致返回 `503 / GRANT_MIGRATION_INCONSISTENT`。
- 宿主的生产 schema 如不满足当前隔离命名约束，应另行审查适配，不删除此检查后直接操作客户库。

## 数据状态与处理

| 起点 | 行为 |
| --- | --- |
| 已安装 baseline，无赠送表且无赠送/旧协作标记 | 同事务创建原 v1 两表、v1 标记、basic/star 增量及 v2 标记；其余表不变 |
| 完整 collaboration-v1，旧标记与未修改 `schema.sql` 哈希匹配 | 核对真实列、非空/类型、主键、幂等唯一键、外键、原等级/状态约束和用户索引；接纳原两表，添加 v1/v2 标记及两档约束，不重建表、不改旧标记或已有赠送 |
| 已安装 single-grant-v1 | 核对原结构和哈希，只更换已验证的等级 CHECK 并添加 v2 标记；原 v1 标记与全部行保持不变 |
| 已安装 single-grant-levels-v2 | 重验两个哈希及两档真实结构，返回 `initialized:false` |
| 部分表、无标记已有表、缺表标记、旧哈希异常、结构漂移 | 失败关闭；不自动补表、删除或修复。先备份并查清失败点，再由集成者提供单独修复方案 |

旧 `schema.sql`、`migration.mjs`、`migration-support.mjs` 保持原样。旧迁移仍可重复核验。这里的“全新库”指已具备宿主 baseline 的独立空业务库，不是自动建立整套宿主 schema。

## 失败与重试

建表、CHECK 更换及新标记写入同一事务；任一失败回滚本次新结构。已有 v1 升级写 v2 标记失败时，原 star-only CHECK、旧标记和原行均保留。已有人手动换成两档约束但缺 v2 标记，仍视为异常，不静默接纳。普通连接失败后先重连并运行只读校验，再显式重试迁移。现有表的人工漂移须独立调查，不允许通过修改旧 SQL/hash 消除错误。

## 回退

首选关闭新增赠送写入口，保留两表、审计、统一权益解析器及已生效赠送读取。无需 DROP、重建库或改 paid membership。暂停新赠送不等于撤销已有赠送；撤销由有权限的单笔业务操作完成并留审计。

回退到不认识赠送来源或仅认识 star 赠送的旧二进制可能让受赠者失去访问，不能称无损回退；必须单独评估和批准。不能把包含 basic 行的约束收紧回 star-only，也不能删行来迁就旧版本。迁移没有自动 down/drop 数据操作。读取所需 schema 及两档解析器应随兼容版本保留。

## 验证范围

定向脚本：`node --test tests/collaboration/grant-migration.test.mjs`。覆盖独立安装与重复、旧完整安装保留数据/hash、v1→v2 保留行/标记、两档允许及其他档位拒绝、部分/无标记结构阻断、约束/hash漂移、v1/v2 标记失败事务回滚与重试、非隔离 schema 拒绝。虚构订单/会员/付款回执及所有 baseline 表前后逐表比较。

本测试使用 PGlite，不构成真实 PostgreSQL 多连接、生产备份恢复或云迁移证明。实际执行结果由交付证据记录，不因本说明列出测试而认定已通过。
