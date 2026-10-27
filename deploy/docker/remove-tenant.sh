#!/usr/bin/env bash
# Removes a tenant from the VPS: backend, front, proxy, nightly dumps.
#
#   ./remove-tenant.sh <name> [--dry-run]
#
# Steps:
#   1. last full dump of its database   -> ~/arxiu-tenants/<name>-<date>/<db>.sql.gz
#   2. backend slots + front container   stopped and removed
#   3. tenants.conf, front sites.conf, pinned.conf (both) and tenant-dumps.skip
#      lose the tenant (each keeps a .bak-<date>); render.sh + proxy reload
#   4. envs/<name>.env, state/<name>, /var/www/projectes-<name> (uploads + front)
#      and /var/backups/tenant-dumps/<name> moved into the same archive folder
#
# It does NOT drop the database or touch nginx/certbot (they need the MySQL admin
# and sudo): it prints those commands at the end. Refuses the deploy canary.
# Run it as the deploy user from /var/www/esstrapis-back (a copy of
# deploy/docker/remove-tenant.sh).
set -euo pipefail
cd "$(dirname "$(readlink -f "$0")")"

WWW=${WWW:-/var/www}
FRONT_DIR=${FRONT_DIR:-$WWW/esstrapis-front}
TENANT_DUMPS=${TENANT_DUMPS:-/var/backups/tenant-dumps}
ARCHIVE_ROOT=${ARCHIVE_ROOT:-$HOME/arxiu-tenants}

say() { printf '\n== %s\n' "$*"; }
info() { printf '   %s\n' "$*"; }
die() { printf '!! %s\n' "$*" >&2; exit 1; }

NAME="" DRY_RUN=false
for a in "$@"; do
  case "$a" in
    --dry-run) DRY_RUN=true ;;
    -h|--help|-*) sed -n '2,4p' "$0" | sed 's/^# \{0,1\}//'; exit 2 ;;
    *) [ -z "$NAME" ] && NAME=$a || die "One tenant at a time" ;;
  esac
done
[ -n "$NAME" ] || die "Usage: ./remove-tenant.sh <name> [--dry-run]"
[[ "$NAME" =~ ^[a-z][a-z0-9_]{1,30}$ ]] || die "Bad name '$NAME'"
[ -f tenants.conf ] && [ -f render.sh ] || die "Run it from the backend deploy dir (tenants.conf and render.sh not found)"
CANARY=$(sed -n 's/^CANARY=//p' deploy.sh | head -1)
[ "$NAME" != "$CANARY" ] || die "'$NAME' is the deploy canary (CANARY in deploy.sh): pick another canary first"
grep -qE "^$NAME[[:space:]]" tenants.conf || die "'$NAME' is not in tenants.conf"

env_get() { sed -n "s/^$1=//p" "envs/$NAME.env" | tail -1 | sed "s/^['\"]//; s/['\"]\$//"; }
ENV_FILE=envs/$NAME.env
[ -f "$ENV_FILE" ] || die "$ENV_FILE not found"
DB=$(env_get DATABASE_NAME)
DB_USER=$(env_get DATABASE_USERNAME)
DB_HOST=$(env_get DATABASE_HOST); DB_HOST=${DB_HOST:-127.0.0.1}
DB_PORT=$(env_get DATABASE_PORT); DB_PORT=${DB_PORT:-3306}
DOMAIN=$(env_get URL | sed -E 's#^https?://##; s#/.*##')
[[ "$DB" =~ ^[A-Za-z0-9_]+$ ]] || die "No usable DATABASE_NAME in $ENV_FILE"
TENANT_DIR=$WWW/projectes-$NAME
FRONT=$TENANT_DIR/docker
STAMP=$(date +%Y%m%d-%H%M%S)
ARCHIVE=$ARCHIVE_ROOT/$NAME-$STAMP

say "Removing tenant $NAME"
info "database   $DB (user $DB_USER) — dumped, NOT dropped"
info "domain     ${DOMAIN:-?}"
info "archive    $ARCHIVE"
info "moves      $ENV_FILE, state/$NAME, $TENANT_DIR, $TENANT_DUMPS/$NAME"
if $DRY_RUN; then say "Dry run: nothing was changed"; exit 0; fi

umask 077
mkdir -p "$ARCHIVE"

