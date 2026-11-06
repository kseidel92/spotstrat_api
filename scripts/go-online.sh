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
INTERVAL="${KEEP_ONLINE_INTERVAL:-8}"
LOCK_FILE="$ROOT/run/go-online.lock"
API_FAILS=0
API_FAIL_LIMIT="${KEEP_API_FAIL_LIMIT:-2}"

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

# Um watcher só — dois processos se matam (API sobe/cai em loop).
if [[ "$WATCH" -eq 1 ]]; then
  exec 9>"$LOCK_FILE"
  if ! flock -n 9; then
    echo "[go-online] já há um --watch ativo (lock $LOCK_FILE); saindo."
    exit 0
  fi
fi

log() {
  # Uma linha no keep.log + stdout (evita tee duplicar se stdout já for o log).
  local line
  line="$(printf '[go-online] %s' "$*")"
  printf '%s\n' "$line" >>"$WATCH_LOG"
  printf '%s\n' "$line"
}

current_tunnel() {
  tr -d '[:space:]' < "$URL_FILE" 2>/dev/null || true
}

api_listening() {
  ss -ltn 2>/dev/null | grep -qE '[:.]7171\s' || return 1
}

api_pid_alive() {
  [[ -f "$API_PID" ]] || return 1
  kill -0 "$(cat "$API_PID" 2>/dev/null)" 2>/dev/null
}

api_ok() {
  curl -fsS --max-time 8 "http://127.0.0.1:7171/v1/health" >/dev/null 2>&1
}

tunnel_process_ok() {
  pgrep -f 'cloudflared tunnel --url http://127.0.0.1:7171' >/dev/null 2>&1
}

tunnel_ok() {
  local url
  url="$(current_tunnel)"
  [[ -n "$url" ]] || return 1
  # Só conta se a origem local também responde — senão é API caída, não túnel.
  api_ok || return 1
  curl -fsS --max-time 12 "$url/v1/health" >/dev/null 2>&1
}

capture_tunnel_url() {
  if [[ -f "$ROOT/cloudflare/tunnel.log" ]]; then
    local found
    found="$(grep -oE 'https://[a-z0-9-]+\.trycloudflare\.com' "$ROOT/cloudflare/tunnel.log" 2>/dev/null | tail -1 || true)"
    if [[ -n "$found" && "$found" != "$(current_tunnel)" ]]; then
      echo -n "$found" >"$URL_FILE"
      log "URL do túnel capturada do log → $found"
    fi
  fi
}

