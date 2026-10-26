#!/usr/bin/env bash
set -euo pipefail
ROOT="$(cd "$(dirname "$0")/.." && pwd)"
PIDFILE="$ROOT/cloudflare/tunnel.pid"
CFBIN="$ROOT/bin/cloudflared"

if [[ -f "$PIDFILE" ]]; then
  kill "$(cat "$PIDFILE")" 2>/dev/null || true
  rm -f "$PIDFILE"
fi

# Mata só o binário local do quick tunnel (evita pkill amplo matar o próprio shell)
if [[ -x "$CFBIN" ]]; then
  pkill -f "$CFBIN tunnel --url" 2>/dev/null || true
fi

# fallback: processos cloudflared apontando para a API local
pkill -f 'cloudflared tunnel --url http://127.0.0.1:7171' 2>/dev/null || true

echo "Túnel encerrado."
