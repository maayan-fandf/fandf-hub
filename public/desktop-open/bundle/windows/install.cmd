@echo off
REM FandF "open folder locally" helper — Windows install launcher.
REM Double-click this. It runs install.ps1 (next to it) with the
REM execution policy bypassed, so it works even when double-clicking
REM a .ps1 just opens an editor / "Run with PowerShell" is blocked.
powershell -NoProfile -ExecutionPolicy Bypass -File "%~dp0install.ps1"
