#!/usr/bin/env bash
#
# vps-switch-frontend.sh — point a tenant's frontend container at another image
# tag and recreate it.
#
#   ./vps-switch-frontend.sh ~/pm2-apps/strapi-projectes-demo.config.js
#   ./vps-switch-frontend.sh --tag v5-abc1234 ~/pm2-apps/strapi-projectes-demo.config.js
#   ./vps-switch-frontend.sh ~/pm2-apps/strapi-projectes-{buida,demo,webcoop}.config.js
#
# The v3 build requests /me, /projects, … while v5 serves everything under
# /api, so a tenant whose backend has been cut over but whose frontend has not
# 404s every request and cannot log in. The two have to move together, which is
# why the cutover calls this.
#
# Only the named tenants' compose files are touched. `latest` is deliberately
# left alone: the tenants still on v3 follow it, and repointing it would break
# all of them at once.
#
# Rollback: cp <compose>.pre-v5 <compose> && docker compose up -d --force-recreate

set -Eeuo pipefail

FRONTEND_IMAGE="${FRONTEND_IMAGE:-webcoop/esstrapis-front}"
TAG="${FRONTEND_TAG:-v5}"

CONFIGS=()
while [ $# -gt 0 ]; do
  case "$1" in
    --tag) TAG="${2:?--tag needs a value}"; shift 2 ;;
    -*) echo "unknown option: $1"; exit 1 ;;
    *) CONFIGS+=("$1"); shift ;;
  esac
done
[ ${#CONFIGS[@]} -gt 0 ] || {
  echo "usage: vps-switch-frontend.sh [--tag <tag>] <v3-pm2-config.js> [more...]"; exit 1; }

rc=0
for cfg in "${CONFIGS[@]}"; do
  [ -f "$cfg" ] || { echo "!! config not found: $cfg"; rc=1; continue; }

  # The frontend lives in a docker/ dir beside the backend checkout, e.g.
  # /var/www/demo.projectes/{projectes,docker} — see deploy-projectes-front.sh.
  V3_CWD="$(node -e "console.log(require('$cfg').apps[0].cwd)")"
  NAME="$(node -e "console.log(require('$cfg').apps[0].name)")"
  FRONT_DIR="$(dirname "$V3_CWD")/docker"

  echo "──────── $NAME"
  if [ ! -d "$FRONT_DIR" ]; then
    echo "  !! no $FRONT_DIR — nothing to switch"; rc=1; continue
  fi

  # No `ls ... | head`: ls exits non-zero when one of the names is missing, and
  # with `set -o pipefail` that takes the whole script down silently.
  COMPOSE_FILE=""
  for candidate in "$FRONT_DIR/docker-compose.yml" "$FRONT_DIR/docker-compose.yaml"; do
    if [ -f "$candidate" ]; then COMPOSE_FILE="$candidate"; break; fi
  done
  if [ -z "$COMPOSE_FILE" ]; then
    echo "  !! no compose file in $FRONT_DIR"; rc=1; continue
  fi

  if ! grep -q "$FRONTEND_IMAGE" "$COMPOSE_FILE"; then
    echo "  !! $COMPOSE_FILE does not mention $FRONTEND_IMAGE — leaving it alone"; rc=1; continue
  fi

  # Keep the first original, so a rollback has something to restore.
  [ -f "$COMPOSE_FILE.pre-v5" ] || cp -p "$COMPOSE_FILE" "$COMPOSE_FILE.pre-v5"
  # The tag is OPTIONAL in the pattern: these compose files pin the image as
  # plain `webcoop/esstrapis-front`, which docker resolves to :latest. A regex
  # that required `:tag` matched nothing, so the file was left alone and the
  # container was recreated on :latest — a switch that silently did nothing.
  sed -i -E "s|($FRONTEND_IMAGE)(:[A-Za-z0-9._-]+)?|\1:$TAG|g" "$COMPOSE_FILE"
  # `grep | head` again: head closes the pipe, grep takes SIGPIPE, pipefail
  # propagates it. -m1 stops grep itself instead.
  echo "  $COMPOSE_FILE -> $(grep -m1 -oE "$FRONTEND_IMAGE:[A-Za-z0-9._-]+" "$COMPOSE_FILE")"
  # These files live in directories all called "docker", so every tenant shares
  # one compose project and `ps` lists them all. Each file should still define
  # only its own service; say so if not, because `up` would restart the others.
  SERVICES="$(grep -cE '^  [A-Za-z0-9_-]+:' "$COMPOSE_FILE" || true)"
  [ "$SERVICES" -le 1 ] || echo "  note: this file defines $SERVICES services — `up` will recreate all of them"

  if (cd "$FRONT_DIR" && docker compose pull && docker compose up -d --force-recreate); then
    echo "  ✓ recreated"
  else
    echo "  !! compose failed. Restore with:"
    echo "     cp $COMPOSE_FILE.pre-v5 $COMPOSE_FILE && (cd $FRONT_DIR && docker compose up -d --force-recreate)"
    rc=1
  fi
done

exit $rc
