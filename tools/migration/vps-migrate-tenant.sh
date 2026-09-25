#!/usr/bin/env bash
#
# vps-migrate-tenant.sh — migrate one ESSTRAPIS tenant from v3 to v5 on the VPS.
#
# Phase A (online — v3 keeps serving):
#   ./vps-migrate-tenant.sh ~/pm2-apps/strapi-projectes-diligencia.config.js
#     1. reads the v3 pm2 config (db, port, url, env)
#     2. generates the 7 v5 secrets ONCE and writes a NEW pm2 config
#        ~/pm2-apps/<name>-v5.config.js carrying every v3 env var (incl.
#        ZAI_API_KEY & co) + the secrets, with cwd/database pointed at v5.
#        The v3 config file is never modified (rollback stays one command).
#     3. deploys the v5 code next to v3 (../../projectes-v5): git + npm ci + build
#     4. creates <db>_v5 (utf8mb4) and grants the tenant user on it
#     5. boots v5 once on PORT+1000 (no nginx conflict) to create the schema
#        and seed permissions, then stops it
#     6. rsyncs public/uploads from the v3 instance (incl. FACe/VeriFactu .pfx)
#
# Phase B (downtime window):
#   ./vps-migrate-tenant.sh <config> --cutover
#     7. mysqldump backup of the v3 DB (belt and braces; ETL only reads it)
#     8. pm2 stop <v3 app>            (also guarantees no double VeriFactu/FACe)
#     9. re-runs the ETL (full, idempotent) + validate.js + nullcheck.js
#        — re-running INSIDE the window captures every change made since
#          phase A; nothing is lost because the ETL truncates and recopies
#    10. ports the v3 admin users (bcrypt hashes kept, Super Admin)
#    11. pm2 start <v5 config> (same PORT as v3 → nginx untouched) + pm2 save
#    12. health check + rollback hint
#
# Required environment:
#   V5_SOURCE_REPO  git checkout of projectes-v5 used to deploy code
#                   (default: /var/www/projectes-v5-src)
#   MYSQL_ADMIN     mysql command with CREATE DATABASE/GRANT rights
#                   (default: "mysql" — configure ~/.my.cnf or pass explicitly)
# Node 20+ must be on PATH (the v5 npm scripts enforce it).
#
# Rollback (during the 1-week hot period):
#   pm2 stop strapi-projectes-<t>-v5 && pm2 start ~/pm2-apps/strapi-projectes-<t>.config.js
#   (the v3 database was never modified)

set -Eeuo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
CONFIG_FILE="${1:?usage: vps-migrate-tenant.sh <v3-pm2-config.js> [--cutover]}"
CUTOVER="${2:-}"
V5_SOURCE_REPO="${V5_SOURCE_REPO:-/var/www/projectes-v5-src}"
MYSQL_ADMIN="${MYSQL_ADMIN:-mysql}"
# MYSQL_ADMIN is a mysql CLIENT — it is used with -e for CREATE DATABASE/GRANT,
# so it cannot double as the dumper. Piping `mysql --single-transaction <db>`
# into gzip produced a 20-byte file containing no SQL at all: the backup that
# the cutover leans on did not exist.
MYSQLDUMP="${MYSQLDUMP:-mysqldump}"

[ -f "$CONFIG_FILE" ] || { echo "config not found: $CONFIG_FILE"; exit 1; }

