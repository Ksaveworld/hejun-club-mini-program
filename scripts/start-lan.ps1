param([string]$Address)
$ErrorActionPreference = 'Stop'
$OutputEncoding = [Console]::OutputEncoding = [System.Text.UTF8Encoding]::new()
$projectRoot = Split-Path -Parent $PSScriptRoot
Set-Location -LiteralPath $projectRoot
. (Join-Path $PSScriptRoot 'read-local-health.ps1')
$activeAdapters = @(Get-NetAdapter -Physical | Where-Object Status -eq 'Up')
$candidates = @($activeAdapters | ForEach-Object {
    Get-NetIPAddress -InterfaceIndex $_.InterfaceIndex -AddressFamily IPv4 -ErrorAction SilentlyContinue |
      Where-Object { $_.IPAddress -match '^(10\.|192\.168\.|172\.(1[6-9]|2[0-9]|3[01])\.)' -and $_.AddressState -eq 'Preferred' }
})
if ($Address) { $candidates = @($candidates | Where-Object IPAddress -eq $Address) }
if ($candidates.Count -ne 1) { throw '没有唯一可用的物理局域网地址。请检查 Wi-Fi，或使用 -Address 指定当前物理网卡地址；不会使用 VPN 地址。' }
$lanAddress = $candidates[0].IPAddress
$lanPrefixLength = $candidates[0].PrefixLength
$apiUrl = "http://${lanAddress}:5198/api"
$buildJson = & node scripts/prepare-lan-miniprogram.mjs --address $lanAddress
if ($LASTEXITCODE -ne 0) { throw '原生手机预览包生成失败，尚未启动新服务。' }
$build = $buildJson | ConvertFrom-Json
$ready = $false
try { $health = Invoke-ClubLocalHealth -Uri "$apiUrl/health" -TimeoutSec 2; $ready = $health.mode -eq 'lan-trial' -and $health.paymentReady -eq $false } catch { }
$launchedMaster = $null
try {
if (-not $ready) {
    $occupied = @(Get-NetTCPConnection -State Listen -LocalPort 5196,5198 -ErrorAction SilentlyContinue)
    if ($occupied.Count) { throw '5196 或 5198 已被占用，请检查现有进程；不会关闭其他服务。' }
    $logDirectory = Join-Path $projectRoot 'work/lan-test'
    New-Item -ItemType Directory -Force -Path $logDirectory | Out-Null
    $launchedMaster = Start-Process -FilePath (Get-Command node.exe).Source -ArgumentList @('scripts/lan-dev.mjs', '--address', $lanAddress, '--prefix-length', "$lanPrefixLength") -WorkingDirectory $projectRoot -WindowStyle Hidden -RedirectStandardOutput (Join-Path $logDirectory 'dev.stdout.log') -RedirectStandardError (Join-Path $logDirectory 'dev.stderr.log') -PassThru
    for ($attempt = 0; $attempt -lt 30; $attempt++) {
        Start-Sleep -Milliseconds 300
        try { $health = Invoke-ClubLocalHealth -Uri "$apiUrl/health" -TimeoutSec 2; $ready = $health.mode -eq 'lan-trial' -and $health.paymentReady -eq $false } catch { }
        if ($ready) {
            try { $adminHealth = Invoke-ClubLocalHealth -Uri 'http://127.0.0.1:5196/api/health' -TimeoutSec 2; $ready = $adminHealth.mode -eq 'lan-trial' } catch { $ready = $false }
        }
        if ($ready) { break }
        if ($launchedMaster.HasExited) { throw '局域网启动进程已退出，请查看 work/lan-test/dev.stderr.log。' }
    }
    if (-not $ready) { throw '局域网测试服务未启动，请查看 work/lan-test/dev.stderr.log。' }
}
$adminHealth = Invoke-ClubLocalHealth -Uri 'http://127.0.0.1:5196/api/health' -TimeoutSec 2
if ($adminHealth.mode -ne 'lan-trial') { throw '5196 后台没有连接独立 LAN 数据服务。' }
} catch {
    # Clean up only the process just created by this invocation. Reused services stay intact.
    if ($launchedMaster -and -not $launchedMaster.HasExited) {
        $newChildren = @(Get-CimInstance Win32_Process -Filter "ParentProcessId=$($launchedMaster.Id)" -ErrorAction SilentlyContinue)
        foreach ($newChild in $newChildren) { Stop-Process -Id $newChild.ProcessId -ErrorAction SilentlyContinue }
        Stop-Process -InputObject $launchedMaster -ErrorAction SilentlyContinue
    }
    throw
}
Write-Output "手机测试 API：$apiUrl"
Write-Output '本机独立后台：http://127.0.0.1:5196/#/admin'
Write-Output '独立管理员资料：work/lan-test/admin.txt（仅本机查看，不发聊天）'
Write-Output "微信预览工程：$($build.buildPath)"
Write-Output '手机须与电脑连接同一 Wi-Fi。本脚本未修改防火墙；本机健康检查不代表手机已连通。'
