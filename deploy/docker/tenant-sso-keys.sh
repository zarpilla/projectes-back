#!/usr/bin/env bash
# Each tenant's own TICKETS_SSO_KEY and DOCS_SSO_KEY (issues/404).
#
# The tickets and docs sites keep a master key each; a tenant only holds the key
# derived from it for its own SSO tenant, so reading one tenant's env doesn't let
# anyone sign in as another. The derivation is tenantSecret() in lib/sso.js of
# esstrapis-tickets and esstrapis-docs.
#
#   ./tenant-sso-keys.sh <tenant>...   set the keys of these tenants (create-tenant.sh does)
#   ./tenant-sso-keys.sh --all         of every tenant in tenants.conf
#   ./tenant-sso-keys.sh --rotate      new master keys, then --all (see below)
#
# --rotate: writes new master keys in both sites' .env with
# SSO_SHARED_KEY_ALLOWED=0, restarts the sites, takes the master keys out of
# envs/_shared.env and sets every tenant's keys. SSO to tickets and docs fails
# from then until the next backend deploy, which loads the new envs.
#
# Run from /var/www/esstrapis-back. Keys are never printed. Each changed file
# keeps a .bak-<date> copy (mode 600).
set -euo pipefail
cd "$(dirname "$0")"

TICKETS_DIR=${TICKETS_DIR:-/var/www/tiquets}
DOCS_DIR=${DOCS_DIR:-/var/www/docs}
ENVS=${ENVS:-envs}
STAMP=$(date +%Y%m%d-%H%M%S)

die() { echo "!! $*" >&2; exit 1; }

env_value() {  # file KEY
  grep "^$2=" "$1" 2>/dev/null | tail -1 | cut -d= -f2- | sed "s/^['\"]//; s/['\"]$//" || true
}

# Sets KEY='value' in a file, keeping a backup and its mode. Value on stdin.
set_value() {  # file KEY
  local file=$1 key=$2 value tmp; value=$(cat)
  grep -qxF "$key='$value'" "$file" && return 0
  cp -p "$file" "$file.bak-$STAMP"
  tmp=$(mktemp "$file.XXXXXX")
  chmod --reference="$file" "$tmp"
  { grep -v "^$key=" "$file" || true; printf "%s='%s'\n" "$key" "$value"; } > "$tmp"
  mv "$tmp" "$file"
}

derive() {  # label tenant (master in $MASTER)
  LABEL=$1 TENANT=$2 python3 -c '
import base64, hashlib, hmac, os
msg = "esstrapis-%s-sso-tenant:%s" % (os.environ["LABEL"], os.environ["TENANT"])
mac = hmac.new(os.environ["MASTER"].encode(), msg.encode(), hashlib.sha256).digest()
print(base64.urlsafe_b64encode(mac).decode().rstrip("="))'
}

# The tenant its tokens carry: TICKETS_TENANT, or the one frozen in its database
# (src/services/sso-tenant.js).
sso_tenant() {  # env file
  local file=$1 pinned db user
  pinned=$(env_value "$file" TICKETS_TENANT)
  if [ -n "$pinned" ]; then echo "$pinned"; return; fi
  db=$(env_value "$file" DATABASE_NAME); user=$(env_value "$file" DATABASE_USERNAME)
  MYSQL_PWD=$(env_value "$file" DATABASE_PASSWORD) mysql -h 127.0.0.1 -u "$user" -N -B "$db" \
    -e "SELECT value FROM strapi_core_store_settings WHERE \`key\`='core_esstrapis_sso_tenant'" | tr -d '"'
}

set_tenant() {  # tenant name
  local name=$1 file="$ENVS/$1.env" slug
  [ -f "$file" ] || die "$file not found"
  slug=$(sso_tenant "$file")
  [[ "$slug" =~ ^[a-z0-9][a-z0-9_-]{1,62}$ ]] || die "$name: no valid SSO tenant ('$slug'); start it once, or set TICKETS_TENANT"
  MASTER=$TICKETS_MASTER derive tickets "$slug" | set_value "$file" TICKETS_SSO_KEY
  MASTER=$DOCS_MASTER derive docs "$slug" | set_value "$file" DOCS_SSO_KEY
  echo "$name: keys set for SSO tenant $slug"
}

rotate() {
  local dir value
  for dir in "$TICKETS_DIR" "$DOCS_DIR"; do [ -w "$dir/.env" ] || die "can't write $dir/.env"; done
  openssl rand -base64 48 | tr -d '\n' | set_value "$TICKETS_DIR/.env" TICKETS_SSO_KEY
  openssl rand -base64 48 | tr -d '\n' | set_value "$DOCS_DIR/.env" DOCS_SSO_KEY
  for dir in "$TICKETS_DIR" "$DOCS_DIR"; do
    printf 0 | set_value "$dir/.env" SSO_SHARED_KEY_ALLOWED
    (cd "$dir" && docker compose up -d --force-recreate >/dev/null)
    echo "restarted $dir"
  done
  # the template of new tenants must not hand out a master key
  if [ -f "$ENVS/_shared.env" ]; then
    cp -p "$ENVS/_shared.env" "$ENVS/_shared.env.bak-$STAMP"
    sed -i '/^TICKETS_SSO_KEY=/d; /^DOCS_SSO_KEY=/d' "$ENVS/_shared.env"
  fi
}

[ $# -gt 0 ] || { sed -n '2,20p' "$0"; exit 1; }
[ "$1" = --rotate ] && rotate
TICKETS_MASTER=$(env_value "$TICKETS_DIR/.env" TICKETS_SSO_KEY)
DOCS_MASTER=$(env_value "$DOCS_DIR/.env" DOCS_SSO_KEY)
[ ${#TICKETS_MASTER} -ge 32 ] || die "no TICKETS_SSO_KEY in $TICKETS_DIR/.env"
[ ${#DOCS_MASTER} -ge 32 ] || die "no DOCS_SSO_KEY in $DOCS_DIR/.env"

if [ "$1" = --rotate ] || [ "$1" = --all ]; then
  while read -r name _; do
    [[ -z "$name" || "$name" == \#* ]] && continue
    set_tenant "$name"
  done < tenants.conf
  echo "Now deploy the backends, so they load the new envs."
else
  for name in "$@"; do set_tenant "$name"; done
fi
