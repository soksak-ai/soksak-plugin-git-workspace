#!/usr/bin/env bash
# Stage the built plugin into a soksak home's plugins directory (idempotent, no symlinks).
# The runtime needs plugin.json + main.js + a .soksak.json marker; the rest is harmless.
# Usage: stage.sh <home>   e.g. stage.sh "$HOME/.soksak-debug"
set -euo pipefail
HOME_DIR="${1:?home dir required (e.g. \$HOME/.soksak-debug)}"
SRC="$(cd "$(dirname "$0")/../.." && pwd)"
DEST="$HOME_DIR/plugins/soksak-plugin-git-workspace"
mkdir -p "$DEST"
for f in plugin.json main.js package.json README.md README.ko.md; do
  cp "$SRC/$f" "$DEST/$f"
done
cat > "$DEST/.soksak.json" <<'JSON'
{ "version": "dev", "repo": "https://github.com/soksak-ai/soksak-plugin-git-workspace.git", "branch": "main" }
JSON
echo "staged → $DEST"
