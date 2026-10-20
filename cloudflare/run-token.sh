#!/usr/bin/env bash
# Túnel fixo com token do painel Cloudflare (recomendado em produção).
# Exporte CLOUDFLARE_TUNNEL_TOKEN antes de rodar (não commite o token).
set -euo pipefail
ROOT="$(cd "$(dirname "$0")/.." && pwd)"
CF="${CLOUDFLARED:-$ROOT/bin/cloudflared}"
if [[ -z "${CLOUDFLARE_TUNNEL_TOKEN:-}" ]]; then
  echo "Defina CLOUDFLARE_TUNNEL_TOKEN (painel Zero Trust → Tunnels → Install connector)."
  exit 1
fi
exec "$CF" tunnel run --token "$CLOUDFLARE_TUNNEL_TOKEN"
