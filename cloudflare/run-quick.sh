#!/usr/bin/env bash
# Túnel rápido (teste). URL muda ao reiniciar. Grátis, sem conta.
set -euo pipefail
ROOT="$(cd "$(dirname "$0")/.." && pwd)"
CF="${CLOUDFLARED:-$ROOT/bin/cloudflared}"
ORIGIN="${TUNNEL_ORIGIN:-http://127.0.0.1:7171}"
OUT="$ROOT/cloudflare/tunnel-url.txt"
LOG="$ROOT/cloudflare/tunnel.log"

if [[ ! -x "$CF" ]]; then
  echo "cloudflared não encontrado. Rode: ./cloudflare/install-cloudflared.sh"
  exit 1
fi

: > "$LOG"
echo "Subindo túnel → $ORIGIN (log: $LOG)"
"$CF" tunnel --url "$ORIGIN" 2>&1 | tee -a "$LOG" &
PID=$!
echo "$PID" > "$ROOT/cloudflare/tunnel.pid"

for i in $(seq 1 30); do
  if grep -oE 'https://[a-z0-9-]+\.trycloudflare\.com' "$LOG" | head -1 >> /dev/null 2>&1; then
    URL="$(grep -oE 'https://[a-z0-9-]+\.trycloudflare\.com' "$LOG" | head -1)"
    echo "$URL" > "$OUT"
    echo ""
    echo "Túnel pronto."
    echo "  HOME_API_URL (Vercel spotstrat_cloud): $URL"
    echo "  VITE_WS_ORIGIN (Vercel spotstrat_front):  ${URL/https:/wss:}"
    echo "  Salvo em: $OUT"
    echo "  PID: $PID (pare com: kill \$(cat cloudflare/tunnel.pid))"
    exit 0
  fi
  sleep 1
done

echo "Não achei a URL trycloudflare em 30s. Veja $LOG"
kill "$PID" 2>/dev/null || true
exit 1
