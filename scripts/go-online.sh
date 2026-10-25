#!/usr/bin/env bash
# Sobe Postgres + API + túnel Cloudflare e sincroniza a URL na Vercel (front + cloud).
# Uso:
#   ./scripts/go-online.sh           # sobe tudo e faz push se a URL mudou
#   ./scripts/go-online.sh --front   # também sobe o Vite em :7172
#   ./scripts/go-online.sh --watch   # fica de olho e religa API/túnel se cair
#   ./scripts/go-online.sh --no-push # não commit/push (só local + tunnel-url.txt)
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
WATCH=0
WITH_FRONT=0
DO_PUSH=1

for arg in "$@"; do
  case "$arg" in
    --watch) WATCH=1 ;;
    --front) WITH_FRONT=1 ;;
    --no-push) DO_PUSH=0 ;;
    -h|--help)
      sed -n '2,8p' "$0"
      exit 0
      ;;
  esac
done

mkdir -p "$ROOT/run"

log() { printf '[go-online] %s\n' "$*"; }

api_ok() {
  curl -fsS --max-time 3 "http://127.0.0.1:7171/v1/health" >/dev/null 2>&1
}

tunnel_ok() {
  local url
  url="$(tr -d '[:space:]' < "$URL_FILE" 2>/dev/null || true)"
  [[ -n "$url" ]] || return 1
  curl -fsS --max-time 8 "$url/v1/health" >/dev/null 2>&1
}

wait_tunnel() {
  local i
  for i in $(seq 1 24); do
    if tunnel_ok; then
      return 0
    fi
    sleep 1
  done
  return 1
}

ensure_postgres() {
  if docker ps --format '{{.Names}}' 2>/dev/null | grep -qx 'tradeai-postgres'; then
    log "Postgres já up"
    return 0
  fi
  log "Subindo Postgres…"
  (cd "$ROOT" && docker compose up -d postgres)
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
    log "API já online em :7171"
    return 0
  fi
  if [[ -f "$API_PID" ]] && kill -0 "$(cat "$API_PID")" 2>/dev/null; then
    log "API PID vivo mas health falhou — reiniciando"
    kill "$(cat "$API_PID")" 2>/dev/null || true
    sleep 1
  fi
  # libera porta se ficou zumbi
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
  for _ in $(seq 1 30); do
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

start_front() {
  if curl -fsS --max-time 3 "http://127.0.0.1:7172/" >/dev/null 2>&1; then
    log "Front já online em :7172"
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
    log "Túnel ok → $(tr -d '[:space:]' < "$URL_FILE")"
    return 0
  fi
  log "Subindo túnel Cloudflare…"
  "$ROOT/cloudflare/stop-tunnel.sh" >/dev/null 2>&1 || true
  "$ROOT/cloudflare/run-quick.sh"
  if ! wait_tunnel; then
    log "ERRO: túnel não passou no health"
    return 1
  fi
  log "Túnel ok → $(tr -d '[:space:]' < "$URL_FILE")"
}

sync_vercel_urls() {
  local url wss
  url="$(tr -d '[:space:]' < "$URL_FILE")"
  wss="${url/https:/wss:}"
  [[ -n "$url" ]] || return 1

  local changed=0
  if [[ -f "$CLOUD/vercel.json" ]]; then
    if ! grep -q "$url" "$CLOUD/vercel.json"; then
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
    if ! grep -q "$wss" "$FRONT/vercel.json"; then
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
    )
  }

  push_repo "$CLOUD" "Point HOME_API_URL at the current Cloudflare quick tunnel."
  push_repo "$FRONT" "Point VITE_WS_ORIGIN at the current Cloudflare quick tunnel."
}

bring_up() {
  ensure_postgres
  start_api
  ensure_tunnel
  sync_vercel_urls
  if [[ "$WITH_FRONT" -eq 1 ]]; then
    start_front
  fi
  log "Pronto."
  log "  API     http://127.0.0.1:7171/v1/health"
  log "  Túnel   $(tr -d '[:space:]' < "$URL_FILE")"
  if [[ "$WITH_FRONT" -eq 1 ]]; then
    log "  Front   http://127.0.0.1:7172/"
  fi
}

bring_up

if [[ "$WATCH" -eq 1 ]]; then
  log "Watch ativo (Ctrl+C para parar). Checa a cada 10s."
  log "Logs da API: $API_LOG"
  while true; do
    sleep 10
    ensure_postgres || true
    if ! api_ok; then
      log "API fora — religando"
      # mata pid antigo se ainda estiver zumbi na porta
      if [[ -f "$API_PID" ]]; then
        kill "$(cat "$API_PID")" 2>/dev/null || true
        rm -f "$API_PID"
      fi
      start_api || true
    fi
    if ! tunnel_ok; then
      log "Túnel fora — religando + sync Vercel"
      ensure_tunnel || true
      sync_vercel_urls || true
    fi
  done
fi
