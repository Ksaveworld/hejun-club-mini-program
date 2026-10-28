# 原生小程序开发

## 2026-09-30迁移接续

最新：服务名录已改为原生JS模块，规范JSON仍共享网页；改名录后运行`npm run native:data`，用`npm run native:check`核对同步与JS模块。云传输代码已准备但默认未启用，真实env/service及服务HTTPS文件入口核验后才配置；当前本机域名错误仍待云接入。218项本地检查、网页构建通过，不等于微信编译/真机或正式云。新资源账号、SQL改造、费用和回退见`../docs/handoff/u52-cloud-preparation.md`。

在微信开发者工具选择“导入”，目录选择本目录 `hejun-club-mini-program/miniprogram`，不是React工程根目录，也不是创建空的云开发模板。Ethan已核对本工程AppID `wx47d5e3e20fd77f65` 是客户小程序账号，不需要为了导入更换AppID或开通云开发。

目前仍是原生开发工程：17个页面、默认连接本机API；不等于U51网页版功能已经全部迁入，更不等于已可上传正式发布。完整迁移范围与接口/老会员保护方案见 `../docs/handoff/u52-native-migration.md`。在仓库根目录可运行 `node scripts/check-native-migration.mjs` 做只读结构检查，它不能替代微信编译器和真机验证。

先阅读仓库根目录 README，使用自己的 AppID 导入本目录。默认本机 API 为 `http://127.0.0.1:5187/api`，手机无法访问电脑回环地址。

同 Wi-Fi 预览先在仓库根目录运行 `scripts/start-lan.ps1`，再运行 `tools/wechat-automation/preview-lan.ps1`。脚本会生成独立包，不修改原工程的请求地址。微信开发者工具需要本人账号登录和相应项目权限。

微信真实身份由服务端换码，AppSecret只放在被忽略的服务端私有配置。AppID已确认，但正式原生接入、当前平台配置、老账号关联和真机仍待迁移验收；本机内测账号不能作为真实登录、收款或发布的证明。

第一批本地迁移已补：首页活动、四类问卷、企业材料、协议确认和活动原图。隔离预览在仓库根目录运行 node scripts/native-migration-server.mjs，仅使用内存测试数据，停止即清空；当前协议仅沿用网页版本供迁移测试。正式登录、老会员关联、人工核账和微信验收仍未完成，详见 ../docs/handoff/u52-native-forms.md。
