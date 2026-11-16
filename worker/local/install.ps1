# Installs (or removes) the logon startup entries that keep Graph Call running
# on this PC, the same way the LOTS CRM runs: it starts when you sign in to
# Windows, restarts itself if Node crashes, and a watchdog restarts it if it
# stops answering.
#
#   powershell -ExecutionPolicy Bypass -File worker\local\install.ps1
#   powershell -ExecutionPolicy Bypass -File worker\local\install.ps1 -Uninstall
#
# No administrator rights needed: it writes two hidden launchers into the
# current user's Startup folder.
#   Graph Call.lnk behaviour -> worker\local\run.ps1
#   Graph Call Watchdog      -> worker\local\watchdog.ps1
param([switch]$Uninstall)

$ErrorActionPreference = 'Stop'
$local = $PSScriptRoot
$root = Split-Path $local -Parent
$startup = [Environment]::GetFolderPath('Startup')
$runLauncher = Join-Path $startup 'Graph Call.vbs'
$watchLauncher = Join-Path $startup 'Graph Call Watchdog.vbs'

function New-Launcher($path, $script) {
  $body = @"
' Starts Graph Call in the background (no window). Created by worker\local\install.ps1.
Set sh = CreateObject("WScript.Shell")
sh.Run "powershell.exe -NoProfile -NonInteractive -ExecutionPolicy Bypass -WindowStyle Hidden -File ""$script""", 0, False
"@
  Set-Content -Path $path -Value $body -Encoding ASCII
}

function Stop-Service {
  try {
    Get-NetTCPConnection -State Listen -LocalPort 4200 -ErrorAction SilentlyContinue |
      ForEach-Object { Stop-Process -Id $_.OwningProcess -Force -ErrorAction SilentlyContinue }
  } catch {}
  Get-CimInstance Win32_Process -Filter "Name='powershell.exe'" -ErrorAction SilentlyContinue |
    Where-Object { $_.CommandLine -and $_.CommandLine -like '*worker\local\run.ps1*' } |
    ForEach-Object { Stop-Process -Id $_.ProcessId -Force -ErrorAction SilentlyContinue }
}

if ($Uninstall) {
  Stop-Service
  Remove-Item $runLauncher, $watchLauncher -Force -ErrorAction SilentlyContinue
  Write-Host 'Graph Call is stopped and will not start at logon any more.'
  exit 0
}

New-Item -ItemType Directory -Force (Join-Path $local 'logs') | Out-Null
New-Item -ItemType Directory -Force (Join-Path $local 'data') | Out-Null

New-Launcher $runLauncher (Join-Path $local 'run.ps1')
New-Launcher $watchLauncher (Join-Path $local 'watchdog.ps1')
Write-Host "installed: $runLauncher"
Write-Host "installed: $watchLauncher"

# Start both now, so the link works without signing out first.
$alreadyUp = $false
try {
  $r = Invoke-WebRequest 'http://127.0.0.1:4200/healthz' -UseBasicParsing -TimeoutSec 3
  $alreadyUp = ($r.StatusCode -eq 200)
} catch {}

if (-not $alreadyUp) {
  Start-Process 'wscript.exe' -ArgumentList "`"$runLauncher`"" -WindowStyle Hidden
  Start-Sleep -Seconds 3
}
$watchRunning = (Get-CimInstance Win32_Process -Filter "Name='powershell.exe'" -ErrorAction SilentlyContinue |
  Where-Object { $_.CommandLine -and $_.CommandLine -like '*worker\local\watchdog.ps1*' }).Count -gt 0
if (-not $watchRunning) {
  Start-Process 'wscript.exe' -ArgumentList "`"$watchLauncher`"" -WindowStyle Hidden
}

$ip = (Get-NetIPConfiguration |
  Where-Object { $_.IPv4Address -and $_.IPv4DefaultGateway } |
  Select-Object -First 1).IPv4Address.IPAddress

Write-Host ''
Write-Host "Local check:  http://127.0.0.1:4200/healthz"
Write-Host "Office link:  http://${ip}:4200"
Write-Host "Hostname:     http://${env:COMPUTERNAME}:4200"
