#!/bin/bash
# FandF "open folder locally" helper — macOS uninstaller.
# Removes the handler app. Safe to run even if it was never installed.
# RUN: right-click -> Open  (or: bash "uninstall.command")
rm -rf "$HOME/Applications/FandF Open.app"
echo ""
echo "  [OK] Removed ~/Applications/FandF Open.app (if it existed)."
echo ""
read -n 1 -s -r -p "  Press any key to close..."
echo ""
