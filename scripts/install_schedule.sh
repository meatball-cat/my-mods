#!/bin/bash
# Install (or refresh) the weekly update-check LaunchAgent.
set -euo pipefail
LABEL=com.meatball-cat.my-mods.update-check
SRC="$(cd "$(dirname "$0")" && pwd)/$LABEL.plist"
DST="$HOME/Library/LaunchAgents/$LABEL.plist"
mkdir -p "$HOME/.local/share/my-mods-updater"
launchctl bootout "gui/$(id -u)/$LABEL" 2>/dev/null || true
cp "$SRC" "$DST"
launchctl bootstrap "gui/$(id -u)" "$DST"
echo "Installed $LABEL (Mondays 03:40). Run now: launchctl kickstart gui/$(id -u)/$LABEL"
