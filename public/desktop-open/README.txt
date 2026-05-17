FandF — "open project folder locally" helper
============================================

The folder button on hub.fandf.co.il copies the project's path and, if
this one-time helper is installed, also opens that folder directly in
File Explorer (Windows) / Finder (macOS) via Google Drive for Desktop.

You only need this if you want the one-click open. Without it the
button still copies the path and shows you how to paste it.

Requirements
------------
- Google Drive for Desktop installed and signed in (the shared drive
  must be mounted: G:\ on Windows, ~/Library/CloudStorage/... on Mac).

Install
-------
Windows:
  1. Download  install-windows.ps1
  2. Right-click it -> "Run with PowerShell"
     (it registers things for your user only — no admin needed)

macOS:
  1. Download  install-macos.command
  2. Right-click it -> Open -> Open  (first time, to get past Gatekeeper)
     or in Terminal:  bash ~/Downloads/install-macos.command

Then go back to the hub and click the folder button again. The browser
will ask once whether to allow opening the "fandfopen" link — allow it
(and tick "always") .

How it works / safety
---------------------
The button builds a link like:  fandfopen:<url-encoded path>
The helper decodes the path and hands it to explorer.exe / `open`.
That is all it does — it never executes the URL as a command, so a web
page cannot use this to run anything. The worst a malicious link could
do is open a file-manager window at some folder.

Uninstall
---------
Windows:
  - Delete registry key:  HKEY_CURRENT_USER\Software\Classes\fandfopen
  - Delete folder:        %LOCALAPPDATA%\FandFOpen
  (PowerShell one-liner:
   Remove-Item -Recurse -Force 'HKCU:\Software\Classes\fandfopen';
   Remove-Item -Recurse -Force "$env:LOCALAPPDATA\FandFOpen")

macOS:
  - Delete:  ~/Applications/FandF Open.app
  - (optional) refresh Launch Services:
    /System/Library/Frameworks/CoreServices.framework/Frameworks/\
    LaunchServices.framework/Support/lsregister -kill -r -domain local \
    -domain user