# ── 1. last dump ───────────────────────────────────────────────────────────────
say "1. Dumping $DB"
MYSQL_PWD=$(env_get DATABASE_PASSWORD) mysqldump -h "$DB_HOST" -P "$DB_PORT" -u "$DB_USER" \
  --single-transaction --quick --routines --triggers --no-tablespaces "$DB" | gzip -6 > "$ARCHIVE/$DB.sql.gz"
gzip -t "$ARCHIVE/$DB.sql.gz" && [ "$(stat -c %s "$ARCHIVE/$DB.sql.gz")" -gt 1000 ] || die "Dump failed; nothing else was changed"
info "$(du -h "$ARCHIVE/$DB.sql.gz" | cut -f1) in $ARCHIVE/$DB.sql.gz"

# ── 2. containers ──────────────────────────────────────────────────────────────
say "2. Stopping the backend and the front"
exec 9>.deploy.lock
flock -w 900 9 || die "A deploy has been running for 15 minutes; try again later"
docker compose rm -sf "$NAME-blue" "$NAME-green" 2>&1 | grep -vE '^\s*$|obsolete' || true
if [ -f "$FRONT/docker-compose.yml" ]; then
  (cd "$FRONT" && docker compose down 2>&1 | grep -vE '^\s*$|obsolete' || true)
fi

# ── 3. config files ────────────────────────────────────────────────────────────
say "3. Taking $NAME out of the config files"
drop_line() {  # file: removes the lines whose first word is $NAME
  [ -f "$1" ] && grep -qE "^[[:space:]]*$NAME([[:space:]]|\$)" "$1" || return 0
  cp -p "$1" "$1.bak-$STAMP"
  grep -vE "^[[:space:]]*$NAME([[:space:]]|\$)" "$1.bak-$STAMP" > "$1" || true
  info "$1 (backup $(basename "$1").bak-$STAMP)"
}
drop_line tenants.conf
drop_line pinned.conf
drop_line tenant-dumps.skip
drop_line "$FRONT_DIR/sites.conf"
drop_line "$FRONT_DIR/pinned.conf"
./render.sh >/dev/null
docker compose exec -T proxy caddy validate --config /etc/caddy/Caddyfile >/dev/null 2>&1 || die "Invalid Caddyfile after render.sh (backups: *.bak-$STAMP)"
docker compose exec -T proxy caddy reload --config /etc/caddy/Caddyfile 2>&1 | grep -vE '^\s*$|obsolete|"level":"(info|warn)"' || true
flock -u 9

# ── 4. archive ─────────────────────────────────────────────────────────────────
say "4. Archiving its files"
mv "$ENV_FILE" "$ARCHIVE/"
for f in envs/"$NAME".env.bak-*; do if [ -e "$f" ]; then mv "$f" "$ARCHIVE/"; fi; done
if [ -e "state/$NAME" ]; then mv "state/$NAME" "$ARCHIVE/state"; fi
if [ -e "$TENANT_DIR" ]; then mv "$TENANT_DIR" "$ARCHIVE/projectes-$NAME"; fi
if [ -e "$TENANT_DUMPS/$NAME" ]; then
  mv "$TENANT_DUMPS/$NAME" "$ARCHIVE/tenant-dumps" 2>/dev/null || info "could not move $TENANT_DUMPS/$NAME (root?): see below"
fi
info "$(du -sh "$ARCHIVE" | cut -f1) in $ARCHIVE"

say "Done. Left for root / the MySQL admin:"
if [ -e "$TENANT_DUMPS/$NAME" ]; then info "sudo rm -rf $TENANT_DUMPS/$NAME"; fi
if [ -n "$DOMAIN" ]; then
  info "sudo rm /etc/nginx/sites-enabled/$DOMAIN && sudo nginx -t && sudo systemctl reload nginx"
  info "sudo mv /etc/nginx/sites-available/$DOMAIN $ARCHIVE/   # or rm"
  info "sudo certbot delete --cert-name $DOMAIN   # only if it has its own certificate"
fi
info "mysql -u admin -p -e \"DROP DATABASE \\\`$DB\\\`; DROP USER '$DB_USER'@'localhost';\"   # check the user's host first"
info "and remove the DNS record for ${DOMAIN:-the domain}"
