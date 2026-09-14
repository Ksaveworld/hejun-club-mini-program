param([switch]$LocalApi)
$ErrorActionPreference = 'Stop'
$OutputEncoding = [Console]::OutputEncoding = [System.Text.UTF8Encoding]::new()
$projectDir = [System.IO.Path]::GetFullPath((Join-Path $PSScriptRoot '..\..\miniprogram'))
$configPath = Join-Path $projectDir 'project.config.json'
$projectConfig = Get-Content -LiteralPath $configPath -Raw -Encoding UTF8 | ConvertFrom-Json
if ($projectConfig.appid -notmatch '^wx[0-9a-fA-F]{16}$') {
    throw '请先在测试工程填写有效的测试 AppID。'
}
$cliPath = Join-Path ${env:ProgramFiles(x86)} 'Tencent\微信web开发者工具\cli.bat'
if (-not (Test-Path -LiteralPath $cliPath -PathType Leaf)) {
    throw '未在默认安装位置找到微信开发者工具 CLI。'
}
if ($LocalApi) {
    $privatePath = Join-Path $projectDir 'project.private.config.json'
    $privateConfig = if (Test-Path -LiteralPath $privatePath) { Get-Content -LiteralPath $privatePath -Raw -Encoding UTF8 | ConvertFrom-Json } else { [pscustomobject]@{} }
    if (-not $privateConfig.setting) { $privateConfig | Add-Member -NotePropertyName setting -NotePropertyValue ([pscustomobject]@{}) -Force }
    $privateConfig.setting | Add-Member -NotePropertyName urlCheck -NotePropertyValue $false -Force
    [System.IO.File]::WriteAllText($privatePath, ($privateConfig | ConvertTo-Json -Depth 30), [System.Text.UTF8Encoding]::new($false))
    Write-Output '仅本工程模拟器允许连接本机测试服务；正式项目配置的域名检查保持开启。'
}
& $cliPath auto --project $projectDir --auto-port 9420 --trust-project --lang zh
if ($LASTEXITCODE -ne 0) { throw '开发者工具未接受自动化启动请求。' }
Write-Output '启动请求已完成；页面初始化后运行 npm run check --prefix tools/wechat-automation 进行验证。'
