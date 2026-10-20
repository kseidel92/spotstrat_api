#!/usr/bin/env bash
set -euo pipefail
ROOT="$(cd "$(dirname "$0")/.." && pwd)"
PIDFILE="$ROOT/cloudflare/tunnel.pid"
if [[ -f "$PIDFILE" ]]; then
  kill "$(cat "$PIDFILE")" 2>/dev/null || true
  rm -f "$PIDFILE"
  echo "Túnel encerrado."
else
  pkill -f 'cloudflared tunnel --url' 2>/dev/null && echo "Túnel encerrado." || echo "Nenhum túnel quick ativo."
fi
