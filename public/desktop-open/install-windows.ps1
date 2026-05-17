# FandF "open folder locally" helper — Windows installer
# ---------------------------------------------------------------------
# Registers the  fandfopen:  URL scheme for the CURRENT USER only
# (HKCU — no admin / UAC) so the folder button on hub.fandf.co.il can
# open a project's folder in File Explorer via Google Drive for Desktop.
#
# What this does (please review before running):
#   1. Writes a tiny handler to  %LOCALAPPDATA%\FandFOpen\open.ps1
#   2. Points  HKCU\Software\Classes\fandfopen  at that handler
#
# The handler ONLY ever hands the decoded path to explorer.exe — it
# never runs the URL as a command, so a web page cannot use this to
# execute anything; the worst a bad link could do is open Explorer at
# some folder.
#
# INSTALL:    right-click this file  ->  "Run with PowerShell"
# UNINSTALL:  see README.txt (delete the reg key + the folder)
# ---------------------------------------------------------------------

$ErrorActionPreference = 'Stop'

$dir = Join-Path $env:LOCALAPPDATA 'FandFOpen'
New-Item -ItemType Directory -Force -Path $dir | Out-Null
$handler = Join-Path $dir 'open.ps1'

# Single-quoted here-string => written verbatim (the $vars below belong
# to the handler, not this installer).
@'
param([string]$u)
try {
  $raw  = $u -replace '^fandfopen:', ''
  $path = [uri]::UnescapeDataString($raw)
  $path = $path.Replace("/", "\")
  # Drive Desktop may not have synced the deepest folder yet — walk up
  # to the closest ancestor that exists so Explorer still opens.
  $cur = $path
  while ($cur -and -not (Test-Path -LiteralPath $cur)) {
    $cur = Split-Path -Parent $cur
  }
  if ($cur) {
    Start-Process explorer.exe -ArgumentList ([char]34 + $cur + [char]34)
  }
} catch { }
'@ | Set-Content -LiteralPath $handler -Encoding UTF8

$base = 'HKCU:\Software\Classes\fandfopen'
New-Item -Path $base -Force | Out-Null
Set-ItemProperty -Path $base -Name '(default)'   -Value 'URL:FandF Open'
Set-ItemProperty -Path $base -Name 'URL Protocol' -Value ''
$cmdKey = Join-Path $base 'shell\open\command'
New-Item -Path $cmdKey -Force | Out-Null
# -File (not -Command) => the URL is a real argument bound to param(),
# never concatenated into source. No injection surface.
$run = 'powershell -NoProfile -WindowStyle Hidden -ExecutionPolicy Bypass -File "' + $handler + '" "%1"'
Set-ItemProperty -Path $cmdKey -Name '(default)' -Value $run

Write-Host ''
Write-Host '  [OK] Installed for your user.' -ForegroundColor Green
Write-Host '       Go back to the hub and click the folder button again.'
Write-Host ''
Write-Host '  Press any key to close...'
$null = $Host.UI.RawUI.ReadKey('NoEcho,IncludeKeyDown')