# ── Read the v3 pm2 config with node (it's a JS module) ─────────────────────
read_cfg() {
  node -e "
    const cfg = require('$CONFIG_FILE');
    const app = cfg.apps[0];
    const env = app.env || {};
    console.log(JSON.stringify({
      name: app.name, cwd: app.cwd,
      port: env.PORT, url: env.URL,
      db: env.DATABASE_NAME, dbUser: env.DATABASE_USERNAME, dbPass: env.DATABASE_PASSWORD,
      env
    }));
  "
}
JSON_CFG="$(read_cfg)"
val() { echo "$JSON_CFG" | node -e "const c=JSON.parse(require('fs').readFileSync(0));console.log(c.$1 // '')" 2>/dev/null; }
V3_NAME="$(node -e "console.log(JSON.parse(process.argv[1]).name)" "$JSON_CFG")"
V3_CWD="$(node -e "console.log(JSON.parse(process.argv[1]).cwd)" "$JSON_CFG")"
PORT="$(node -e "console.log(JSON.parse(process.argv[1]).port)" "$JSON_CFG")"
V3_DB="$(node -e "console.log(JSON.parse(process.argv[1]).db)" "$JSON_CFG")"
DB_USER="$(node -e "console.log(JSON.parse(process.argv[1]).dbUser)" "$JSON_CFG")"
DB_PASS="$(node -e "console.log(JSON.parse(process.argv[1]).dbPass)" "$JSON_CFG")"
V5_NAME="${V3_NAME}-v5"
V5_DB="${V3_DB}_v5"
V5_DIR="$(dirname "$V3_CWD")/projectes-v5"
V5_CONFIG_FILE="$(dirname "$CONFIG_FILE")/$(basename "$CONFIG_FILE" .config.js)-v5.config.js"
TMP_PORT=$((PORT + 1000))

echo "tenant      : $V3_NAME"
echo "v3 dir/db   : $V3_CWD / $V3_DB"
echo "v5 dir/db   : $V5_DIR / $V5_DB  (pm2: $V5_NAME, port $PORT)"
echo ""

node -v >/dev/null 2>&1 || true
NODE_MAJOR="$(node -p "process.versions.node.split('.')[0]")"
[ "$NODE_MAJOR" -ge 20 ] || { echo "Node 20+ required (found $(node -v)). nvm use 20 first."; exit 1; }

# Everything this script reads from the tenant's database uses the tenant's own
# credentials, straight out of its pm2 config. MYSQL_ADMIN is needed for ONE
# statement (CREATE DATABASE + GRANT, in prepare) and nothing else — the
# cutover needs no admin rights at all.
tenant_mysql() { MYSQL_PWD="$DB_PASS" mysql -h 127.0.0.1 -u "$DB_USER" "$@"; }

# Connectivity first, so an auth failure does not masquerade as a schema
# mismatch — a bare `mysql` connects as the OS user with no password, and the
# resulting 1045 used to be reported as "not a projectes v3 database".
tenant_mysql -N -e "SELECT 1" >/dev/null 2>&1 \
  || { echo "cannot connect to MySQL as '$DB_USER' with the password from $CONFIG_FILE — aborting."; exit 1; }

# Sanity: the tenant must be a projectes v3 schema before we touch it.
tenant_mysql -N -e "SELECT 1 FROM \`$V3_DB\`.projects, \`$V3_DB\`.orders, \`$V3_DB\`.\`users-permissions_user\` LIMIT 1" >/dev/null 2>&1 \
  || { echo "$V3_DB does not look like a projectes v3 database (projects/orders/users tables) — aborting."; exit 1; }

