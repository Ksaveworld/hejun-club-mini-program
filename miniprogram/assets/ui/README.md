# UI-001 发布派生资产

品牌图直接来自 public/images/club-hero-embossed-v1.png 与 club-membership-guilloche-v1.png，原文件未修改。两张原图均无嵌入文字，标题及会员状态由页面文字呈现。

以 sharp resize({width:1000,withoutEnlargement:true}) / jpeg({quality:85,mozjpeg:true}) 派生，保留完整比例，不裁切、不重绘。首页 1000×417、26,797 bytes；会籍 1000×400、43,349 bytes。合计 70,146 bytes。已直接查看输出，山水压纹、金线保留，细微纸纹因缩小而弱化。

10 个图标 PNG 由 public/icons/iconpark-gold/ 同名 SVG 直接栅格化（density 216，resize 96×96）；不修改路径几何与配色。duotone / outline / selected 分别对应 双色 / 轮廓 / 选中。BookOpen、PeoplesTwo、Order、Edit 用于当前知识、活动、进度、反馈入口；Home、AllApplication、People 用于底部导航。沿用当前入口含义，不改变导航。

IconPark copyright 2019-present ByteDance Inc., Apache-2.0。项目原有香槟金配色派生继续保留；本次仅格式转换。许可证随附 LICENSE-IconPark。

图像运行资产总计 82,795 bytes，低于 300 KB 预算；不包含本说明与许可证。账户约定路径：/assets/ui/club-membership-guilloche-v1.jpg。
