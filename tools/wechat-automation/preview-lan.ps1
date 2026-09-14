$ErrorActionPreference = 'Stop'
$OutputEncoding = [Console]::OutputEncoding = [System.Text.UTF8Encoding]::new()
$projectRoot = [System.IO.Path]::GetFullPath((Join-Path $PSScriptRoot '..\..'))
. (Join-Path $projectRoot 'scripts/read-local-health.ps1')
$manifestPath = Join-Path $projectRoot 'work/wechat/lan-project.json'
if (-not (Test-Path -LiteralPath $manifestPath)) { throw '请先运行 scripts/start-lan.ps1 准备独立手机测试工程。' }
$manifest = Get-Content -LiteralPath $manifestPath -Raw -Encoding UTF8 | ConvertFrom-Json
$buildPath = [System.IO.Path]::GetFullPath($manifest.buildPath)
$allowedRoot = [System.IO.Path]::GetFullPath((Join-Path $projectRoot 'work/wechat/lan-builds')) + [System.IO.Path]::DirectorySeparatorChar
if (-not $buildPath.StartsWith($allowedRoot, [System.StringComparison]::OrdinalIgnoreCase)) { throw '预览工程不在本项目独立构建目录内，已停止。' }
$config = Get-Content -LiteralPath (Join-Path $buildPath 'project.config.json') -Raw -Encoding UTF8 | ConvertFrom-Json
if ($config.appid -ne $manifest.appId -or $config.appid -notmatch '^wx[0-9a-fA-F]{16}$') { throw '测试 AppID 不一致，已停止。' }
$health = Invoke-ClubLocalHealth -Uri ($manifest.apiBaseUrl + '/health') -TimeoutSec 3
if ($health.mode -ne 'lan-trial' -or $health.paymentReady -ne $false) { throw '独立手机测试服务尚未就绪。' }
$cli = Join-Path ${env:ProgramFiles(x86)} 'Tencent/微信web开发者工具/cli.bat'
if (-not (Test-Path -LiteralPath $cli)) { throw '未找到微信开发者工具 CLI。' }
$stamp = [DateTime]::UtcNow.ToString('yyyyMMdd-HHmmss')
$qrPath = Join-Path $projectRoot "work/wechat/phone-preview-$stamp.jpg"
$infoPath = Join-Path $projectRoot "work/wechat/phone-preview-$stamp-info.json"
& $cli preview --project $buildPath --qr-format image --qr-output $qrPath --info-output $infoPath
if ($LASTEXITCODE -ne 0) { throw '微信官方预览失败，没有创建正式发布版本。' }
$bytes = [System.IO.File]::ReadAllBytes($qrPath)
if ($bytes.Length -ge 8 -and $bytes[0] -eq 0x89 -and $bytes[1] -eq 0x50 -and $bytes[2] -eq 0x4E -and $bytes[3] -eq 0x47) {
    $pngPath = [System.IO.Path]::ChangeExtension($qrPath, '.png')
    Move-Item -LiteralPath $qrPath -Destination $pngPath
    $qrPath = $pngPath
} elseif ($bytes.Length -lt 4 -or $bytes[0] -ne 0xFF -or $bytes[1] -ne 0xD8) { throw '微信未返回可识别的二维码图片，请查看预览结果。' }
$preview = [pscustomobject]@{ createdAt = [DateTime]::UtcNow.ToString('o'); qrPath = $qrPath; buildPath = $buildPath; apiBaseUrl = $manifest.apiBaseUrl; phoneVerified = $false }
[System.IO.File]::WriteAllText((Join-Path $projectRoot 'work/wechat/lan-preview.json'), ($preview | ConvertTo-Json), [System.Text.UTF8Encoding]::new($false))
Write-Output "微信临时预览二维码：$qrPath"
Write-Output '手机须与电脑连接同一 Wi-Fi；预览不等于发布，实际手机联网与业务流程另行验收。'