# ── Phase A ──────────────────────────────────────────────────────────────────
if [ "$CUTOVER" != "--cutover" ]; then
  # A2. v5 pm2 config.
  #
  # Rewritten on every run, but the SECRETS are generated once and then carried
  # forward. Re-running prepare must not mint a new SECRETS_KEY: anything
  # already encrypted with the old one becomes unreadable. Everything else —
  # name, cwd, interpreter, PATH, database — is refreshed, because "the file
  # exists so leave it alone" meant a config written by an older version of this
  # script never picked up later fixes. That is how a config ended up without
  # an interpreter after the interpreter pinning was added.
  echo "==> writing v5 pm2 config: $V5_CONFIG_FILE"
  node -e '
    const fs = require("fs");
    const cfg = require(process.argv[1]);
    const app = cfg.apps[0];
    const b64 = (n) => require("crypto").randomBytes(n).toString("base64");

    // Carry secrets over from a previous run if there is one.
    let previous = {};
    try {
      previous = require(process.argv[5]).apps[0].env || {};
    } catch (e) {
      previous = {};
    }
    const keep = (key, make) => (previous[key] !== undefined ? previous[key] : make());
    const kept = Object.keys(previous).length > 0;

    app.name = process.argv[2];
    app.cwd = process.argv[3];

    // pm2 runs an app with the node its DAEMON was started under, and that
    // daemon has to stay on Node 16 while v3 tenants are still served — Strapi
    // 3 does not run on 20. So the v5 app must name its own interpreter, or
    // pm2 boots it under 16, package.json engines rejects it and the app dies.
    // That happens at step 11, with v3 already stopped.
    //
    // process.execPath is Node >= 20 here: the preflight above refuses to run
    // otherwise. PATH is prefixed with the same bin directory so anything the
    // app shells out to (npm, strapi) resolves the same node.
    const nodeBin = process.execPath;
    const nodeDir = require("path").dirname(nodeBin);
    app.interpreter = nodeBin;

    app.env = {
      ...app.env,
      PATH: nodeDir + ":" + (app.env.PATH || process.env.PATH || "/usr/local/bin:/usr/bin:/bin"),
      DATABASE_NAME: process.argv[4],
      DATABASE_POOL_MIN: "0",
      DATABASE_POOL_MAX: "8", // 16 instances x 8 = 128 < max_connections 151
      APP_KEYS: keep("APP_KEYS", () => [b64(16), b64(16), b64(16)].join(",")),
      API_TOKEN_SALT: keep("API_TOKEN_SALT", () => b64(16)),
      ADMIN_JWT_SECRET: keep("ADMIN_JWT_SECRET", () => b64(16)),
      TRANSFER_TOKEN_SALT: keep("TRANSFER_TOKEN_SALT", () => b64(16)),
      JWT_SECRET: keep("JWT_SECRET", () => b64(16)),
      ENCRYPTION_KEY: keep("ENCRYPTION_KEY", () => b64(32)),
      // Encrypts the certificate passphrases and integration API keys at rest
      // (src/services/secret-crypto.js). Generated ONCE: change it later and
      // every stored secret becomes unreadable.
      SECRETS_KEY: keep("SECRETS_KEY", () => require("crypto").randomBytes(32).toString("hex")),
    };

    fs.writeFileSync(process.argv[5],
      "// generated by vps-migrate-tenant.sh — v3 config left untouched\n" +
      "module.exports = " + JSON.stringify(cfg, null, 2) + ";\n");
    console.log(kept ? "    secrets carried over from the existing config" : "    fresh secrets generated");
  ' "$CONFIG_FILE" "$V5_NAME" "$V5_DIR" "$V5_DB" "$V5_CONFIG_FILE"
  chmod 600 "$V5_CONFIG_FILE"

  # A3. deploy code
  echo "==> deploying v5 code to $V5_DIR"
  if [ ! -d "$V5_DIR/.git" ]; then
    git clone -q "$V5_SOURCE_REPO" "$V5_DIR"
  else
    git -C "$V5_DIR" fetch -q origin && git -C "$V5_DIR" reset -q --hard origin/HEAD
  fi
  (cd "$V5_DIR" && npm ci --no-audit --no-fund && npm run build)

  # .env mirrors the v5 pm2 env in full.
  #
  # Two things read it: the ETL/maintenance scripts (which need the connection
  # block and SECRETS_KEY), and the one-time schema boot below — that runs
  # `npm run start`, which is a normal Strapi boot and refuses to start without
  # APP_KEYS ("App keys are required", @strapi/core session middleware). A
  # connection-only .env got as far as the boot and then failed there.
  #
  # Writing the whole env also keeps .env and the pm2 config from drifting.
  # Same secrets, same machine, same 0600 mode as the config itself.
  node -e '
    const fs = require("fs");
    const env = require(process.argv[1]).apps[0].env || {};
    const lines = Object.keys(env)
      .filter((k) => env[k] !== undefined && env[k] !== null)
      .map((k) => k + "=" + String(env[k]));
    fs.writeFileSync(process.argv[2] + "/.env", lines.join("\n") + "\n");
  ' "$V5_CONFIG_FILE" "$V5_DIR"
  chmod 600 "$V5_DIR/.env"

  # A4. database
  echo "==> creating $V5_DB"
  # The only step that needs more than the tenant's own credentials.
  admin_fail() {
    echo ""
    echo "MYSQL_ADMIN ('$MYSQL_ADMIN') cannot $1."
    echo "Re-run with a client that can, e.g. a dedicated option file:"
    echo "  printf '[client]\\nuser=admin\\npassword=...\\n' > ~/.my-admin.cnf && chmod 600 ~/.my-admin.cnf"
    echo "  MYSQL_ADMIN=\"mysql --defaults-extra-file=\$HOME/.my-admin.cnf\" $0 $CONFIG_FILE"
    echo ""
    echo "Do NOT put those credentials in ~/.my.cnf [client]: it applies to every"
    echo "mysql invocation here, and an option-file password overrides MYSQL_PWD,"
    echo "which would break the tenant reads this script depends on."
    echo "Nothing has been changed."
    exit 1
  }

  $MYSQL_ADMIN -e "CREATE DATABASE IF NOT EXISTS \`$V5_DB\` CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;" \
    || admin_fail "CREATE DATABASE"

  # Grant to the host(s) the tenant account actually exists under. Granting to a
  # hard-coded '127.0.0.1' fails on MySQL 8 when the account is defined as
  # @'localhost' — GRANT will not create an account that does not exist.
  GRANT_HOSTS="$($MYSQL_ADMIN -N -B -e "SELECT host FROM mysql.user WHERE user = '$DB_USER'" 2>/dev/null)" \
    || admin_fail "read mysql.user"
  [ -n "$GRANT_HOSTS" ] || { echo "no MySQL account found for user '$DB_USER' — aborting."; exit 1; }
  for h in $GRANT_HOSTS; do
    echo "    granting on $V5_DB to '$DB_USER'@'$h'"
    $MYSQL_ADMIN -e "GRANT ALL PRIVILEGES ON \`$V5_DB\`.* TO '$DB_USER'@'$h';" || admin_fail "GRANT"
  done
  $MYSQL_ADMIN -e "FLUSH PRIVILEGES;" || admin_fail "FLUSH PRIVILEGES"

  # A5. schema + permission seeds (temp port, then stop)
  echo "==> one-time schema boot on port $TMP_PORT"
  (cd "$V5_DIR" && PORT=$TMP_PORT DATABASE_NAME="$V5_DB" nohup npm run start > /tmp/v5-boot-$V3_DB.log 2>&1 &)
  for i in $(seq 1 60); do
    sleep 5
    grep -q "started successfully" /tmp/v5-boot-$V3_DB.log 2>/dev/null && break
  done
  grep -q "started successfully" /tmp/v5-boot-$V3_DB.log || { echo "schema boot failed:"; tail -20 /tmp/v5-boot-$V3_DB.log; exit 1; }
  # Scoped to this tenant's directory: `pkill -f "strapi start"` matched every
  # other tenant's process on the VPS and would have restarted them all.
  pkill -f "$V5_DIR/node_modules/.bin/strapi start" || true; sleep 2

  # A6. uploads (certificates included)
  echo "==> rsyncing uploads"
  rsync -a "$V3_CWD/public/uploads/" "$V5_DIR/public/uploads/"

  echo ""
  echo "✓ prepare complete. Cutover when ready with:"
  echo "  $0 $CONFIG_FILE --cutover"
  exit 0
