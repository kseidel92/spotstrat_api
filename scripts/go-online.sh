#!/usr/bin/env bash
# Sobe Postgres + API + túnel Cloudflare e mantém Vercel + Stripe alinhados com a URL atual.
# Uso:
#   npm start / ./scripts/keep-online.sh   → este fluxo com --watch
#   ./scripts/go-online.sh                → sobe tudo, sync, e sai
#   ./scripts/go-online.sh --watch        → fica religando API/túnel e re-sincronizando
#   ./scripts/go-online.sh --front        → também sobe o Vite em :7172
#   ./scripts/go-online.sh --no-push      → não commit/push/deploy (só arquivos locais + Stripe)
#   ./scripts/go-online.sh --no-deploy    → push git sem vercel --prod
set -euo pipefail

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
MONOREPO="$(cd "$ROOT/.." && pwd)"
FRONT="${SPOTSTRAT_FRONT:-$MONOREPO/front}"
CLOUD="${SPOTSTRAT_CLOUD:-$MONOREPO/cloud}"
API_PID="$ROOT/run/api.pid"
API_LOG="$ROOT/run/api.log"
FRONT_PID="$ROOT/run/front.pid"
FRONT_LOG="$ROOT/run/front.log"
URL_FILE="$ROOT/cloudflare/tunnel-url.txt"
SYNCED_FILE="$ROOT/run/synced-tunnel.txt"
WATCH_LOG="$ROOT/run/keep.log"
WATCH=0
WITH_FRONT=0
DO_PUSH=1
DO_DEPLOY=1
INTERVAL="${KEEP_ONLINE_INTERVAL:-12}"

for arg in "$@"; do
  case "$arg" in
    --watch) WATCH=1 ;;
    --front) WITH_FRONT=1 ;;
    --no-push) DO_PUSH=0 ;;
    --no-deploy) DO_DEPLOY=0 ;;
    -h|--help)
      sed -n '2,11p' "$0"
      exit 0
      ;;
  esac
done

mkdir -p "$ROOT/run"

log() { printf '[go-online] %s\n' "$*" | tee -a "$WATCH_LOG" >/dev/null; printf '[go-online] %s\n' "$*"; }

current_tunnel() {
  tr -d '[:space:]' < "$URL_FILE" 2>/dev/null || true
}

api_ok() {
  curl -fsS --max-time 3 "http://127.0.0.1:7171/v1/health" >/dev/null 2>&1
}

tunnel_ok() {
  local url
  url="$(current_tunnel)"
  [[ -n "$url" ]] || return 1
  curl -fsS --max-time 10 "$url/v1/health" >/dev/null 2>&1
}

wait_tunnel() {
  local i
  for i in $(seq 1 36); do
    if tunnel_ok; then
      return 0
    fi
    # se o log do quick tunnel já tem URL nova, atualiza o arquivo
    if [[ -f "$ROOT/cloudflare/tunnel.log" ]]; then
      local found
      found="$(grep -oE 'https://[a-z0-9-]+\.trycloudflare\.com' "$ROOT/cloudflare/tunnel.log" 2>/dev/null | tail -1 || true)"
      if [[ -n "$found" && "$found" != "$(current_tunnel)" ]]; then
        echo -n "$found" >"$URL_FILE"
        log "URL do túnel capturada do log → $found"
      fi
    fi
    sleep 1
  done
  return 1
}

ensure_postgres() {
  if docker ps --format '{{.Names}}' 2>/dev/null | grep -qx 'tradeai-postgres'; then
    if docker exec tradeai-postgres pg_isready >/dev/null 2>&1; then
      return 0
    fi
  fi
  log "Subindo Postgres…"
  (cd "$ROOT" && docker compose up -d postgres) || true
  local _
  for _ in $(seq 1 40); do
    if docker exec tradeai-postgres pg_isready >/dev/null 2>&1; then
      log "Postgres healthy"
      return 0
    fi
    sleep 1
  done
  log "WARN: Postgres demorou; seguindo mesmo assim"
}

start_api() {
  if api_ok; then
    return 0
  fi
  if [[ -f "$API_PID" ]] && kill -0 "$(cat "$API_PID")" 2>/dev/null; then
    log "API PID vivo mas health falhou — reiniciando"
    kill "$(cat "$API_PID")" 2>/dev/null || true
    sleep 1
  fi
  local old
  old="$(ss -ltnp 2>/dev/null | awk '/:7171 / {print $NF}' | grep -oE '[0-9]+' | head -1 || true)"
  if [[ -n "${old:-}" ]]; then
    kill "$old" 2>/dev/null || true
    sleep 1
  fi
  log "Subindo API…"
  (
    cd "$ROOT"
    nohup node src/index.js >>"$API_LOG" 2>&1 &
    echo $! >"$API_PID"
  )
  local _
  for _ in $(seq 1 40); do
    if api_ok; then
      log "API ok (pid $(cat "$API_PID"))"
      return 0
    fi
    sleep 0.5
  done
  log "ERRO: API não respondeu. Veja $API_LOG"
  tail -n 40 "$API_LOG" || true
  return 1
}

