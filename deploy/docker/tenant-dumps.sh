#!/usr/bin/env bash
# Nightly dump of each tenant's own database, for «Còpia de seguretat»
# (Administració): the app's admins download last night's copy.
#
#   /var/backups/tenant-dumps/<tenant>/latest.sql.gz
#
# Each backend mounts only its own folder, read-only, at /opt/app/backups
# (render.sh). One copy per tenant: tonight's replaces last night's.
#
# Runs as root (mysqldump through the root socket, like backup-storagebox.sh),
# called from /usr/local/sbin/backup-storagebox.sh before borg (install with
# install-tenant-dumps.sh). borg doesn't keep these: it has mysql-all.sql.
# The tenants are dumped ONE AFTER THE OTHER, at low CPU and
# IO priority: never 16 dumps at once.
#
# Left out (not the entity's data, and Strapi recreates them on boot):
# the Strapi admin panel's users, roles and permissions (admin_*), API and
# transfer tokens, and login sessions.
#
# Tenants listed in tenant-dumps.skip (next to tenants.conf, one name per
# line, e.g. demo) get no copy, and their folder is removed. render.sh reads
# the same file and doesn't mount the folder for them.
#
# Usage: tenant-dumps.sh [tenant ...]   (default: every tenant in tenants.conf)
# Exit code 1 when a dump failed; that tenant keeps its previous copy.
set -uo pipefail

BACK_DIR="${BACK_DIR:-/var/www/esstrapis-back}"
OUT="${TENANT_DUMPS:-/var/backups/tenant-dumps}"
# the backends run as the image's `node` user
OWNER="${TENANT_DUMPS_OWNER:-1000}"

log() { echo "[$(date '+%F %T')] tenant-dumps: $*"; }

# DATABASE_NAME from envs/<tenant>.env (values may be quoted)
db_of() {
  sed -n 's/^DATABASE_NAME=//p' "$BACK_DIR/envs/$1.env" 2>/dev/null | tail -1 | tr -d "\"' \r"
}

dump_one() {
  local tenant=$1 db dir tmp ignore
  db=$(db_of "$tenant")
  [[ "$db" =~ ^[A-Za-z0-9_]+$ ]] || { log "ERROR $tenant: no DATABASE_NAME in envs/$tenant.env"; return 1; }

  dir="$OUT/$tenant"
  mkdir -p "$dir" && chown "$OWNER" "$dir" && chmod 700 "$dir"
  tmp="$dir/.latest.sql.gz.tmp"

  ignore=$(mysql -N -B -e "
    SELECT CONCAT('--ignore-table=', table_schema, '.', table_name)
    FROM information_schema.tables
    WHERE table_schema = '$db'
      AND (table_name LIKE 'admin\\_%'
        OR table_name LIKE 'strapi\\_api\\_token%'
        OR table_name LIKE 'strapi\\_transfer\\_token%'
        OR table_name = 'strapi_sessions')") || { log "ERROR $tenant: can't list tables of $db"; return 1; }

  local start=$SECONDS
  # shellcheck disable=SC2086  # one --ignore-table=… word per line
  if nice -n 19 ionice -c3 mysqldump --single-transaction --quick --routines --triggers \
      --no-tablespaces $ignore "$db" | nice -n 19 gzip -6 > "$tmp" \
     && [ -s "$tmp" ] && gzip -t "$tmp"; then
    chown "$OWNER" "$tmp" && chmod 600 "$tmp"
    mv -f "$tmp" "$dir/latest.sql.gz"
    log "$tenant ($db) $(du -h "$dir/latest.sql.gz" | cut -f1) in $((SECONDS - start)) s"
  else
    rm -f "$tmp"
    log "ERROR $tenant ($db): dump failed, previous copy kept"
    return 1
  fi
}

mkdir -p "$OUT" && chmod 755 "$OUT"

SKIP_FILE="$BACK_DIR/tenant-dumps.skip"
skipped() { [ -f "$SKIP_FILE" ] && grep -qxE "[[:space:]]*$1[[:space:]]*" "$SKIP_FILE"; }

if [ $# -gt 0 ]; then
  TENANTS=("$@")
else
  mapfile -t TENANTS < <(awk '!/^[[:space:]]*(#|$)/ { print $1 }' "$BACK_DIR/tenants.conf")
fi

rc=0
for tenant in "${TENANTS[@]}"; do
  [[ "$tenant" =~ ^[a-z0-9_]+$ ]] || { log "ERROR bad tenant name: $tenant"; rc=1; continue; }
  skipped "$tenant" && { log "$tenant skipped (tenant-dumps.skip)"; continue; }
  dump_one "$tenant" || rc=1
done

# folders of tenants that are gone or skipped
[ -s "$BACK_DIR/tenants.conf" ] && for dir in "$OUT"/*/; do
  [ -d "$dir" ] || continue
  name=$(basename "$dir")
  skipped "$name" && { log "removing $dir (tenant-dumps.skip)"; rm -rf "$dir"; continue; }
  grep -qE "^[[:space:]]*$name[[:space:]]" "$BACK_DIR/tenants.conf" || { log "removing $dir (not in tenants.conf)"; rm -rf "$dir"; }
done

[ $rc -eq 0 ] && log "OK (${#TENANTS[@]} tenants)" || log "FAILED"
exit $rc