fi

# ── Phase B: cutover ─────────────────────────────────────────────────────────
[ -d "$V5_DIR" ] || { echo "run the prepare phase first"; exit 1; }
[ -f "$V5_CONFIG_FILE" ] || { echo "missing $V5_CONFIG_FILE — run prepare first"; exit 1; }

echo "==> 7. backup v3 db"
mkdir -p ~/backups-v3
BACKUP_FILE=~/backups-v3/"$V3_DB"-$(date +%Y%m%d-%H%M).sql.gz
MYSQL_PWD="$DB_PASS" $MYSQLDUMP -h 127.0.0.1 -u "$DB_USER" \
  --single-transaction --no-tablespaces "$V3_DB" | gzip > "$BACKUP_FILE"
# An empty dump passes through gzip without complaint, so check before trusting
# it. Read the whole stream: `gunzip -c ... | head -c N` closes the pipe early,
# gunzip takes SIGPIPE, and with `set -o pipefail` that killed this script with
# status 141 before it printed anything — a valid backup looking like a failure.
gzip -t "$BACKUP_FILE" 2>/dev/null \
  || { echo "backup is not readable gzip: $BACKUP_FILE — aborting before stopping v3"; exit 1; }
BACKUP_BYTES=$(gunzip -c "$BACKUP_FILE" | wc -c)
[ "$BACKUP_BYTES" -gt 1024 ] \
  || { echo "backup is empty ($BACKUP_BYTES bytes of SQL): $BACKUP_FILE — aborting before stopping v3"; exit 1; }
