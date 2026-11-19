#!/bin/zsh
# Adds the "Claude Code sync" panel to the T3 Code (Nightly) sidebar.
# Backs up the current app.asar (once per app version), injects inject.js into
# the web client's index.html, and relaunches T3 Code. Safe to re-run; re-run
# after every T3 Code update. Undo with ./restore.sh
set -euo pipefail
DIR="${0:A:h}"
APP="${T3_APP:-/Applications/T3 Code (Nightly).app}"
RES="$APP/Contents/Resources"
BIN="$APP/Contents/MacOS/$(basename "$APP" .app)"
VER=$(defaults read "$APP/Contents/Info" CFBundleShortVersionString)
BACKUP="$DIR/backup/app.asar.$VER"
mkdir -p "$DIR/backup"

if [[ ! -f "$BACKUP" ]]; then
  if grep -q "t3ccsync:start" "$RES/app.asar"; then
    echo "app.asar already has claude-sync but no backup exists for $VER; aborting." >&2; exit 1
  fi
  cp "$RES/app.asar" "$BACKUP"
  echo "Backed up original -> $BACKUP"
fi

# Patch whatever is installed now (keeps other mods such as neon-city); the
# patcher strips an older claude-sync block first, so this is idempotent.
cp "$RES/app.asar" "$DIR/backup/app.asar.input"
node "$DIR/patch-asar.mjs" "$DIR/backup/app.asar.input" "$DIR/backup/app.asar.patched" "$DIR/inject.js"
rm -f "$DIR/backup/app.asar.input"

# Install the t3cc helper next to the claude binary on PATH.
mkdir -p "$HOME/.local/bin"
ln -sf "$DIR/bin/t3cc" "$HOME/.local/bin/t3cc"
chmod +x "$DIR/bin/t3cc"

running() { ps -axo comm | grep -qxF "$BIN"; }
if running; then
  echo "Waiting for T3 Code to quit (press Cmd+Q in T3 Code)..."
  while running; do sleep 1; done
  sleep 1
fi
cp "$DIR/backup/app.asar.patched" "$RES/app.asar.t3ccsync-tmp"
mv -f "$RES/app.asar.t3ccsync-tmp" "$RES/app.asar"
echo "Installed claude-sync. Relaunching T3 Code..."
open "$APP"