restart_api() {
  if [[ -f "$API_PID" ]]; then
    kill "$(cat "$API_PID")" 2>/dev/null || true
    rm -f "$API_PID"
  fi
  local old
  old="$(ss -ltnp 2>/dev/null | awk '/:7171 / {print $NF}' | grep -oE '[0-9]+' | head -1 || true)"
  if [[ -n "${old:-}" ]]; then
    kill "$old" 2>/dev/null || true
    sleep 1
  fi
  start_api
}

start_front() {
  if curl -fsS --max-time 3 "http://127.0.0.1:7172/" >/dev/null 2>&1; then
    return 0
  fi
  if [[ ! -d "$FRONT" ]]; then
    log "WARN: front não encontrado em $FRONT"
    return 0
  fi
  log "Subindo front Vite…"
  (
    cd "$FRONT"
    nohup npm run dev -- --host 127.0.0.1 --port 7172 >>"$FRONT_LOG" 2>&1 &
    echo $! >"$FRONT_PID"
  )
  local _
  for _ in $(seq 1 40); do
    if curl -fsS --max-time 2 "http://127.0.0.1:7172/" >/dev/null 2>&1; then
      log "Front ok"
      return 0
    fi
    sleep 0.5
  done
  log "WARN: front não respondeu ainda (log: $FRONT_LOG)"
}

ensure_tunnel() {
  if wait_tunnel; then
    log "Túnel ok → $(current_tunnel)"
    return 0
  fi
  log "Subindo túnel Cloudflare…"
  "$ROOT/cloudflare/stop-tunnel.sh" >/dev/null 2>&1 || true
  "$ROOT/cloudflare/run-quick.sh"
  if ! wait_tunnel; then
    log "ERRO: túnel não passou no health"
    return 1
  fi
  log "Túnel ok → $(current_tunnel)"
}

vercel_needs_sync() {
  local url wss
  url="$(current_tunnel)"
  wss="${url/https:/wss:}"
  [[ -n "$url" ]] || return 0
  if [[ -f "$CLOUD/vercel.json" ]] && ! grep -qF "$url" "$CLOUD/vercel.json"; then
    return 0
  fi
  if [[ -f "$FRONT/vercel.json" ]] && ! grep -qF "$wss" "$FRONT/vercel.json"; then
    return 0
  fi
  return 1
}

sync_vercel_urls() {
  local url wss
  url="$(current_tunnel)"
  wss="${url/https:/wss:}"
  [[ -n "$url" ]] || return 1

  local changed=0
  if [[ -f "$CLOUD/vercel.json" ]]; then
    if ! grep -qF "$url" "$CLOUD/vercel.json"; then
      python3 - "$CLOUD/vercel.json" "$url" <<'PY'
import json, sys
path, url = sys.argv[1], sys.argv[2]
with open(path) as f:
    data = json.load(f)
data.setdefault("env", {})["HOME_API_URL"] = url
with open(path, "w") as f:
    json.dump(data, f, indent=2)
    f.write("\n")
PY
      changed=1
      log "cloud/vercel.json → HOME_API_URL=$url"
    fi
  fi
  if [[ -f "$FRONT/vercel.json" ]]; then
    if ! grep -qF "$wss" "$FRONT/vercel.json"; then
      python3 - "$FRONT/vercel.json" "$wss" <<'PY'
import json, sys
path, wss = sys.argv[1], sys.argv[2]
with open(path) as f:
    data = json.load(f)
data.setdefault("env", {})["VITE_WS_ORIGIN"] = wss
with open(path, "w") as f:
    json.dump(data, f, indent=2)
    f.write("\n")
PY
      changed=1
      log "front/vercel.json → VITE_WS_ORIGIN=$wss"
    fi
  fi

  if [[ "$changed" -eq 0 ]]; then
    log "Vercel URLs já sincronizadas"
    return 0
  fi

  if [[ "$DO_PUSH" -eq 0 ]]; then
    log "URL atualizada localmente (--no-push); faça commit/push depois"
    return 0
  fi

  push_repo() {
    local dir="$1" msg="$2"
    [[ -d "$dir/.git" ]] || return 0
    (
      cd "$dir"
      git add vercel.json
      if git diff --cached --quiet; then
        return 0
      fi
      git commit -m "$msg"
      git push origin HEAD
      log "Push ok: $dir"
    ) || log "WARN: push falhou em $dir"
  }

  push_repo "$CLOUD" "Point HOME_API_URL at the current Cloudflare quick tunnel."
  push_repo "$FRONT" "Point VITE_WS_ORIGIN at the current Cloudflare quick tunnel."

  if [[ "$DO_DEPLOY" -eq 1 ]]; then
    deploy_repo() {
      local dir="$1"
      [[ -d "$dir" ]] || return 0
      if ! command -v npx >/dev/null 2>&1; then
        log "WARN: npx ausente — pulei deploy de $dir"
        return 0
      fi
      log "Deploy Vercel prod: $dir"
      (
        cd "$dir"
        npx --yes vercel@latest --prod --yes
      ) >>"$WATCH_LOG" 2>&1 && log "Deploy ok: $dir" || log "WARN: deploy falhou em $dir (veja $WATCH_LOG)"
    }
    deploy_repo "$CLOUD"
    deploy_repo "$FRONT"
  fi
}

