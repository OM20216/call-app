# Keeps the office Graph Call server running.
# Started by the "Graph Call" scheduled task (see install.ps1). If Node stops or
# crashes it is started again after 10 seconds.
# Stop it for good: create worker\local\call-app.stop, or run install.ps1 -Uninstall.
$ErrorActionPreference = 'Continue'
$root = Split-Path $PSScriptRoot -Parent
Set-Location $root

$logDir = Join-Path $PSScriptRoot 'logs'
New-Item -ItemType Directory -Force $logDir | Out-Null
$log = Join-Path $logDir 'call-app.log'
$errLog = Join-Path $logDir 'call-app-error.log'
$stopFlag = Join-Path $PSScriptRoot 'call-app.stop'

$env:PORT = '4200'
Remove-Item $stopFlag -ErrorAction SilentlyContinue

function Stamp { Get-Date -Format 'yyyy-MM-dd HH:mm:ss' }

while ($true) {
  Add-Content -Path $log -Value "[$(Stamp)] service: starting Graph Call on port $env:PORT"
  # cmd keeps the redirected output in plain text (PowerShell 5 writes UTF-16)
  & cmd.exe /c "node local\server.mjs >> `"$log`" 2>> `"$errLog`""
  $code = $LASTEXITCODE
  if (Test-Path $stopFlag) {
    Remove-Item $stopFlag -ErrorAction SilentlyContinue
    Add-Content -Path $log -Value "[$(Stamp)] service: stopped on request"
    break
  }
  Add-Content -Path $log -Value "[$(Stamp)] service: node exited ($code) - restarting in 10 seconds"
  Start-Sleep -Seconds 10
}
