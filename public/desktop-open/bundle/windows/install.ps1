# FandF "open folder locally" helper — Windows installer
# ---------------------------------------------------------------------
# Registers the  fandfopen:  URL scheme for the CURRENT USER only
# (HKCU — no admin / UAC) so the folder button on hub.fandf.co.il can
# open a project's folder in File Explorer via Google Drive for Desktop.
#
#   1. Writes a tiny handler to  %LOCALAPPDATA%\FandFOpen\open.ps1
#   2. Points  HKCU\Software\Classes\fandfopen  at that handler
#
# The handler ONLY ever hands the decoded path to explorer.exe — it
# never runs the URL as a command, so a web page cannot use this to
# execute anything; the worst a bad link could do is open Explorer at
# some folder. Safe to re-run any time (idempotent).
#
# Easiest: double-click  install.cmd  (next to this file).
# ---------------------------------------------------------------------

try {
  $dir = Join-Path $env:LOCALAPPDATA 'FandFOpen'
  New-Item -ItemType Directory -Force -Path $dir | Out-Null
  $handler = Join-Path $dir 'open.ps1'

  # Array of single-quoted lines (NOT a here-string) so it survives
  # copy-paste / odd line endings. Lines use ONLY double quotes
  # internally => no escaping needed. $vars belong to the handler.
  $body = @(
    'param([string]$u)'
    'try {'
    '  $p = [uri]::UnescapeDataString(($u -replace "^fandfopen:","")).Replace("/","\")'
    '  $c = $p'
    '  while ($c -and -not (Test-Path -LiteralPath $c)) { $c = Split-Path -Parent $c }'
    '  if ($c) { Start-Process explorer.exe -ArgumentList ([char]34 + $c + [char]34) }'
    '} catch { }'
  )
  Set-Content -LiteralPath $handler -Value $body -Encoding UTF8

  # -File (not -Command) => the URL is a real argument bound to
  # param(), never concatenated into source. No injection surface.
  $run = 'powershell -NoProfile -WindowStyle Hidden -ExecutionPolicy Bypass -File "' + $handler + '" "%1"'
  New-Item -Path 'HKCU:\Software\Classes\fandfopen\shell\open\command' -Force | Out-Null
  Set-ItemProperty -Path 'HKCU:\Software\Classes\fandfopen' -Name '(default)' -Value 'URL:FandF Open'
  Set-ItemProperty -Path 'HKCU:\Software\Classes\fandfopen' -Name 'URL Protocol' -Value ''
  Set-ItemProperty -Path 'HKCU:\Software\Classes\fandfopen\shell\open\command' -Name '(default)' -Value $run

  $check = (Get-ItemProperty -Path 'HKCU:\Software\Classes\fandfopen\shell\open\command' -Name '(default)' -ErrorAction Stop).'(default)'
  if ($check -eq $run -and (Test-Path -LiteralPath $handler)) {
    Write-Host ''
    Write-Host '  [OK] Installed for your user. Registry + handler verified.' -ForegroundColor Green
    Write-Host '       Go to the hub, hard-refresh (Ctrl+F5), click the folder'
    Write-Host '       button, and allow the "Open FandF Open?" prompt.'
  } else {
    Write-Host ''
    Write-Host '  [!] Wrote the keys but verification did not match.' -ForegroundColor Yellow
    Write-Host "      Handler: $handler"
    Write-Host "      Command: $check"
  }
}
catch {
  Write-Host ''
  Write-Host '  [X] Install FAILED:' -ForegroundColor Red
  Write-Host "      $($_.Exception.Message)"
  Write-Host '  Use the copy-paste snippet on hub.fandf.co.il/help/open-locally'
}
finally {
  Write-Host ''
  Write-Host '  Press any key to close...'
  try { $null = $Host.UI.RawUI.ReadKey('NoEcho,IncludeKeyDown') } catch { Start-Sleep 8 }
}
