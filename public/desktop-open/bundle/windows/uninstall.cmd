@echo off
REM FandF "open folder locally" helper — Windows uninstall launcher.
REM Double-click this. Removes the fandfopen: scheme + handler folder.
powershell -NoProfile -ExecutionPolicy Bypass -File "%~dp0uninstall.ps1"
