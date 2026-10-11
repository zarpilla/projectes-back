#!/usr/bin/env bash
# Creates a new tenant on the VPS: database, backend (blue slot behind the proxy),
# front container and nginx site.
#
#   ./create-tenant.sh <name> <domain> [--user-email <e-mail>] [--skip-nginx] [--dry-run]
#   e.g. ./create-tenant.sh novacoop novacoop.esstrapis.org --user-email someone@novacoop.cat
#
# The database starts EMPTY: the backend's first boot creates the tables and
# seeds the catalogs, settings and home menu (src/services/seed-new-database.js).
# No other tenant is copied. With --user-email, that boot also creates a first
# app user with the `admin` permission; its generated password is printed at the end.
#
# Steps, each skipped when already done, so a failed run can simply be rerun:
#   1. envs/<name>.env    shared settings (SMTP, API keys...) copied from the
#                         template tenant's env, plus new secrets and DB password
#   2. database           <name>_v5 and MySQL user <name> (asks the MySQL admin password)
#   3. backend            tenants.conf, render.sh, start <name>-blue, wait, switch the proxy
#   4. front              /var/www/projectes-<name>/docker, started, added to sites.conf
#   5. nginx + TLS        site file, reload, certbot (needs sudo; --skip-nginx prints the commands)
#
# Nothing existing is ever dropped or overwritten. Run it as the deploy user,
# from /var/www/esstrapis-back (it is a copy of deploy/docker/create-tenant.sh).
set -euo pipefail
cd "$(dirname "$(readlink -f "$0")")"

WWW=${WWW:-/var/www}
FRONT_DIR=${FRONT_DIR:-$WWW/esstrapis-front}
NGINX_DIR=${NGINX_DIR:-/etc/nginx}
TEMPLATE_ENV=${TEMPLATE_ENV:-envs/buida.env}
MYSQL_ADMIN_USER=${MYSQL_ADMIN_USER:-admin}
HEALTH_TIMEOUT=${HEALTH_TIMEOUT:-600}   # the first boot creates ~360 tables
FRONT_IMAGE=webcoop/esstrapis-front
MARKER="# Created by create-tenant.sh"

usage() { sed -n '2,7p' "$0" | sed 's/^# \{0,1\}//'; exit 2; }
say() { printf '\n== %s\n' "$*"; }
info() { printf '   %s\n' "$*"; }
die() { printf '!! %s\n' "$*" >&2; exit 1; }

NAME="" DOMAIN="" USER_EMAIL="" SKIP_NGINX=false DRY_RUN=false
while [ $# -gt 0 ]; do
  case "$1" in
    --user-email) USER_EMAIL="${2:-}"; shift 2 ;;
    --skip-nginx) SKIP_NGINX=true; shift ;;
    --dry-run) DRY_RUN=true; shift ;;
    -h|--help) usage ;;
    -*) echo "Unknown option: $1"; usage ;;
    *) if [ -z "$NAME" ]; then NAME=$1; elif [ -z "$DOMAIN" ]; then DOMAIN=$1; else usage; fi; shift ;;
  esac