echo "    backup: $BACKUP_FILE ($(du -h "$BACKUP_FILE" | cut -f1))"

# From here until v5 is confirmed up, any failure leaves the tenant with
# nothing serving — validate.js exits non-zero on a mismatch, and `set -e`
# would simply stop, mid-window, with v3 down and v5 not started. The v3
# database is only ever read, so restarting v3 is always safe.
rollback_v3() {
  echo ""
  echo "!! cutover failed — restarting v3 so the tenant is not left down"
  pm2 start "$CONFIG_FILE" >/dev/null 2>&1 || pm2 restart "$V3_NAME" >/dev/null 2>&1 || true
  pm2 save >/dev/null 2>&1 || true
  echo "   $V3_NAME is serving again on port $PORT."
  echo "   $V5_DB was left as it is — inspect, fix, then re-run the cutover."
}
trap rollback_v3 ERR

echo "==> 8. stopping v3 ($V3_NAME)"
pm2 stop "$V3_NAME"

echo "==> 9. ETL (fresh full copy) + validation"
(cd "$V5_DIR" && node tools/etl/migrate.js --from "$V3_DB" --to "$V5_DB")
(cd "$V5_DIR" && node tools/etl/validate.js --from "$V3_DB" --to "$V5_DB")
(cd "$V5_DIR" && node tools/etl/nullcheck.js --from "$V3_DB" --to "$V5_DB")

# Admin accounts are migrated by the ETL above (tools/etl/migrate.js, the
# strapi_administrator step). This used to re-insert them here, which doubled
# every account — admin_users has no unique index on email — and linked all of
# them to role 1, turning every Editor into a Super Admin. The ETL maps roles
# by code instead, so Editors stay Editors.

echo "==> 10. refreshing uploads (anything added since prepare)"
rsync -a "$V3_CWD/public/uploads/" "$V5_DIR/public/uploads/"

echo "==> 10b. encrypting secrets at rest"
# The ETL copies v3's plaintext certificate passphrases and API keys. The app
# reads either form, so this is not required for it to work — but until it runs
# they sit readable in every dump of the new database.
(cd "$V5_DIR" && node scripts/encrypt-secrets.js)

echo "==> 11. starting v5 ($V5_NAME on port $PORT — nginx untouched)"
pm2 start "$V5_CONFIG_FILE" && pm2 save

echo "==> 12. health check"
# Strapi 5 takes appreciably longer than 10s to accept connections — the
# prepare boot above allows five minutes for the same thing. A single curl
# after a fixed sleep reported HTTP 000 (curl could not connect) on an app that
# was merely still starting, which reads as a failed cutover. Poll instead.
STATUS="000"
for i in $(seq 1 60); do
  STATUS="$(curl -s -o /dev/null -m 5 -w '%{http_code}' "http://127.0.0.1:$PORT/api/logos?_limit=1" || true)"
  case "$STATUS" in 200|403) break ;; esac
  # A crash loop is worth failing fast on: pm2 keeps restarting it, so uptime
  # never grows and there is nothing to wait for.
  if ! pm2 pid "$V5_NAME" >/dev/null 2>&1; then break; fi
  sleep 5
done
pm2 ls | grep -E "$V3_NAME|$V5_NAME" || true
if [ "$STATUS" = "200" ] || [ "$STATUS" = "403" ]; then
  trap - ERR   # v5 is up; stop guarding
  echo "✓ v5 answering (HTTP $STATUS). Rollback if needed:"
  echo "  pm2 stop $V5_NAME && pm2 start $CONFIG_FILE && pm2 save"
else
  trap - ERR
  echo "!! unexpected health status: $STATUS — check: pm2 logs $V5_NAME"
  echo "   v5 is running but not answering; v3 is still stopped. Decide:"
  echo "     investigate : pm2 logs $V5_NAME"
  echo "     roll back   : pm2 stop $V5_NAME && pm2 start $CONFIG_FILE && pm2 save"
  exit 1
fi
