# 中国—东盟跨境企业家俱乐部 · 小程序与管理后台

原生微信小程序会员端、React 管理后台与 Node.js/SQLite 业务服务的开发中源码。

本仓库发布当前工作区的源码快照，包括已完成但尚未提交到原工作区的界面与原生/LAN 改动。源码公开不代表正式上线：真实微信登录、支付、退款、奖励结算与提现等仍需完成配置、开发及验收。

## 目录

- `miniprogram/`：原生会员端、申请与订单、资讯知识、投稿、活动、服务资源和推荐卡片。
- `src/`、`public/`：网页界面、运营后台、字体和图标资源。
- `server/`：账号、会话、订单审核、内容和附件权限、服务资源及测试环境服务。
- `scripts/`、`deployment/`：本机启动、备份、报告导入和部署模板。
- `tests/`、`tools/wechat-automation/`：隔离测试与微信开发者工具自动化。

## 本机运行

开发基线为 Node.js 22.22.2 或兼容的 Node.js 22 后续版本，需支持内置 `node:sqlite`。

```sh
npm ci
npm run dev
```

网页：http://127.0.0.1:5186/ ，后台：http://127.0.0.1:5186/#/admin ，API：127.0.0.1:5187。
首次启动会创建本机独立数据库和随机管理员凭据，保存在被忽略的 `work/` 中。请使用虚构资料和独立内测密码。

微信开发者工具导入 `miniprogram/`，先将 `project.config.json` 内的占位 AppID 换成自己的合法 AppID。本机模拟器使用 `miniprogram/config.js` 中的回环地址；手机预览需要按本机网卡生成独立 LAN 包。微信服务端密钥通过 `server/.env.local` 配置，参考 `server/.env.example`，不要写入小程序端或提交仓库。

## 检查

```sh
npm run build
npm run test:server
npm run test:miniprogram
npm run test:e2e
```

网页浏览器测试沿用 Windows Edge 默认安装路径；其他系统运行前需调整 Playwright 配置。微信自动化需另装依赖：`npm ci --prefix tools/wechat-automation`，随后按该目录说明使用已登录的微信开发者工具。

## 公开配置与部署边界

- 实际 AppID、测试域名及 SSH 主机信息已换为占位配置；`example.com` 不提供本项目 API。远程模板的域名和访问保护必须成套配置后验证。
- SSH 部署脚本要求 `CLUB_SSH_HOST` 和 `CLUB_SSH_HOST_KEY_SHA256` 环境变量，并交互输入密码；它不会随本机启动或测试自动执行。部署模板须按目标机器评估，不能直接当作生产发布方案。
- 不包含实际数据库、用户订单、管理员凭据、密钥、原始行业报告 PDF、报告试看文件、备份、运行日志、内部沟通与采购记录、历史 Git 仓库或已安装依赖。
- 新检出项目的数据为空；报告需由有权使用该资料的一方通过导入脚本自行导入。依赖 PDF 处理的 Python 脚本使用 `pypdf`/`pypdfium2`，SSH 辅助脚本使用 `paramiko`，按需安装。
- 字体及图标的上游许可文件保留在 `public/` 对应目录；本仓库未另行授予项目整体或品牌素材的开源许可证。

本机内测、模拟器、真机、真实支付、生产上线分别需要对应验收。测试夹具只用于隔离环境。
