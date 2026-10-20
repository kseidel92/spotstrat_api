#!/usr/bin/env bash
set -euo pipefail
ROOT="$(cd "$(dirname "$0")/.." && pwd)"
BIN="$ROOT/bin/cloudflared"
ARCH="$(uname -m)"
case "$ARCH" in
  x86_64) CF=amd64 ;;
  aarch64|arm64) CF=arm64 ;;
  *) echo "Arquitetura não suportada: $ARCH"; exit 1 ;;
esac
mkdir -p "$ROOT/bin"
curl -fsSL "https://github.com/cloudflare/cloudflared/releases/latest/download/cloudflared-linux-${CF}" -o "$BIN"
chmod +x "$BIN"
"$BIN" --version
echo "Instalado em $BIN"
