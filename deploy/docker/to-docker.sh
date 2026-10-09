#!/usr/bin/env bash
# Moves one tenant from PM2 to the Docker image, on the same port, database and
# uploads. Rolls back to PM2 by itself if the container doesn't become healthy.
#
#   ./to-docker.sh <tenant>          e.g. ./to-docker.sh demo
#
# Needs: docker-compose.yml with a service named <tenant> (see the example),
# ~/pm2-apps/strapi-projectes-<tenant>-v5.config.js.
# The PM2 config is renamed to .config.js.docker, so deploy-projectes-back.sh
# skips the tenant; ./to-pm2.sh <tenant> undoes everything.
set -euo pipefail
T="${1:?tenant}"
cd "$(dirname "$0")"
export NVM_DIR="$HOME/.nvm"; . "$NVM_DIR/nvm.sh" >/dev/null 2>&1; nvm use 20 >/dev/null 2>&1
NAME="strapi-projectes-$T-v5"
CFG="$HOME/pm2-apps/$NAME.config.js"
[ -f "$CFG" ] || { echo "No $CFG (already on Docker?)"; exit 1; }
SERVICES=$(docker compose config --services); grep -qx "$T" <<<"$SERVICES" || { echo "No service '$T' in docker-compose.yml"; exit 1; }
PORT=$(node -e "console.log(require('$CFG').apps[0].env.PORT)")

mkdir -p envs && chmod 700 envs
node pm2-env-to-dotenv.js "$CFG" > "envs/$T.env.new" && chmod 600 "envs/$T.env.new" && mv "envs/$T.env.new" "envs/$T.env"
docker compose pull -q "$T"

echo "== stopping PM2 $NAME (port $PORT)"
pm2 stop "$NAME" >/dev/null && pm2 delete "$NAME" >/dev/null
mv "$CFG" "$CFG.docker"
pm2 save >/dev/null

echo "== starting container $T"
docker compose up -d "$T"
code=000; for i in $(seq 1 60); do
  sleep 3; code=$(curl -s -o /dev/null -m 5 -w '%{http_code}' "http://127.0.0.1:$PORT/api/logos?_limit=1" || true)
  [ "$code" = 200 ] && break
done
if [ "$code" != 200 ]; then
  echo "!! $T not healthy in Docker (HTTP $code); logs:"; docker compose logs --tail 40 "$T"
  echo "!! rolling back to PM2"; ./to-pm2.sh "$T"; exit 1
fi
echo "== $T runs in Docker ($(docker compose images -q "$T" | cut -c1-12)), healthy on port $PORT"
