# FandF "open folder locally" helper — Windows uninstaller.
# Removes the fandfopen: scheme + the handler folder. Safe to run
# even if they were never installed. Easiest: double-click uninstall.cmd
$ErrorActionPreference = 'SilentlyContinue'
Remove-Item -Recurse -Force 'HKCU:\Software\Classes\fandfopen'
Remove-Item -Recurse -Force "$env:LOCALAPPDATA\FandFOpen"
Write-Host ''
Write-Host '  [OK] Uninstalled (or it was already absent).' -ForegroundColor Green
Write-Host ''
Write-Host '  Press any key to close...'
try { $null = $Host.UI.RawUI.ReadKey('NoEcho,IncludeKeyDown') } catch { Start-Sleep 6 }
