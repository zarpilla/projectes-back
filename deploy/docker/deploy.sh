#!/usr/bin/env bash
# Zero-downtime deploy of a backend image to the Docker tenants (blue/green).
#
#   ./deploy.sh v5-<40-hex sha> [tenant ...]     e.g. ./deploy.sh v5-8b48003... buida
#
# Per tenant: start the new build in the idle slot (blue <-> green), wait until it
# answers, point the proxy (Caddy, graceful reload) at it, let the old slot drain,
# then stop it. The canary goes first, then the rest two at a time. If a new slot
# doesn't become healthy, it is stopped (its old slot never stopped serving) and
# tenants already switched in this run go back to their previous slot, also
# without downtime. Exits non-zero in that case.
#
# GitHub Actions calls it over SSH with a key restricted to this script
# (authorized_keys: command="/var/www/esstrapis-back/deploy.sh",restrict ...);
# the arguments then arrive in SSH_ORIGINAL_COMMAND.
set -euo pipefail
cd "$(dirname "$(readlink -f "$0")")"

CANARY=buida
PARALLEL=2
HEALTH_TIMEOUT=${HEALTH_TIMEOUT:-180}
DRAIN=10
LOG=deploy.log

if [ -n "${SSH_ORIGINAL_COMMAND:-}" ]; then read -r -a ARGS <<<"$SSH_ORIGINAL_COMMAND"; else ARGS=("$@"); fi
TAG="${ARGS[0]:-}"
[[ "$TAG" =~ ^v5-[0-9a-f]{40}$ ]] || { echo "Usage: deploy.sh v5-<40-hex sha> [tenant ...]"; exit 2; }