done
[ -n "$NAME" ] && [ -n "$DOMAIN" ] || usage
[[ "$NAME" =~ ^[a-z][a-z0-9_]{1,30}$ ]] || die "Bad name '$NAME': lowercase letters, digits and _ only (it names the database and the containers)"
[[ "$DOMAIN" =~ ^[a-z0-9]([a-z0-9.-]*[a-z0-9])?\.[a-z]{2,}$ ]] || die "Bad domain '$DOMAIN'"
[ -z "$USER_EMAIL" ] || [[ "$USER_EMAIL" =~ ^[^@[:space:]\']+@[^@[:space:]\']+\.[^@[:space:]\']+$ ]] || die "Bad e-mail '$USER_EMAIL'"
[ -f tenants.conf ] && [ -f render.sh ] || die "Run it from the backend deploy dir (tenants.conf and render.sh not found)"
[ -f "$TEMPLATE_ENV" ] || die "Template env $TEMPLATE_ENV not found (set TEMPLATE_ENV)"
[ -f "$FRONT_DIR/sites.conf" ] || die "$FRONT_DIR/sites.conf not found"

ENV_FILE=envs/$NAME.env
TENANT_DIR=$WWW/projectes-$NAME
UPLOADS=$TENANT_DIR/uploads
FRONT=$TENANT_DIR/docker
DB_NAME=${NAME}_v5
DB_USER=$NAME
URL=https://$DOMAIN
NGINX_SITE=$NGINX_DIR/sites-available/$DOMAIN

# A tenant this script did not create is never touched.
RESUME=false
if [ -f "$ENV_FILE" ]; then
  grep -qxF "$MARKER" "$ENV_FILE" || die "$ENV_FILE exists and was not created by this script: tenant '$NAME' already exists"
  RESUME=true
elif grep -qE "^$NAME[[:space:]]" tenants.conf; then
  die "Tenant '$NAME' is already in tenants.conf"
elif [ -e "$TENANT_DIR" ]; then
  die "$TENANT_DIR already exists"
fi
if grep -rqsF "server_name $DOMAIN;" "$NGINX_DIR/sites-enabled" && [ ! -e "$NGINX_SITE" ]; then
  die "Another nginx site already serves $DOMAIN"
fi

listening() { ss -ltnH 2>/dev/null | awk '{print $4}' | grep -qE "[:.]$1\$"; }
conf_port() { awk -v n="$NAME" '$1 == n { print $2 }' tenants.conf; }
env_get() { [ -f "$1" ] || return 0; sed -n "s/^$2=//p" "$1" | head -1 | sed "s/^['\"]//; s/['\"]\$//"; }

# Backend port: the next after the highest in tenants.conf, with both slots free.
BACK_PORT=$(conf_port)
if [ -z "$BACK_PORT" ]; then
  BACK_PORT=$(awk '$1 !~ /^#/ && $2 ~ /^[0-9]+$/ && $2 > m { m = $2 } END { print m + 1 }' tenants.conf)
  while listening "$BACK_PORT" || listening $((BACK_PORT + 10000)) || listening $((BACK_PORT + 20000)); do BACK_PORT=$((BACK_PORT + 1)); done
fi
# Front port: the next after the highest EXTERNAL_PORT of the sites in sites.conf.
FRONT_PORT=$(env_get "$FRONT/.env" EXTERNAL_PORT)
if [ -z "$FRONT_PORT" ]; then
  FRONT_PORT=8000
  while read -r _ dir _; do
    p=$(env_get "$dir/.env" EXTERNAL_PORT)
    [[ "$p" =~ ^[0-9]+$ ]] && [ "$p" -gt "$FRONT_PORT" ] && FRONT_PORT=$p
  done < <(grep -vE '^\s*(#|$)' "$FRONT_DIR/sites.conf")
  FRONT_PORT=$((FRONT_PORT + 1))
  while listening "$FRONT_PORT"; do FRONT_PORT=$((FRONT_PORT + 1)); done
fi
FRONT_TAG=""
while read -r _ dir _; do
  FRONT_TAG=$(sed -n "s#^\s*image:\s*$FRONT_IMAGE:\(\S*\)\s*\$#\1#p" "$dir/docker-compose.yml" 2>/dev/null | head -1 || true)
  [ -n "$FRONT_TAG" ] && break
done < <(grep -vE '^\s*(#|$)' "$FRONT_DIR/sites.conf")
[ -n "$FRONT_TAG" ] || die "Could not read the current front image tag from the sites in sites.conf"
BACK_TAG=$(sed -n 's/^BACK_TAG=//p' .env 2>/dev/null || true)
[ -n "$BACK_TAG" ] || die "No BACK_TAG in .env: nothing has been deployed here yet"

say "Tenant $NAME$($RESUME && echo ' (resuming)')"
info "URL            $URL  (front: $URL/stats/)"
info "database       $DB_NAME, user $DB_USER"
info "backend        port $BACK_PORT (blue $((BACK_PORT + 10000)), green $((BACK_PORT + 20000))), image $BACK_TAG"
info "front          port $FRONT_PORT, image $FRONT_TAG, in $FRONT"
info "uploads        $UPLOADS"
info "settings from  $TEMPLATE_ENV"
info "first user     ${USER_EMAIL:-none (create it later from the Strapi admin)}"
dig +short "$DOMAIN" 2>/dev/null | grep -q '[0-9]' && DNS_OK=true || DNS_OK=false
$DNS_OK || info "WARNING: $DOMAIN does not resolve yet; certbot will be skipped"
if $DRY_RUN; then say "Dry run: nothing was changed"; exit 0; fi

# ── 1. env file ────────────────────────────────────────────────────────────────
secret() { openssl rand -base64 32 | tr -d '\n'; }
# Letters, digits and a few signs that need no escaping in SQL, .env or shell.
password() { local p; p=$(openssl rand -base64 48 | tr -dc 'A-Za-z0-9' | cut -c1-"${1:-24}"); printf '%s' "Aa1_$p"; }

USER_PASSWORD=""
if ! $RESUME; then
  say "1. Writing $ENV_FILE"
  USER_PASSWORD=$([ -n "$USER_EMAIL" ] && password 14 || true)
  umask 077
  {
    echo "$MARKER on $(date -Is) (shared settings copied from $TEMPLATE_ENV)"
    echo "$MARKER"
    grep -vE "^\s*(#|\$)|^(URL|DATABASE_NAME|DATABASE_USERNAME|DATABASE_PASSWORD|APP_KEYS|API_TOKEN_SALT|ADMIN_JWT_SECRET|TRANSFER_TOKEN_SALT|JWT_SECRET|ENCRYPTION_KEY|SECRETS_KEY|TICKETS_TENANT|RESET_PASSWORD_URL|SEED_USER_[A-Z]*)=" "$TEMPLATE_ENV"
    echo "URL='$URL'"
    echo "DATABASE_NAME='$DB_NAME'"
    echo "DATABASE_USERNAME='$DB_USER'"
    echo "DATABASE_PASSWORD='$(password 24)'"
    echo "APP_KEYS='$(secret),$(secret),$(secret)'"
    for key in API_TOKEN_SALT ADMIN_JWT_SECRET TRANSFER_TOKEN_SALT JWT_SECRET ENCRYPTION_KEY; do echo "$key='$(secret)'"; done
    echo "SECRETS_KEY='$(openssl rand -hex 32)'"
    if [ -n "$USER_EMAIL" ]; then
      echo "SEED_USER_EMAIL='$USER_EMAIL'"
      echo "SEED_USER_PASSWORD='$USER_PASSWORD'"
    fi
  } > "$ENV_FILE.new"
  mv "$ENV_FILE.new" "$ENV_FILE"
  umask 022
else
  say "1. $ENV_FILE already written"
  USER_EMAIL=$(env_get "$ENV_FILE" SEED_USER_EMAIL)
  USER_PASSWORD=$(env_get "$ENV_FILE" SEED_USER_PASSWORD)
fi
DB_PASSWORD=$(env_get "$ENV_FILE" DATABASE_PASSWORD)
[ -n "$DB_PASSWORD" ] || die "No DATABASE_PASSWORD in $ENV_FILE"

# ── 2. database ────────────────────────────────────────────────────────────────
say "2. Database $DB_NAME"
tenant_sql() { MYSQL_PWD="$DB_PASSWORD" mysql -h 127.0.0.1 -u "$DB_USER" -N "$@" 2>/dev/null; }
if tenant_sql "$DB_NAME" -e "select 1" >/dev/null; then
  info "already there, and $DB_USER can open it"
else
  read -rsp "   MySQL password of '$MYSQL_ADMIN_USER': " ADMIN_PWD; echo
  admin_sql() { MYSQL_PWD="$ADMIN_PWD" mysql -h 127.0.0.1 -u "$MYSQL_ADMIN_USER" -N "$@"; }
  admin_sql -e "select 1" >/dev/null || die "Could not log in to MySQL as $MYSQL_ADMIN_USER"
  taken=$(admin_sql -e "select concat('database ', schema_name) from information_schema.schemata where schema_name = '$DB_NAME'
                        union all select concat('user ', user) from mysql.user where user = '$DB_USER'")
  [ -z "$taken" ] || die "Already in MySQL: $(echo "$taken" | paste -sd, -). Pick another name, or remove them by hand if they are leftovers."
  admin_sql <<SQL
CREATE DATABASE \`$DB_NAME\` CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;
CREATE USER '$DB_USER'@'localhost' IDENTIFIED WITH mysql_native_password BY '$DB_PASSWORD';
GRANT ALL PRIVILEGES ON \`$DB_NAME\`.* TO '$DB_USER'@'localhost';
SQL
  unset ADMIN_PWD
  tenant_sql "$DB_NAME" -e "select 1" >/dev/null || die "$DB_USER cannot open $DB_NAME after creating it"
  info "created (empty)"
fi

# ── 3. backend ─────────────────────────────────────────────────────────────────
say "3. Backend"
mkdir -p "$UPLOADS"
SLOT_PORT=$((BACK_PORT + 10000))
if [ -f "state/$NAME" ]; then
  info "already live in slot $(cat "state/$NAME")"
else
  # Same lock as deploy.sh: a CI deploy must not rewrite the compose file meanwhile.
  exec 9>.deploy.lock
  flock -w 900 9 || die "A deploy has been running for 15 minutes; try again later"
  grep -qE "^$NAME[[:space:]]" tenants.conf || echo "$NAME $BACK_PORT $UPLOADS" >> tenants.conf
  ./render.sh
  BACK_TAG=$BACK_TAG docker compose up -d "$NAME-blue" 2>&1 | grep -vE '^\s*$|obsolete' || true
  info "waiting for the first boot (creates the tables, then seeds them)..."
  waited=0 code=000
  until [ "$code" = 200 ]; do
    [ $waited -lt "$HEALTH_TIMEOUT" ] || die "$NAME-blue not answering after ${HEALTH_TIMEOUT}s. See: docker compose logs $NAME-blue   (rerun this script once fixed)"
    sleep 5; waited=$((waited + 5))
    code=$(curl -s -o /dev/null -m 5 -w '%{http_code}' "http://127.0.0.1:$SLOT_PORT/api/logos" || true)
  done
  info "answering after ${waited}s"
  echo blue > "state/$NAME"
  ./render.sh
  docker compose exec -T proxy caddy reload --config /etc/caddy/Caddyfile 2>&1 | grep -vE '^\s*$|obsolete|"level":"(info|warn)"' || true
  flock -u 9
  info "proxy serving it on 127.0.0.1:$BACK_PORT"
fi

# What the seed left: the settings record exists only if the image carries the seed.
SEEDED=$(tenant_sql "$DB_NAME" -e "select count(*) from us" || echo 0)
if [ "$SEEDED" = 0 ]; then
  info "WARNING: the database has NOT been seeded. The deployed image ($BACK_TAG) predates"
  info "the seed (src/services/seed-new-database.js) or the seed failed:"
  info "  docker compose logs $NAME-$(cat "state/$NAME") | grep -i seed"
else
  info "database seeded ($(tenant_sql "$DB_NAME" -e 'select count(*) from `users-permissions_user`' || echo '?') user)"
  # The first user's credentials are only needed by that first boot.
  if grep -q '^SEED_USER_' "$ENV_FILE"; then sed -i '/^SEED_USER_/d' "$ENV_FILE"; fi
fi

# ── 4. front ───────────────────────────────────────────────────────────────────
say "4. Front"
if [ ! -f "$FRONT/docker-compose.yml" ]; then
  mkdir -p "$FRONT"
  cat > "$FRONT/.env" <<ENV
VUE_APP_API_URL=$URL
VUE_APP_API_LOGIN=$URL/admin
VUE_APP_PATH=/stats
VUE_APP_RESET_PASSWORD="$URL/stats/#/reset-password"
EXTERNAL_PORT=$FRONT_PORT
ENV
  cat > "$FRONT/docker-compose.yml" <<YAML
services:
  esstrapis-front-$NAME:
    image: $FRONT_IMAGE:$FRONT_TAG
    ports:
      - "\${EXTERNAL_PORT:-8080}:80"
    environment:
      - NODE_ENV=production
      - VUE_APP_API_URL=\${VUE_APP_API_URL:-http://localhost:1337}
      - VUE_APP_RESET_PASSWORD=\${VUE_APP_RESET_PASSWORD:-http://localhost:8080/#/reset-password}
      - VUE_APP_PATH=\${VUE_APP_PATH:-/stats/}
    env_file:
      - .env
    restart: unless-stopped
YAML
fi
exec 8>"$FRONT_DIR/.deploy.lock"
flock -w 900 8 || die "A front deploy has been running for 15 minutes; try again later"
# Every site's compose dir is called `docker` (one shared compose project):
# never --remove-orphans or `down` here, it would remove the other sites' containers.
(cd "$FRONT" && docker compose up -d 2>&1 | grep -vE '^\s*$|obsolete' || true)
waited=0
until [[ "$(curl -s -m 5 "http://127.0.0.1:$FRONT_PORT/stats/" || true)" == *"assets/index"* ]]; do
  [ $waited -lt 90 ] || die "front not serving http://127.0.0.1:$FRONT_PORT/stats/ after 90s. See: cd $FRONT && docker compose logs"
  sleep 2; waited=$((waited + 2))
done
grep -qE "^$NAME[[:space:]]" "$FRONT_DIR/sites.conf" || printf '%-17s %s\n' "$NAME" "$FRONT" >> "$FRONT_DIR/sites.conf"
flock -u 8
info "serving on 127.0.0.1:$FRONT_PORT, listed in sites.conf"

# ── 5. nginx + TLS ─────────────────────────────────────────────────────────────
say "5. nginx"
SITE_DRAFT=$TENANT_DIR/nginx-site.conf
proxy_headers='proxy_http_version 1.1;
        proxy_set_header X-Forwarded-Host $host;
        proxy_set_header X-Forwarded-Server $host;
        proxy_set_header X-Real-IP $remote_addr;
        proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
        proxy_set_header X-Forwarded-Proto $scheme;
        proxy_set_header Host $http_host;
        proxy_set_header Upgrade $http_upgrade;
        proxy_set_header Connection "Upgrade";'
cat > "$SITE_DRAFT" <<NGINX
server {
    server_name $DOMAIN;

    location / {
        proxy_pass http://127.0.0.1:$BACK_PORT;
        $proxy_headers
    }

    location /stats {
        proxy_pass http://127.0.0.1:$FRONT_PORT;
        $proxy_headers

        location ~* \.(pdf|html)\$ {
            expires 30s;
        }
    }

    listen 80;
    listen [::]:80;
}
NGINX
NGINX_CMDS=(
  "sudo cp $SITE_DRAFT $NGINX_SITE"
  "sudo ln -s $NGINX_SITE $NGINX_DIR/sites-enabled/$DOMAIN"
  "sudo nginx -t"
  "sudo systemctl reload nginx"
)
CERTBOT_CMD="sudo certbot --nginx -d $DOMAIN"
NGINX_DONE=false
if [ -e "$NGINX_SITE" ]; then
  info "$NGINX_SITE already there"
  NGINX_DONE=true
elif $SKIP_NGINX || [ ! -t 0 ]; then
  info "skipped. Run:"
  for c in "${NGINX_CMDS[@]}" "$CERTBOT_CMD"; do info "  $c"; done
else
  for c in "${NGINX_CMDS[@]}"; do info "$c"; $c; done
  NGINX_DONE=true
  if $DNS_OK; then
    info "$CERTBOT_CMD"; $CERTBOT_CMD
  else
    info "$DOMAIN does not resolve yet. Once it does, run:  $CERTBOT_CMD"
  fi
fi

say "Tenant $NAME is up"
info "app        $URL/stats/"
info "admin      $URL/admin   (register the first Strapi admin there)"
if [ -n "$USER_EMAIL" ] && [ "$SEEDED" != 0 ]; then
  info "first user $USER_EMAIL"
  [ -z "$USER_PASSWORD" ] || info "password   $USER_PASSWORD   (shown only now; change it after the first login)"
fi
info "The demo company data (DEMO SCCL) is edited in Configuració General."
$NGINX_DONE || info "Still to do: the nginx commands above."
[ "$SEEDED" != 0 ] || info "Still to do: the database is empty, see the warning in step 3."
