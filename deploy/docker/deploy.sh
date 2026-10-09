#!/usr/bin/env bash
# Deploys a backend image to the Docker tenants, canary first, then two at a time.
# If a tenant doesn't become healthy, every tenant updated in this run goes back
# to the previous image and the script exits non-zero.
#
#   ./deploy.sh v5-<40-hex sha> [tenant ...]     e.g. ./deploy.sh v5-8b48003... buida
#
# GitHub Actions calls it over SSH with a key restricted to this script
# (authorized_keys: command="/var/www/esstrapis-back/deploy.sh",restrict ...);
# the arguments then arrive in SSH_ORIGINAL_COMMAND.
#
# The deployed tag is kept in .env (BACK_TAG), which docker-compose.yml reads,
# so a plain `docker compose up -d` keeps running the same build.
set -euo pipefail
cd "$(dirname "$(readlink -f "$0")")"

CANARY=buida
PARALLEL=2
HEALTH_TIMEOUT=${HEALTH_TIMEOUT:-180}
LOG=deploy.log

# Arguments come from SSH_ORIGINAL_COMMAND (forced command) or the command line.
if [ -n "${SSH_ORIGINAL_COMMAND:-}" ]; then read -r -a ARGS <<<"$SSH_ORIGINAL_COMMAND"; else ARGS=("$@"); fi
TAG="${ARGS[0]:-}"
[[ "$TAG" =~ ^v5-[0-9a-f]{40}$ ]] || { echo "Usage: deploy.sh v5-<40-hex sha> [tenant ...]"; exit 2; }

ALL=$(docker compose config --services)
ONLY=("${ARGS[@]:1}")
for t in "${ONLY[@]}"; do grep -qx -- "$t" <<<"$ALL" || { echo "Unknown tenant: $t"; exit 2; }; done

exec 9>.deploy.lock
flock -n 9 || { echo "Another deploy is running"; exit 3; }
# Finish (or roll back) even if the SSH session that started us goes away:
# ignore hangups, and keep logging to the file when stdout is gone.
trap '' HUP PIPE
exec > >(tee -a --output-error=warn-nopipe "$LOG") 2>&1

PREV=$(sed -n "s/^BACK_TAG=//p" .env 2>/dev/null || true)
PREV=${PREV:-v5}
echo "=== $(date -Is) deploy $TAG (previous $PREV)${ONLY:+ to ${ONLY[*]}}"

# Order: canary first, then the rest.
if [ ${#ONLY[@]} -gt 0 ]; then ORDER=("${ONLY[@]}")
else
  ORDER=()
  grep -qx "$CANARY" <<<"$ALL" && ORDER+=("$CANARY")
  while read -r t; do [ "$t" = "$CANARY" ] || ORDER+=("$t"); done <<<"$ALL"
fi

port_of() { sed -n "s/^PORT='\{0,1\}\([0-9]*\)'\{0,1\}$/\1/p" "envs/$1.env"; }

healthy() {
  local port; port=$(port_of "$1"); local waited=0 code=000
  while [ $waited -lt $HEALTH_TIMEOUT ]; do
    sleep 3; waited=$((waited + 3))
    code=$(curl -s -o /dev/null -m 5 -w '%{http_code}' "http://127.0.0.1:$port/api/logos?_limit=1" || true)
    [ "$code" = 200 ] && { echo "    $1 healthy after ${waited}s (port $port)"; return 0; }
  done
  echo "!!  $1 not healthy after ${HEALTH_TIMEOUT}s (HTTP $code, port $port)"; return 1
}

DONE=()
rollback() {
  echo "!!  rolling back ${DONE[*]} to $PREV"
  BACK_TAG=$PREV docker compose up -d --no-deps "${DONE[@]}"
  for t in "${DONE[@]}"; do healthy "$t" || echo "!!  $t is unhealthy on $PREV too: docker compose logs $t"; done
  echo "=== $(date -Is) deploy $TAG FAILED, rolled back to $PREV"
  exit 1
}

echo "--- pulling webcoop/esstrapis-back:$TAG"
BACK_TAG=$TAG docker compose pull -q "${ORDER[@]}"

deploy_batch() {
  echo "--- deploying $*"
  DONE+=("$@")
  BACK_TAG=$TAG docker compose up -d --no-deps "$@"
  local ok=0 pids=() t
  for t in "$@"; do healthy "$t" & pids+=($!); done
  for p in "${pids[@]}"; do wait "$p" || ok=1; done
  [ $ok = 0 ] || rollback
}

# Canary alone, then batches of $PARALLEL.
i=0
if [ "${ORDER[0]}" = "$CANARY" ] && [ ${#ONLY[@]} -eq 0 ]; then deploy_batch "$CANARY"; i=1; fi
while [ $i -lt ${#ORDER[@]} ]; do deploy_batch "${ORDER[@]:i:PARALLEL}"; i=$((i + PARALLEL)); done

# Record the tag only for full deploys, so `docker compose up -d` keeps it.
if [ ${#ONLY[@]} -eq 0 ]; then
  { grep -v '^BACK_TAG=' .env 2>/dev/null || true; echo "BACK_TAG=$TAG"; } > .env.new && mv .env.new .env
fi

# Keep the current and previous backend images; drop older ones.
KEEP="webcoop/esstrapis-back:$TAG webcoop/esstrapis-back:$PREV"
docker images webcoop/esstrapis-back --format '{{.Repository}}:{{.Tag}}' | while read -r img; do
  case " $KEEP " in *" $img "*) ;; *) docker rmi "$img" >/dev/null 2>&1 || true ;; esac
done

echo "=== $(date -Is) deploy $TAG OK (${#ORDER[@]} tenants)"
