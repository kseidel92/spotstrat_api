#!/usr/bin/env bash
# Sobe a API na Google Cloud (1 VM). Pré-requisito: apis/.gcp-sa.json + GCP_PROJECT_ID no .env
set -euo pipefail
ROOT="$(cd "$(dirname "$0")/.." && pwd)"
GCLOUD="${GCLOUD:-$HOME/google-cloud-sdk/bin/gcloud}"
if [[ ! -x "$GCLOUD" ]]; then
  echo "gcloud não encontrado em $GCLOUD"
  exit 1
fi

if [[ -f "$ROOT/.env" ]]; then
  set -a
  # shellcheck disable=SC1091
  source <( { grep -E '^(DATABASE_URL|PORT)=' "$ROOT/.env"; grep -E '^GCP_' "$ROOT/.env"; } | sed 's/^/export /')
  set +a
fi

SA_KEY="${GCP_SA_KEY:-$ROOT/.gcp-sa.json}"
PROJECT="${GCP_PROJECT_ID:-}"
ZONE="${GCP_ZONE:-southamerica-east1-a}"
VM="${GCP_VM:-spotstrat-api}"
API_PORT="${PORT:-8080}"

if [[ -z "$PROJECT" ]]; then
  echo "Falta GCP_PROJECT_ID no apis/.env"
  exit 2
fi

if [[ -f "$SA_KEY" ]]; then
  "$GCLOUD" auth activate-service-account --key-file="$SA_KEY" --quiet
else
  if ! "$GCLOUD" auth print-access-token &>/dev/null; then
    echo "Sem chave JSON (política da org) — faça login uma vez:"
    echo "  $GCLOUD auth login"
    exit 2
  fi
fi
"$GCLOUD" config set project "$PROJECT" --quiet
"$GCLOUD" services enable compute.googleapis.com --quiet

if ! "$GCLOUD" compute instances describe "$VM" --zone="$ZONE" &>/dev/null; then
  echo "Criando VM $VM em $ZONE…"
  "$GCLOUD" compute instances create "$VM" \
    --zone="$ZONE" \
    --machine-type=e2-small \
    --boot-disk-size=40GB \
    --image-family=ubuntu-2204-lts \
    --image-project=ubuntu-os-cloud \
    --tags=spotstrat-api \
    --metadata=startup-script='#!/bin/bash
apt-get update -y
apt-get install -y ca-certificates curl rsync
curl -fsSL https://deb.nodesource.com/setup_20.x | bash -
apt-get install -y nodejs
mkdir -p /opt/spotstrat/apis
'
  "$GCLOUD" compute firewall-rules create spotstrat-api-allow-http \
    --allow=tcp:8080 \
    --target-tags=spotstrat-api \
    --description="SpotStrat API" \
    --quiet 2>/dev/null || true
  echo "Aguardando boot da VM…"
  sleep 45
fi

IP="$("$GCLOUD" compute instances describe "$VM" --zone="$ZONE" --format='get(networkInterfaces[0].accessConfigs[0].natIP)')"

echo "Sincronizando código para $VM ($IP)…"
TAR="$(mktemp /tmp/spotstrat-api.XXXXXX.tgz)"
tar -czf "$TAR" -C "$ROOT" \
  --exclude=node_modules \
  --exclude=run \
  --exclude=cloudflare \
  --exclude=.gcp-sa.json \
  package.json package-lock.json src Dockerfile
"$GCLOUD" compute scp "$TAR" "$VM":/tmp/api.tgz --zone="$ZONE" --quiet
rm -f "$TAR"

REMOTE_ENV="$(mktemp)"
grep -vE '^(GCP_|POSTGRES_USER|POSTGRES_PASSWORD|POSTGRES_DB)=' "$ROOT/.env" | sed 's/^PORT=.*/PORT=8080/' >>"$REMOTE_ENV" || true
if ! grep -q '^PORT=' "$REMOTE_ENV"; then echo 'PORT=8080' >>"$REMOTE_ENV"; fi
"$GCLOUD" compute scp "$REMOTE_ENV" "$VM":/opt/spotstrat/apis/.env --zone="$ZONE" --quiet
rm -f "$REMOTE_ENV"

"$GCLOUD" compute ssh "$VM" --zone="$ZONE" --quiet --command="
  set -e
  cd /opt/spotstrat/apis
  rm -rf src package.json package-lock.json
  tar -xzf /tmp/api.tgz -C /opt/spotstrat/apis
  npm ci --omit=dev
  pkill -f 'node src/index.js' 2>/dev/null || true
  nohup node src/index.js >>/var/log/spotstrat-api.log 2>&1 &
  sleep 2
  curl -fsS http://127.0.0.1:8080/v1/health && echo OK
"

echo ""
echo "API pública: http://$IP:8080/v1/health"
echo "Próximo: aponte HOME_API_URL na Vercel cloud para http://$IP:8080"
echo "Stripe webhook: http://$IP:8080/v1/billing/webhook"