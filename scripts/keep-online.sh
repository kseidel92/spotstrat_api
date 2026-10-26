#!/usr/bin/env bash
# Mantém Postgres + API + túnel sempre online.
# Religa API/túnel se cair; se a URL do túnel mudar, sincroniza Vercel + webhook Stripe.
#
# Uso:
#   npm start                 → este script (--watch)
#   npm run start:once        → um processo só (debug)
#   ./scripts/keep-online.sh --no-push
#   ./scripts/keep-online.sh --no-deploy
set -euo pipefail
ROOT="$(cd "$(dirname "$0")/.." && pwd)"
exec "$ROOT/scripts/go-online.sh" --watch "$@"