sync_stripe_webhook() {
  local url
  url="$(current_tunnel)"
  [[ -n "$url" ]] || return 1
  if [[ ! -f "$ROOT/.env" ]] || ! grep -qE '^STRIPE_SECRET_KEY=.+' "$ROOT/.env"; then
    log "WARN: STRIPE_SECRET_KEY ausente — pulando sync Stripe"
    return 0
  fi
  local out
  if ! out="$(node "$ROOT/scripts/sync-stripe-webhook.mjs" "$url" 2>&1)"; then
    log "WARN: sync Stripe falhou: $out"
    return 1
  fi
  log "Stripe webhook → $out"
  # Se criou endpoint novo e gravou whsec no .env, reinicia API para carregar o secret
  if echo "$out" | grep -q '"created":true'; then
    log "Novo STRIPE_WEBHOOK_SECRET — reiniciando API"
    restart_api || true
  fi
}

needs_full_sync() {
  local url last
  url="$(current_tunnel)"
  [[ -n "$url" ]] || return 0
  last="$(tr -d '[:space:]' < "$SYNCED_FILE" 2>/dev/null || true)"
  if [[ "$url" != "$last" ]]; then
    return 0
  fi
  if vercel_needs_sync; then
    return 0
  fi
  return 1
}

sync_public_endpoints() {
  local url
  url="$(current_tunnel)"
  [[ -n "$url" ]] || return 1
  if ! needs_full_sync; then
    return 0
  fi
  mkdir -p "$ROOT/run"
  log "Sincronizando endpoints públicos para $url"
  sync_vercel_urls || true
  sync_stripe_webhook || true
  printf '%s' "$url" >"$SYNCED_FILE"
  log "Sync marcado em $SYNCED_FILE"
}

cloud_proxy_ok() {
  curl -fsS --max-time 12 "https://spotstratcloud.vercel.app/v1/health" >/dev/null 2>&1
}

bring_up() {
  ensure_postgres
  start_api
  ensure_tunnel
  sync_public_endpoints
  if [[ "$WITH_FRONT" -eq 1 ]]; then
    start_front
  fi
  log "Pronto."
  log "  API     http://127.0.0.1:7171/v1/health"
  log "  Túnel   $(current_tunnel)"
  log "  Cloud   https://spotstratcloud.vercel.app/v1/health"
  if [[ "$WITH_FRONT" -eq 1 ]]; then
    log "  Front   http://127.0.0.1:7172/"
  fi
}

bring_up

if [[ "$WATCH" -eq 1 ]]; then
  log "Watch ativo (intervalo ${INTERVAL}s). Ctrl+C para parar."
  log "Logs: API=$API_LOG keep=$WATCH_LOG"
  while true; do
    sleep "$INTERVAL"
    ensure_postgres || true
    if ! api_ok; then
      log "API fora — religando"
      restart_api || true
    fi
    if ! tunnel_ok; then
      log "Túnel fora — religando + sync Vercel/Stripe"
      ensure_tunnel || true
      # força re-sync mesmo se a URL coincidir com a antiga
      rm -f "$SYNCED_FILE"
      sync_public_endpoints || true
    elif needs_full_sync; then
      log "URL/config dessincronizada — sync Vercel/Stripe"
      sync_public_endpoints || true
    fi
    # cloud proxy deve alcançar a API via HOME_API_URL
    if ! cloud_proxy_ok; then
      log "WARN: cloud proxy offline — forçando sync/deploy"
      rm -f "$SYNCED_FILE"
      sync_public_endpoints || true
    fi
  done
fi
