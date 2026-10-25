#!/usr/bin/env bash
# Mantém Postgres + API + túnel Cloudflare sempre online.
# Religa sozinho se a API cair (ex.: Postgres reiniciou) e recria o túnel se a URL morrer.
#
# Uso:
#   npm start              → este script
#   npm run start:once     → um processo só (debug)
#   ./scripts/keep-online.sh --no-push
set -euo pipefail
ROOT="$(cd "$(dirname "$0")/.." && pwd)"
exec "$ROOT/scripts/go-online.sh" --watch "$@"
