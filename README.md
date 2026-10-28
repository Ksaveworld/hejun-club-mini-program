# 独立赠送会籍协作源码（2026-10-28）

当前分支是独立集成候选：后端、后台页面及原生消费已装配，验证与剩余条件见 [GRANT-03集成记录](docs/collaboration/GRANT-03-integration-validation.md)。以下原始分工用于追溯；本候选的共享改动单独交统一集成，不直接覆盖对方工作分支。真实写入仍关闭。

这是从已核对的本地集成源码导出的开发快照，不是正式部署包。内部环境、费用、供应商沟通和历史交接日志未纳入；原本地历史保留。公开分支基于远程旧main建立单次源码快照，不能整支合入本地集成树；后续仅挑选GRANT开发增量提交。

## 康莹开工

从本分支实际远程HEAD新开 `feat/grant-01-backend`，读取 `docs/collaboration/GRANT-01-康莹后端任务书.md` 及 `docs/tasks/GRANT-00.md`。Issue #2提供最终起始SHA。旧任务书中的本机路径、旧本地SHA仅供追溯，以本说明和Issue最新开工记录为准。任务书中的未推送、权限不足和不对外发消息描述是此前状态，不再作为本次派工阻断。

`server/collaboration/` 与对应两个测试来自K3候选，供复用，未装配生产运行时；现有策略仍是旧候选，必须按已确认规则适配。不得因为文件存在就宣称赠送已启用。不要整份重跑含协会表的schema；先交最小依赖和迁移适配。

## 本地检查

使用Node 24；`npm ci --ignore-scripts --no-audit --no-fund`，`npm run build`，`npm run test:baseline`，`node --test tests/collaboration/grants.test.mjs`。`npm run check:baseline` 按本导出的 `docs/collaboration/GRANT-SOURCE-MANIFEST.json` 核对源码Git blob；后续业务修改后应使用差异审查，不把预期的源码变化误判为发布错误。

小程序配置仅连接127.0.0.1，本地页面运行 `npm run dev`；不连接云数据库、不导入客户数据、不部署。测试账号全部虚构。原生版本及云端状态未在本次核验。

## 文件归属

康莹：独立赠送/权益/身份定位模块、对应测试、迁移提案。我方：独立后台页面及界面测试、适配器、手机显示、共享路由/导航/类型/迁移登记的统一接入。先冻结API契约，再各自开发；不要双方同时修改共享入口。康莹提交PR到本协作分支供审查，不直接合main或部署。