wait_tunnel() {
  local i max="${1:-20}"
  for i in $(seq 1 "$max"); do
    capture_tunnel_url
    # Durante subida do túnel, health remoto basta (API já deve estar ok).
    local url
    url="$(current_tunnel)"
    if [[ -n "$url" ]] && curl -fsS --max-time 8 "$url/v1/health" >/dev/null 2>&1; then
      return 0
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

kill_api_soft() {
  local pid old i
  pid=""
  if [[ -f "$API_PID" ]]; then
    pid="$(cat "$API_PID" 2>/dev/null || true)"
  fi
  if [[ -n "${pid:-}" ]] && kill -0 "$pid" 2>/dev/null; then
    kill -TERM "$pid" 2>/dev/null || true
    for i in $(seq 1 16); do
      kill -0 "$pid" 2>/dev/null || break
      sleep 0.5
    done
    if kill -0 "$pid" 2>/dev/null; then
      log "API pid $pid não saiu — SIGKILL"
      kill -KILL "$pid" 2>/dev/null || true
      sleep 0.5
    fi
  fi
  old="$(ss -ltnp 2>/dev/null | awk '/:7171 / {print $NF}' | grep -oE 'pid=[0-9]+' | head -1 | cut -d= -f2 || true)"
  if [[ -z "${old:-}" ]]; then
    old="$(ss -ltnp 2>/dev/null | awk '/:7171 / {print $NF}' | grep -oE '[0-9]+' | head -1 || true)"
  fi
  if [[ -n "${old:-}" ]] && kill -0 "$old" 2>/dev/null; then
    kill -TERM "$old" 2>/dev/null || true
    sleep 1
    kill -KILL "$old" 2>/dev/null || true
  fi
  rm -f "$API_PID"
}

start_api() {
  if api_ok; then
    API_FAILS=0
    return 0
  fi
  # PID vivo + porta aberta + health falhou uma vez: espera (boot/desk), não mata.
  if api_pid_alive && api_listening; then
    log "API ainda subindo (pid $(cat "$API_PID")) — aguardando health"
    local _
    for _ in $(seq 1 30); do
      if api_ok; then
        API_FAILS=0
        log "API ok (pid $(cat "$API_PID"))"
        return 0
      fi
      sleep 1
    done
    log "API travada no boot — reiniciando"
    kill_api_soft
  elif api_pid_alive; then
    log "API PID vivo sem porta — reiniciando"
    kill_api_soft
  fi
  log "Subindo API…"
  (
    cd "$ROOT"
    nohup node src/index.js >>"$API_LOG" 2>&1 &
    echo $! >"$API_PID"
  )
  local _
  for _ in $(seq 1 60); do
    if api_ok; then
      API_FAILS=0
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
  kill_api_soft
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

# Força redeploy do cloud mesmo se vercel.json local já tem a URL
# (caso típico: keep rodou com --no-push e a Vercel ficou no túnel velho).
FORCE_CLOUD_DEPLOY=0
LAST_CLOUD_DEPLOY_AT=0
CLOUD_DEPLOY_COOLDOWN="${KEEP_CLOUD_DEPLOY_COOLDOWN:-120}"

write_home_api_url() {
  local path="$1" url="$2"
  python3 - "$path" "$url" <<'PY'
import json, sys
path, url = sys.argv[1], sys.argv[2]
with open(path) as f:
    data = json.load(f)
data.setdefault("env", {})["HOME_API_URL"] = url
with open(path, "w") as f:
    json.dump(data, f, indent=2)
    f.write("\n")
PY
}

write_ws_origin() {
  local path="$1" wss="$2"
  python3 - "$path" "$wss" <<'PY'
import json, sys
path, wss = sys.argv[1], sys.argv[2]
with open(path) as f:
    data = json.load(f)
data.setdefault("env", {})["VITE_WS_ORIGIN"] = wss
with open(path, "w") as f:
    json.dump(data, f, indent=2)
    f.write("\n")
PY
}

deploy_vercel_repo() {
  local dir="$1"
  [[ -d "$dir" ]] || return 0
  if ! command -v npx >/dev/null 2>&1; then
    log "WARN: npx ausente — pulei deploy de $dir"
    return 1
  fi
  log "Deploy Vercel prod: $dir"
  (
    cd "$dir"
    npx --yes vercel@latest --prod --yes
  ) >>"$WATCH_LOG" 2>&1 && log "Deploy ok: $dir" && return 0
  log "WARN: deploy falhou em $dir (veja $WATCH_LOG)"
  return 1
}

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

cloud_meta_home() {
  curl -fsS --max-time 12 "$CLOUD_PUBLIC_URL/meta" 2>/dev/null \
    | python3 -c 'import sys,json; print(json.load(sys.stdin).get("homeApiUrl") or "")' 2>/dev/null || true
}

cloud_points_at_current_tunnel() {
  local url live
  url="$(current_tunnel)"
  [[ -n "$url" ]] || return 1
  live="$(cloud_meta_home)"
  [[ -n "$live" && "$live" == "$url" ]]
}

sync_vercel_urls() {
  local url wss force="${1:-0}"
  url="$(current_tunnel)"
  wss="${url/https:/wss:}"
  [[ -n "$url" ]] || return 1

  local changed=0
  if [[ -f "$CLOUD/vercel.json" ]]; then
    if ! grep -qF "$url" "$CLOUD/vercel.json"; then
      write_home_api_url "$CLOUD/vercel.json" "$url"
      changed=1
      log "cloud/vercel.json → HOME_API_URL=$url"
    fi
  fi
  if [[ -f "$FRONT/vercel.json" ]]; then
    if ! grep -qF "$wss" "$FRONT/vercel.json"; then
      write_ws_origin "$FRONT/vercel.json" "$wss"
      changed=1
      log "front/vercel.json → VITE_WS_ORIGIN=$wss"
    fi
  fi

  if [[ "$changed" -eq 0 && "$force" -eq 0 ]]; then
    log "Vercel URLs já sincronizadas (arquivos locais)"
    return 0
  fi

  if [[ "$DO_PUSH" -eq 1 ]]; then
    push_repo "$CLOUD" "Point HOME_API_URL at the current Cloudflare quick tunnel."
    push_repo "$FRONT" "Point VITE_WS_ORIGIN at the current Cloudflare quick tunnel."
  elif [[ "$changed" -eq 1 ]]; then
    log "URL atualizada localmente (--no-push); deploy do cloud ainda pode rodar"
  fi

  # Cloud SEMPRE precisa do HOME_API_URL no deploy — mesmo com --no-push.
  # Sem isso o site público fica no túnel morto e o banner “API fora” aparece.
  if [[ "$DO_DEPLOY" -eq 1 || "$force" -eq 1 ]]; then
    deploy_vercel_repo "$CLOUD" || return 1
    if [[ "$DO_DEPLOY" -eq 1 && "$changed" -eq 1 && "$DO_PUSH" -eq 1 ]]; then
      deploy_vercel_repo "$FRONT" || true
    fi
    LAST_CLOUD_DEPLOY_AT="$(date +%s)"
  fi
  return 0
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
  last=""
  if [[ -f "$SYNCED_FILE" ]]; then
    last="$(tr -d '[:space:]' <"$SYNCED_FILE" || true)"
  fi
  if [[ "$url" != "$last" ]]; then
    return 0
  fi
  if vercel_needs_sync; then
    return 0
  fi
  return 1
}

sync_public_endpoints() {
  local url force="${1:-0}"
  url="$(current_tunnel)"
  [[ -n "$url" ]] || return 1
  if [[ "$force" -eq 0 ]] && ! needs_full_sync; then
    return 0
  fi
  mkdir -p "$ROOT/run"
  log "Sincronizando endpoints públicos para $url${force:+ (force)}"
  sync_vercel_urls "$force" || true
  sync_stripe_webhook || true
  # Só marca synced se o proxy público realmente alcança a API atual.
  if cloud_proxy_ok && cloud_points_at_current_tunnel; then
    printf '%s' "$url" >"$SYNCED_FILE"
    log "Sync marcado em $SYNCED_FILE (cloud ok → $url)"
  else
    rm -f "$SYNCED_FILE"
    log "WARN: sync incompleto — cloud ainda não aponta/alcança $url"
    return 1
  fi
}

heal_cloud_proxy() {
  local now last
  now="$(date +%s)"
  last="${LAST_CLOUD_DEPLOY_AT:-0}"
  if [[ $((now - last)) -lt "$CLOUD_DEPLOY_COOLDOWN" ]]; then
    log "Cloud offline — aguardando cooldown de deploy (${CLOUD_DEPLOY_COOLDOWN}s)"
    return 0
  fi
  local url live
  url="$(current_tunnel)"
  live="$(cloud_meta_home)"
  log "Cloud offline — live=${live:-?} esperado=$url — forçando deploy"
  # Garante arquivo local certo + deploy mesmo se já “sincronizado” no disco
  if [[ -f "$CLOUD/vercel.json" ]]; then
    write_home_api_url "$CLOUD/vercel.json" "$url"
  fi
  sync_stripe_webhook || true
  if deploy_vercel_repo "$CLOUD"; then
    LAST_CLOUD_DEPLOY_AT="$(date +%s)"
    sleep 3
    if cloud_proxy_ok && cloud_points_at_current_tunnel; then
      printf '%s' "$url" >"$SYNCED_FILE"
      log "Cloud recuperado → $url"
      return 0
    fi
    log "WARN: deploy ok mas health/meta ainda falhou"
  fi
  return 1
}

CLOUD_PUBLIC_URL="${SPOTSTRAT_CLOUD_URL:-https://cloud-nine-gilt.vercel.app}"

cloud_proxy_ok() {
  curl -fsS --max-time 12 "$CLOUD_PUBLIC_URL/v1/health" >/dev/null 2>&1
}

bring_up() {
  ensure_postgres
  start_api
  ensure_tunnel
  sync_public_endpoints || true
  # Garante que a Vercel pública já fala com ESTE túnel (não só vercel.json local).
  if ! cloud_proxy_ok || ! cloud_points_at_current_tunnel; then
    heal_cloud_proxy || true
  fi
  if [[ "$WITH_FRONT" -eq 1 ]]; then
    start_front
  fi
  log "Pronto."
  log "  API     http://127.0.0.1:7171/v1/health"
  log "  Túnel   $(current_tunnel)"
  log "  Cloud   $CLOUD_PUBLIC_URL/v1/health"
  if cloud_proxy_ok; then
    log "  Meta    $(cloud_meta_home)"
  else
    log "  WARN    cloud proxy ainda offline"
  fi
  if [[ "$WITH_FRONT" -eq 1 ]]; then
    log "  Front   http://127.0.0.1:7172/"
  fi
}

bring_up

if [[ "$WATCH" -eq 1 ]]; then
  log "Watch ativo (intervalo ${INTERVAL}s, falhas→restart=${API_FAIL_LIMIT}). Ctrl+C para parar."
  log "Logs: API=$API_LOG keep=$WATCH_LOG"
  TUNNEL_FAILS=0
  while true; do
    sleep "$INTERVAL"
    ensure_postgres || true

    # Processo/porta mortos → religa na hora (não espera 2 health fails).
    if ! api_pid_alive || ! api_listening; then
      log "API processo/porta mortos — religando"
      restart_api || true
      API_FAILS=0
      TUNNEL_FAILS=0
      continue
    fi

    if api_ok; then
      API_FAILS=0
    else
      API_FAILS=$((API_FAILS + 1))
      log "API health falhou (${API_FAILS}/${API_FAIL_LIMIT})"
      if [[ "$API_FAILS" -ge "$API_FAIL_LIMIT" ]]; then
        log "API fora — religando"
        restart_api || true
        API_FAILS=0
        TUNNEL_FAILS=0
      fi
      continue
    fi

    if ! tunnel_process_ok; then
      log "cloudflared morto — religando túnel + sync"
      ensure_tunnel || true
      rm -f "$SYNCED_FILE"
      sync_public_endpoints || true
      TUNNEL_FAILS=0
    else
      local_url="$(current_tunnel)"
      if [[ -n "$local_url" ]] && curl -fsS --max-time 10 "$local_url/v1/health" >/dev/null 2>&1; then
        TUNNEL_FAILS=0
        if needs_full_sync; then
          log "URL/config dessincronizada — sync Vercel/Stripe"
          sync_public_endpoints || true
        fi
      else
        TUNNEL_FAILS=$((TUNNEL_FAILS + 1))
        log "Túnel health falhou (${TUNNEL_FAILS}/2)"
        if [[ "$TUNNEL_FAILS" -ge 2 ]]; then
          log "Túnel fora — religando + sync Vercel/Stripe"
          ensure_tunnel || true
          rm -f "$SYNCED_FILE"
          sync_public_endpoints || true
          TUNNEL_FAILS=0
        fi
      fi
    fi

    if ! cloud_proxy_ok || ! cloud_points_at_current_tunnel; then
      heal_cloud_proxy || true
    fi
  done
fi