declare -A PORT
ALL=()
while read -r name port _; do
  [[ -z "$name" || "$name" == \#* ]] && continue
  PORT[$name]=$port; ALL+=("$name")
done < tenants.conf
ONLY=("${ARGS[@]:1}")
for t in "${ONLY[@]}"; do [ -n "${PORT[$t]:-}" ] || { echo "Unknown tenant: $t"; exit 2; }; done

exec 9>.deploy.lock
flock -n 9 || { echo "Another deploy is running"; exit 3; }
# Finish (or roll back) even if the SSH session that started us goes away.
trap '' HUP PIPE
exec > >(tee -a --output-error=warn-nopipe "$LOG") 2>&1

PREV=$(sed -n "s/^BACK_TAG=//p" .env 2>/dev/null || true)
PREV=${PREV:-v5}
echo "=== $(date -Is) deploy $TAG (previous $PREV)${ONLY:+ to ${ONLY[*]}}"

if [ ${#ONLY[@]} -gt 0 ]; then ORDER=("${ONLY[@]}")
else
  ORDER=()
  [ -n "${PORT[$CANARY]:-}" ] && ORDER+=("$CANARY")
  for t in "${ALL[@]}"; do [ "$t" = "$CANARY" ] || ORDER+=("$t"); done
fi

active() { cat "state/$1" 2>/dev/null || echo blue; }
other() { [ "$1" = blue ] && echo green || echo blue; }
slot_port() { [ "$2" = green ] && echo $((PORT[$1] + 20000)) || echo $((PORT[$1] + 10000)); }

healthy() {  # tenant color
  local port; port=$(slot_port "$1" "$2"); local waited=0 code=000
  while [ $waited -lt $HEALTH_TIMEOUT ]; do
    sleep 3; waited=$((waited + 3))
    code=$(curl -s -o /dev/null -m 5 -w '%{http_code}' "http://127.0.0.1:$port/api/logos?_limit=1" || true)
    [ "$code" = 200 ] && { echo "    $1-$2 healthy after ${waited}s (port $port)"; return 0; }
  done
  echo "!!  $1-$2 not healthy after ${HEALTH_TIMEOUT}s (HTTP $code, port $port)"; return 1
}

reload_proxy() {
  ./render.sh
  docker compose exec -T proxy caddy validate --config /etc/caddy/Caddyfile >/dev/null 2>&1 \
    || { echo "!!  invalid Caddyfile"; docker compose exec -T proxy caddy validate --config /etc/caddy/Caddyfile; return 1; }
  docker compose exec -T proxy caddy reload --config /etc/caddy/Caddyfile >/dev/null
}

# Old and new slot overlap for a few seconds, both running cron: every task takes a
# MySQL lock per tenant database (src/services/cron-lock.js), so none runs twice.

# Tenants switched in this run, with the slot they came from.
declare -A FROM
SWITCHED=()

rollback() {
  [ ${#SWITCHED[@]} -gt 0 ] || { echo "=== $(date -Is) deploy $TAG FAILED (nothing switched yet)"; exit 1; }
  echo "!!  rolling back ${SWITCHED[*]} to their previous slots"
  local t
  for t in "${SWITCHED[@]}"; do docker compose start "$t-${FROM[$t]}" >/dev/null; done
  for t in "${SWITCHED[@]}"; do
    if healthy "$t" "${FROM[$t]}"; then echo "${FROM[$t]}" > "state/$t"
    else echo "!!  $t: previous slot ${FROM[$t]} unhealthy too, left on the new build"; fi
  done
  reload_proxy; sleep $DRAIN
  for t in "${SWITCHED[@]}"; do
    [ "$(active "$t")" = "${FROM[$t]}" ] && docker compose stop "$t-$(other "${FROM[$t]}")" >/dev/null
  done
  echo "=== $(date -Is) deploy $TAG FAILED, rolled back ${SWITCHED[*]}"
  exit 1
}

echo "--- pulling webcoop/esstrapis-back:$TAG"
docker pull -q "webcoop/esstrapis-back:$TAG" >/dev/null

deploy_batch() {
  local t next pids=() failed=0
  echo "--- deploying $*"
  for t in "$@"; do
    next=$(other "$(active "$t")")
    BACK_TAG=$TAG docker compose up -d --no-deps --force-recreate "$t-$next" 2>&1 | grep -vE "^\s*$" || true
  done
  for t in "$@"; do healthy "$t" "$(other "$(active "$t")")" & pids+=($!); done
  for p in "${pids[@]}"; do wait "$p" || failed=1; done
  if [ $failed = 1 ]; then
    for t in "$@"; do docker compose stop "$t-$(other "$(active "$t")")" >/dev/null || true; done
    rollback
  fi
  # Switch the proxy, let the old slots drain, stop them.
  for t in "$@"; do FROM[$t]=$(active "$t"); other "${FROM[$t]}" > "state/$t"; SWITCHED+=("$t"); done
  reload_proxy || rollback
  sleep $DRAIN
  for t in "$@"; do docker compose stop "$t-${FROM[$t]}" >/dev/null; echo "    $t now on $(active "$t")"; done
}

i=0
if [ "${ORDER[0]}" = "$CANARY" ] && [ ${#ONLY[@]} -eq 0 ]; then deploy_batch "$CANARY"; i=1; fi
while [ $i -lt ${#ORDER[@]} ]; do deploy_batch "${ORDER[@]:i:PARALLEL}"; i=$((i + PARALLEL)); done

if [ ${#ONLY[@]} -eq 0 ]; then
  { grep -v '^BACK_TAG=' .env 2>/dev/null || true; echo "BACK_TAG=$TAG"; } > .env.new && mv .env.new .env
fi

# Keep the current and previous backend images; drop older ones.
KEEP="webcoop/esstrapis-back:$TAG webcoop/esstrapis-back:$PREV"
docker images webcoop/esstrapis-back --format '{{.Repository}}:{{.Tag}}' | while read -r img; do
  case " $KEEP " in *" $img "*) ;; *) docker rmi "$img" >/dev/null 2>&1 || true ;; esac
done

echo "=== $(date -Is) deploy $TAG OK (${#ORDER[@]} tenants)"
