# 微信开发者工具自动化

安装：`npm ci --prefix tools/wechat-automation`。微信开发者工具需在 Windows 默认目录安装、登录并开启 CLI/HTTP 调用；工程必须使用自己的有效 AppID。

在仓库根目录依次运行 `scripts/start-local.ps1 -NoBrowser`、`tools/wechat-automation/start.ps1 -LocalApi`，然后运行 `npm run check --prefix tools/wechat-automation`。更多检查见本目录 package.json。

脚本共用模拟器和测试端口，请顺序执行。报告及临时原生包在被忽略的 `work/wechat/` 下；模拟器渲染和页面处理函数检查不等于真机、真实点击输入、真实支付或发布验收。业务脚本使用独立测试数据。
