param([switch]$NoBrowser)
$ErrorActionPreference = 'Stop'
$OutputEncoding = [Console]::OutputEncoding = [System.Text.UTF8Encoding]::new()
$projectRoot = Split-Path -Parent $PSScriptRoot
Set-Location -LiteralPath $projectRoot
function Test-ClubReady {
  try {
    $health = Invoke-RestMethod -Uri 'http://127.0.0.1:5186/api/health' -TimeoutSec 2
    return $health.status -eq 'ok' -and $health.mode -eq 'local-trial' -and $health.storage -eq 'sqlite'
  } catch { return $false }
}
if (-not (Test-ClubReady)) {
  $occupied = Get-NetTCPConnection -State Listen -LocalPort 5186,5187 -ErrorAction SilentlyContinue
  if ($occupied) { throw '5186 或 5187 端口已被占用，请先检查已有服务；本脚本不会关闭其他程序。' }
  New-Item -ItemType Directory -Force -Path (Join-Path $projectRoot 'work') | Out-Null
  Start-Process -FilePath (Get-Command node.exe).Source -ArgumentList 'scripts/dev.mjs' -WorkingDirectory $projectRoot -WindowStyle Hidden -RedirectStandardOutput (Join-Path $projectRoot 'work/dev.stdout.log') -RedirectStandardError (Join-Path $projectRoot 'work/dev.stderr.log') | Out-Null
  $ready = $false
  for ($attempt = 0; $attempt -lt 30; $attempt++) {
    Start-Sleep -Milliseconds 300
    if (Test-ClubReady) { $ready = $true; break }
  }
  if (-not $ready) { throw '启动未完成，请查看 work/dev.stderr.log。' }
}
Write-Output '会员内测服务已就绪：http://127.0.0.1:5186/'
if (-not $NoBrowser) { Start-Process 'http://127.0.0.1:5186/' }
