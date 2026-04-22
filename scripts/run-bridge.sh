#!/usr/bin/env bash
set -euo pipefail

SKILL_DIR="$(cd "$(dirname "$0")/.." && pwd)"
BRIDGE_HOME="${CODEX_FEISHU_HOME:-$HOME/.codex-feishu}"
export PATH="/opt/homebrew/bin:/usr/local/bin:/usr/bin:/bin:/usr/sbin:/sbin:${PATH:-}"
APP_RESOURCES="/Applications/Codex.app/Contents/Resources"

mkdir -p "$BRIDGE_HOME/data/messages" "$BRIDGE_HOME/logs" "$BRIDGE_HOME/runtime"

if [ -f "$BRIDGE_HOME/config.env" ]; then
  set -a
  # shellcheck disable=SC1090
  source "$BRIDGE_HOME/config.env"
  set +a
fi

cd "$SKILL_DIR"
NODE_BIN="${CODEX_FEISHU_NODE_EXECUTABLE:-$(command -v node || true)}"
if [ -z "$NODE_BIN" ] && [ -x "$APP_RESOURCES/node" ]; then
  NODE_BIN="$APP_RESOURCES/node"
fi
if [ -z "$NODE_BIN" ]; then
  echo "node executable not found. Set CODEX_FEISHU_NODE_EXECUTABLE if Node.js is installed in a non-standard location." >&2
  exit 127
fi

if [ -z "${CODEX_FEISHU_CODEX_EXECUTABLE:-}" ]; then
  for candidate in \
    "$(command -v codex || true)" \
    "/opt/homebrew/bin/codex" \
    "/usr/local/bin/codex" \
    "$APP_RESOURCES/codex"
  do
    if [ -n "$candidate" ] && [ -x "$candidate" ]; then
      export CODEX_FEISHU_CODEX_EXECUTABLE="$candidate"
      break
    fi
  done
fi

exec "$NODE_BIN" "$SKILL_DIR/dist/daemon.mjs"
