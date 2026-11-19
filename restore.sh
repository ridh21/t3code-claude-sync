#!/bin/zsh
# Puts back the app.asar saved by apply.sh for this T3 Code version.
set -euo pipefail
DIR="${0:A:h}"
APP="${T3_APP:-/Applications/T3 Code (Nightly).app}"
RES="$APP/Contents/Resources"
BIN="$APP/Contents/MacOS/$(basename "$APP" .app)"
VER=$(defaults read "$APP/Contents/Info" CFBundleShortVersionString)
BACKUP="$DIR/backup/app.asar.$VER"
[[ -f "$BACKUP" ]] || { echo "No backup for version $VER (an update may already have restored stock files)." >&2; exit 1; }
running() { ps -axo comm | grep -qxF "$BIN"; }
if running; then echo "Waiting for T3 Code to quit (Cmd+Q)..."; while running; do sleep 1; done; sleep 1; fi
cp "$BACKUP" "$RES/app.asar.t3ccsync-tmp" && mv -f "$RES/app.asar.t3ccsync-tmp" "$RES/app.asar"
rm -f "$HOME/.local/bin/t3cc"
echo "Restored original. Relaunching..."; open "$APP"
