#!/usr/bin/env bash
# Moves a tenant back from Docker to PM2 (the code on disk, as before).
#   ./to-pm2.sh <tenant>
set -euo pipefail
T="${1:?tenant}"
cd "$(dirname "$0")"
export NVM_DIR="$HOME/.nvm"; . "$NVM_DIR/nvm.sh" >/dev/null 2>&1; nvm use 20 >/dev/null 2>&1
NAME="strapi-projectes-$T-v5"
CFG="$HOME/pm2-apps/$NAME.config.js"
docker compose stop "$T" >/dev/null 2>&1 || true
docker compose rm -f "$T" >/dev/null 2>&1 || true
[ -f "$CFG.docker" ] && mv "$CFG.docker" "$CFG"
[ -f "$CFG" ] || { echo "No $CFG"; exit 1; }
PORT=$(node -e "console.log(require('$CFG').apps[0].env.PORT)")
pm2 startOrRestart "$CFG" --update-env >/dev/null
pm2 save >/dev/null
code=000; for i in $(seq 1 60); do
  sleep 3; code=$(curl -s -o /dev/null -m 5 -w '%{http_code}' "http://127.0.0.1:$PORT/api/logos?_limit=1" || true)
  [ "$code" = 200 ] && break
done
echo "== $T back on PM2 (HTTP $code on port $PORT)"
