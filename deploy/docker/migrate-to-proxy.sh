#!/usr/bin/env bash
# One-time move from one container per tenant on its public port
# (esstrapis-back-<tenant>) to the proxy + blue/green slots used by deploy.sh.
#
# Per tenant: start <tenant>-blue (public port + 10000) with the current build,
# wait until it answers, stop the old container (frees the public port) and
# reload Caddy to listen there. The public port is unreachable only between
# those two steps (~1-3 s), once. If the proxy doesn't answer afterwards, the
# old container is started again and the script stops.
#
#   ./migrate-to-proxy.sh [tenant ...]     (default: all in tenants.conf, canary first)
set -euo pipefail
cd "$(dirname "$(readlink -f "$0")")"
CANARY=buida
TAG=$(sed -n 's/^BACK_TAG=//p' .env)
[[ "$TAG" =~ ^v5-[0-9a-f]{40}$ ]] || { echo "No BACK_TAG in .env"; exit 1; }

declare -A PORT; ALL=()
while read -r name port _; do [[ -z "$name" || "$name" == \#* ]] && continue; PORT[$name]=$port; ALL+=("$name"); done < tenants.conf
if [ $# -gt 0 ]; then ORDER=("$@"); else ORDER=(); [ -n "${PORT[$CANARY]:-}" ] && ORDER+=("$CANARY"); for t in "${ALL[@]}"; do [ "$t" = "$CANARY" ] || ORDER+=("$t"); done; fi

up() {  # port timeout -> waits for HTTP 200 on 127.0.0.1:port
  local i; for i in $(seq 1 "$2"); do
    [ "$(curl -s -o /dev/null -m 5 -w '%{http_code}' "http://127.0.0.1:$1/api/logos?_limit=1" || true)" = 200 ] && return 0; sleep 1
  done; return 1
}
wait_cron_window() {
  local to_next=$(( 300 - $(date +%s) % 300 ))
  if [ $to_next -ge 25 ] && [ $to_next -le 110 ]; then echo "    waiting $((to_next + 5))s to stay clear of the */5 cron tick"; sleep $((to_next + 5)); fi
}

exec 9>.deploy.lock
flock -n 9 || { echo "A deploy is running"; exit 3; }

./render.sh
docker compose up -d proxy
for i in $(seq 1 30); do docker compose exec -T proxy wget -qO /dev/null http://127.0.0.1:2019/config/ 2>/dev/null && break; sleep 1; done

for t in "${ORDER[@]}"; do
  [ -n "${PORT[$t]:-}" ] || { echo "Unknown tenant $t"; exit 1; }
  [ -f "state/$t" ] && { echo "--- $t already behind the proxy"; continue; }
  wait_cron_window
  echo "--- $t: starting $t-blue on $((PORT[$t] + 10000))"
  BACK_TAG=$TAG docker compose up -d --no-deps "$t-blue" >/dev/null 2>&1
  up $((PORT[$t] + 10000)) 180 || { echo "!! $t-blue not healthy; old container untouched"; docker compose stop "$t-blue"; exit 1; }
  echo blue > "state/$t"; ./render.sh
  docker compose exec -T proxy caddy validate --config /etc/caddy/Caddyfile >/dev/null 2>&1 || { rm "state/$t"; ./render.sh; echo "!! invalid Caddyfile"; exit 1; }
  t0=$(date +%s.%N)
  docker stop -t 30 "esstrapis-back-$t" >/dev/null
  docker compose exec -T proxy caddy reload --config /etc/caddy/Caddyfile >/dev/null
  if up "${PORT[$t]}" 15; then
    echo "    $t: public port ${PORT[$t]} served by the proxy after $(awk -v a="$t0" -v b="$(date +%s.%N)" 'BEGIN{printf "%.1f", b-a}')s"
    docker rm "esstrapis-back-$t" >/dev/null
  else
    echo "!! $t: proxy not answering on ${PORT[$t]}; restoring the old container"
    rm "state/$t"; ./render.sh; docker compose exec -T proxy caddy reload --config /etc/caddy/Caddyfile >/dev/null || true
    docker start "esstrapis-back-$t" >/dev/null; docker compose stop "$t-blue" >/dev/null; exit 1
  fi
done
echo "=== migration done"
