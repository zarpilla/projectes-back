#!/usr/bin/env bash
# Installs tenant-dumps.sh on the VPS and hooks it into the nightly backup.
# Run once, from /var/www/esstrapis-back (where tenant-dumps.sh was copied):
#
#   sudo bash install-tenant-dumps.sh
#
# - copies tenant-dumps.sh to /usr/local/sbin/
# - calls it from /usr/local/sbin/backup-storagebox.sh right before borg, so it
#   runs at the same hour, one tenant after the other (a backup of the script
#   is left next to it). borg doesn't need these files: it has mysql-all.sql
# - runs it once now, so the admins have a copy before tonight
set -euo pipefail
[ "$(id -u)" = 0 ] || { echo "Run it with sudo"; exit 1; }
cd "$(dirname "$(readlink -f "$0")")"

install -m 755 -o root -g root tenant-dumps.sh /usr/local/sbin/tenant-dumps.sh
echo "installed /usr/local/sbin/tenant-dumps.sh"

BS=/usr/local/sbin/backup-storagebox.sh
if grep -q tenant-dumps.sh "$BS"; then
  echo "$BS already calls it"
else
  cp -a "$BS" "$BS.bak-$(date +%Y%m%d)"
  # before step 2 (borg create); a failure marks the run as failed in healthchecks
  sed -i 's|^# 2\. Files + dumps|# 1b. Per-tenant dumps for «Còpia de seguretat» (Administració)\nlog "tenant dumps"\n/usr/local/sbin/tenant-dumps.sh \|\| { log "ERROR tenant dumps"; rc=1; }\n\n# 2. Files + dumps|' "$BS"
  grep -q tenant-dumps.sh "$BS" || { echo "Could not find '# 2. Files + dumps' in $BS: add the call by hand"; exit 1; }
  bash -n "$BS"
  echo "$BS now calls it (backup: $BS.bak-$(date +%Y%m%d))"
fi

echo "first run:"
/usr/local/sbin/tenant-dumps.sh
ls -la /var/backups/tenant-dumps/*/
