$ErrorActionPreference = 'Stop'
$OutputEncoding = [Console]::OutputEncoding = [System.Text.UTF8Encoding]::new()
$runtimePath = Join-Path (Split-Path -Parent $PSScriptRoot) 'work/lan-test/runtime.json'
if (-not (Test-Path -LiteralPath $runtimePath)) { Write-Output '没有本项目 LAN 启动记录。'; exit 0 }
$runtime = Get-Content -LiteralPath $runtimePath -Raw -Encoding UTF8 | ConvertFrom-Json
$master = Get-CimInstance Win32_Process -Filter "ProcessId=$([int]$runtime.pid)" -ErrorAction SilentlyContinue
if (-not $master) { Write-Output '记录中的 LAN 启动进程已结束；未关闭其他进程。'; exit 0 }
$recordedTime = if ($runtime.startedAt -is [DateTime]) { $runtime.startedAt.ToUniversalTime() } else { [DateTimeOffset]::Parse([string]$runtime.startedAt).UtcDateTime }
if ($master.CommandLine -notmatch 'scripts[\\/]lan-dev\.mjs' -or [Math]::Abs(($master.CreationDate.ToUniversalTime() - $recordedTime).TotalSeconds) -gt 15) {
    throw '启动记录与实际进程不一致，停止操作已取消。'
}
foreach ($childId in $runtime.children) {
    $child = Get-CimInstance Win32_Process -Filter "ProcessId=$([int]$childId)" -ErrorAction SilentlyContinue
    if ($child -and $child.ParentProcessId -eq $master.ProcessId -and $child.CommandLine -match '(server[\\/]lan-index\.mjs|vite[\\/]bin[\\/]vite\.js.*--port\s+5196)') {
        Stop-Process -Id $child.ProcessId -ErrorAction SilentlyContinue
    }
}
$stillRunning = Get-CimInstance Win32_Process -Filter "ProcessId=$([int]$runtime.pid)" -ErrorAction SilentlyContinue
if ($stillRunning -and $stillRunning.CommandLine -eq $master.CommandLine) { Stop-Process -Id $stillRunning.ProcessId -ErrorAction SilentlyContinue }
Write-Output '本项目 LAN 服务已停止；数据库保留，原 5186/5187 服务未动。'
