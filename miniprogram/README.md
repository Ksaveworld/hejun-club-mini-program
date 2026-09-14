# 原生小程序开发

先阅读仓库根目录 README，使用自己的 AppID 导入本目录。默认本机 API 为 `http://127.0.0.1:5187/api`，手机无法访问电脑回环地址。

同 Wi-Fi 预览先在仓库根目录运行 `scripts/start-lan.ps1`，再运行 `tools/wechat-automation/preview-lan.ps1`。脚本会生成独立包，不修改原工程的请求地址。微信开发者工具需要本人账号登录和相应项目权限。

微信真实身份由服务端换码，AppSecret 只放在被忽略的服务端私有配置。当前仓库默认占位账号不能真实登录、收款或发布。
