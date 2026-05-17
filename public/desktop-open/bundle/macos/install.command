#!/bin/bash
# FandF "open folder locally" helper — macOS installer
# ---------------------------------------------------------------------
# Registers the  fandfopen:  URL scheme so the folder button on
# hub.fandf.co.il opens a project's folder in Finder via Google Drive
# for Desktop. Per-user, no sudo. Safe to re-run (idempotent).
#
# It builds a tiny handler app at  ~/Applications/FandF Open.app  whose
# only job is: decode the path and hand it to `open` (just reveals a
# folder). It never runs the URL as a command.
#
# RUN:  right-click -> Open -> Open   (first time, past Gatekeeper)
#       or in Terminal:  bash "install.command"
# ---------------------------------------------------------------------
set -e

APP="$HOME/Applications/FandF Open.app"
mkdir -p "$HOME/Applications"
rm -rf "$APP"

WORK="$(mktemp -d)"
cat > "$WORK/handler.applescript" <<'OSA'
on open location this_URL
	do shell script "u=" & quoted form of this_URL & "
r=\"${u#fandfopen:}\"
p=$(printf '%s' \"$r\" | /usr/bin/perl -pe 's/%([0-9A-Fa-f]{2})/chr(hex($1))/ge')
case \"$p\" in
  \"~/\"*) p=\"$HOME/${p#~/}\" ;;
  \"~\")   p=\"$HOME\" ;;
esac
if [ -d \"$p\" ]; then open \"$p\"; else open \"$(dirname \"$p\")\"; fi"
end open location
OSA

/usr/bin/osacompile -o "$APP" "$WORK/handler.applescript"
rm -rf "$WORK"

PLIST="$APP/Contents/Info.plist"
PB=/usr/libexec/PlistBuddy
"$PB" -c "Add :CFBundleIdentifier string co.fandf.open" "$PLIST" 2>/dev/null \
  || "$PB" -c "Set :CFBundleIdentifier co.fandf.open" "$PLIST"
"$PB" -c "Add :LSUIElement bool true" "$PLIST" 2>/dev/null \
  || "$PB" -c "Set :LSUIElement true" "$PLIST"
"$PB" -c "Add :CFBundleURLTypes array" "$PLIST" 2>/dev/null || true
"$PB" -c "Add :CFBundleURLTypes:0 dict" "$PLIST" 2>/dev/null || true
"$PB" -c "Add :CFBundleURLTypes:0:CFBundleURLName string co.fandf.open" "$PLIST" 2>/dev/null || true
"$PB" -c "Add :CFBundleURLTypes:0:CFBundleURLSchemes array" "$PLIST" 2>/dev/null || true
"$PB" -c "Add :CFBundleURLTypes:0:CFBundleURLSchemes:0 string fandfopen" "$PLIST" 2>/dev/null || true

LSREG="/System/Library/Frameworks/CoreServices.framework/Frameworks/LaunchServices.framework/Support/lsregister"
"$LSREG" -f "$APP" || true

echo ""
echo "  [OK] Installed: ~/Applications/FandF Open.app"
echo "       Go to the hub, reload, click the folder button."
echo ""
read -n 1 -s -r -p "  Press any key to close..."
echo ""
