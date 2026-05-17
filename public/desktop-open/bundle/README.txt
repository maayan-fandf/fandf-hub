FandF — "open project folder locally" helper
============================================

Makes the folder button on hub.fandf.co.il open the project's folder
directly in File Explorer (Windows) / Finder (macOS) via Google Drive
for Desktop, instead of only copying the path.

One-time setup, per machine, per user. No admin needed.

Requirement
-----------
Google Drive for Desktop installed and signed in, with the shared
drive mounted (G:\ on Windows, ~/Library/CloudStorage/... on macOS).

------------------------------------------------------------------
Windows  ->  open the  windows  folder
------------------------------------------------------------------
  Install:    double-click  install.cmd
  Uninstall:  double-click  uninstall.cmd

(If Windows blocks .cmd too, open PowerShell and paste the snippet
 from  hub.fandf.co.il/help/open-locally  — same result.)

------------------------------------------------------------------
macOS  ->  open the  macos  folder
------------------------------------------------------------------
  Install:    right-click  install.command   -> Open -> Open
  Uninstall:  right-click  uninstall.command -> Open
  (first time only, "Open" twice, to get past Gatekeeper)

  If double-click does nothing (zip didn't keep the +x bit), open
  Terminal in this macos folder and run:
      bash ./install.command
      bash ./uninstall.command

------------------------------------------------------------------
After installing
------------------------------------------------------------------
Go back to the hub, hard-refresh the page (Ctrl+F5 / Cmd+Shift+R),
click the folder button, and ALLOW the one-time browser prompt
"Open FandF Open?" (tick "always").

Safety
------
The helper only ever passes the decoded path to explorer.exe / `open`
— it never runs the URL as a command. The worst a malicious link
could do is open a file-manager window at some folder. It's safe to
install/uninstall repeatedly.
