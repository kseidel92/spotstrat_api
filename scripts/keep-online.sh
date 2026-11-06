#!/usr/bin/env bash
# Mantém Postgres + API + túnel sempre online.
# Religa API/túnel se cair; se a URL do túnel mudar (ou o proxy Vercel ficar
# apontando para túnel morto), redeploya o cloud com HOME_API_URL certo.
#
# Uso:
#   npm start                 → este script (--watch)  ← use isto em produção
#   npm run start:once        → um processo só (debug)
#   ./scripts/keep-online.sh --no-push     → NÃO use se o site público precisar ficar online
#   ./scripts/keep-online.sh --no-deploy   → idem (cloud fica no túnel velho)
set -euo pipefail
ROOT="$(cd "$(dirname "$0")/.." && pwd)"
exec "$ROOT/scripts/go-online.sh" --watch "$@"
