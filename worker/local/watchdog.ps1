# Watches the office Graph Call server and restarts it if it stops answering.
# Started at logon by "Graph Call Watchdog.vbs" in the Startup folder
# (created by worker\local\install.ps1).
#   powershell -File worker\local\watchdog.ps1 run
#   powershell -File worker\local\watchdog.ps1 stop     stop the service for good
param([string]$Action = 'run')

$root = Split-Path $PSScriptRoot -Parent
Set-Location $root
$logDir = Join-Path $PSScriptRoot 'logs'
New-Item -ItemType Directory -Force $logDir | Out-Null
$log = Join-Path $logDir 'watchdog.log'

$port = 4200
$intervalSeconds = 20
$failsToRestart = 3
$runScript = Join-Path $PSScriptRoot 'run.ps1'

function Stamp { Get-Date -Format 'yyyy-MM-dd HH:mm:ss' }
function Write-Log($message) { Add-Content -Path $log -Value "[$(Stamp)] $message" }

function Service-Running {
  (Get-CimInstance Win32_Process -Filter "Name='powershell.exe'" -ErrorAction SilentlyContinue |
    Where-Object { $_.CommandLine -and $_.CommandLine -like '*worker\local\run.ps1*' }).Count -gt 0
}

if ($Action -eq 'stop') {
  New-Item -ItemType File -Force (Join-Path $PSScriptRoot 'call-app.stop') | Out-Null
  Get-CimInstance Win32_Process -Filter "Name='powershell.exe'" -ErrorAction SilentlyContinue |
    Where-Object { $_.CommandLine -and $_.CommandLine -like '*worker\local\run.ps1*' } |
    ForEach-Object { Stop-Process -Id $_.ProcessId -Force -ErrorAction SilentlyContinue }
  Write-Log 'stop requested'
  exit 0
}

$fails = 0
Write-Log 'watchdog started'

while ($true) {
  $up = $false
  try {
    $r = Invoke-WebRequest "http://127.0.0.1:$port/healthz" -UseBasicParsing -TimeoutSec 5
    $up = ($r.StatusCode -eq 200)
  } catch {
    $up = $false
  }

  if ($up) {
    if ($fails -gt 0) { Write-Log 'answering again' }
    $fails = 0
  } else {
    $fails++
    Write-Log "not answering ($fails/$failsToRestart)"
    if ($fails -ge $failsToRestart) {
      Write-Log 'restarting the Graph Call service'
      try {
        Get-NetTCPConnection -State Listen -LocalPort $port -ErrorAction SilentlyContinue |
          ForEach-Object { Stop-Process -Id $_.OwningProcess -Force -ErrorAction SilentlyContinue }
      } catch {}
      Start-Sleep -Seconds 2
      if (-not (Service-Running)) {
        Start-Process 'powershell.exe' `
          -ArgumentList '-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-WindowStyle', 'Hidden', '-File', "`"$runScript`"" `
          -WindowStyle Hidden
      }
      $fails = 0
      Start-Sleep -Seconds 20
    }
  }

  Start-Sleep -Seconds $intervalSeconds
}
