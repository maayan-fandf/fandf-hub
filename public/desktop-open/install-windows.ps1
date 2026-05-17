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
#             (if that does nothing, the inline snippet on
#              hub.fandf.co.il/help/open-locally always works)
# UNINSTALL:  see README.txt
# ---------------------------------------------------------------------

try {
  $dir = Join-Path $env:LOCALAPPDATA 'FandFOpen'
  New-Item -ItemType Directory -Force -Path $dir | Out-Null
  $handler = Join-Path $dir 'open.ps1'

  # Built as an array of single-quoted lines (NOT a here-string) so it
  # survives copy-paste into an interactive console and odd line
  # endings. The lines use ONLY double quotes internally so single
  # quoting them here needs no escaping. $vars below belong to the
  # handler, not this installer.
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

  # Verify it actually took, instead of assuming.
  $check = (Get-ItemProperty -Path 'HKCU:\Software\Classes\fandfopen\shell\open\command' -Name '(default)' -ErrorAction Stop).'(default)'
  if ($check -eq $run -and (Test-Path -LiteralPath $handler)) {
    Write-Host ''
    Write-Host '  [OK] Installed for your user. Registry + handler verified.' -ForegroundColor Green
    Write-Host '       Go back to the hub, hard-refresh (Ctrl+F5), and click the'
    Write-Host '       folder button again. Allow the "Open FandF Open?" prompt.'
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
  Write-Host ''
  Write-Host '  Use the copy-paste snippet on hub.fandf.co.il/help/open-locally'
  Write-Host '  instead — it does the same thing in your existing PowerShell.'
}
finally {
  # ALWAYS pause, even on error, so the window never vanishes before
  # you can read the result.
  Write-Host ''
  Write-Host '  Press any key to close...'
  try { $null = $Host.UI.RawUI.ReadKey('NoEcho,IncludeKeyDown') } catch { Start-Sleep 8 }
}
