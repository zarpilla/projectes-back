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

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
CONFIG_FILE="${1:?usage: vps-migrate-tenant.sh <v3-pm2-config.js> [--cutover]}"
CUTOVER="${2:-}"
V5_SOURCE_REPO="${V5_SOURCE_REPO:-/var/www/projectes-v5-src}"
MYSQL_ADMIN="${MYSQL_ADMIN:-mysql}"

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

# Sanity: the tenant must be a projectes v3 schema before we touch it.
$MYSQL_ADMIN -N -e "SELECT 1 FROM \`$V3_DB\`.projects, \`$V3_DB\`.orders, \`$V3_DB\`.\`users-permissions_user\` LIMIT 1" >/dev/null \
  || { echo "$V3_DB does not look like a projectes v3 database (projects/orders/users tables) — aborting."; exit 1; }

tenant_mysql() { MYSQL_PWD="$DB_PASS" mysql -h 127.0.0.1 -u "$DB_USER" "$@"; }

# ── Phase A ──────────────────────────────────────────────────────────────────
if [ "$CUTOVER" != "--cutover" ]; then
  # A2. v5 pm2 config (generate secrets only on first creation)
  if [ ! -f "$V5_CONFIG_FILE" ]; then
    echo "==> generating v5 pm2 config with fresh secrets: $V5_CONFIG_FILE"
    node -e '
      const fs = require("fs");
      const cfg = require(process.argv[1]);
      const app = cfg.apps[0];
      const b64 = (n) => require("crypto").randomBytes(n).toString("base64");
      app.name = process.argv[2];
      app.cwd = process.argv[3];
      app.env = {
        ...app.env,
        DATABASE_NAME: process.argv[4],
        DATABASE_POOL_MIN: "0",
        DATABASE_POOL_MAX: "8", // 16 instances x 8 = 128 < max_connections 151
        APP_KEYS: [b64(16), b64(16), b64(16)].join(","),
        API_TOKEN_SALT: b64(16),
        ADMIN_JWT_SECRET: b64(16),
        TRANSFER_TOKEN_SALT: b64(16),
        JWT_SECRET: b64(16),
        ENCRYPTION_KEY: b64(32),
      };
      fs.writeFileSync(process.argv[5],
        "// generated by vps-migrate-tenant.sh — v3 config left untouched\n" +
        "module.exports = " + JSON.stringify(cfg, null, 2) + ";\n");
    ' "$CONFIG_FILE" "$V5_NAME" "$V5_DIR" "$V5_DB" "$V5_CONFIG_FILE"
    chmod 600 "$V5_CONFIG_FILE"
  else
    echo "==> reusing existing $V5_CONFIG_FILE (secrets kept)"
  fi

  # A3. deploy code
  echo "==> deploying v5 code to $V5_DIR"
  if [ ! -d "$V5_DIR/.git" ]; then
    git clone -q "$V5_SOURCE_REPO" "$V5_DIR"
  else
    git -C "$V5_DIR" fetch -q origin && git -C "$V5_DIR" reset -q --hard origin/HEAD
  fi
  (cd "$V5_DIR" && npm ci --no-audit --no-fund && npm run build)

  # ETL tooling reads .env — write the connection block (runtime uses pm2 env)
  node -e '
    const fs = require("fs");
    const env = require(process.argv[1]).apps[0].env;
    const keep = ["DATABASE_CLIENT","DATABASE_HOST","DATABASE_PORT","DATABASE_NAME","DATABASE_USERNAME","DATABASE_PASSWORD"];
    fs.writeFileSync(process.argv[2] + "/.env", keep.map((k) => k + "=" + env[k]).join("\n") + "\n");
  ' "$V5_CONFIG_FILE" "$V5_DIR"
  chmod 600 "$V5_DIR/.env"

  # A4. database
  echo "==> creating $V5_DB"
  $MYSQL_ADMIN -e "CREATE DATABASE IF NOT EXISTS \`$V5_DB\` CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;
                   GRANT ALL PRIVILEGES ON \`$V5_DB\`.* TO '$DB_USER'@'127.0.0.1'; FLUSH PRIVILEGES;"

  # A5. schema + permission seeds (temp port, then stop)
  echo "==> one-time schema boot on port $TMP_PORT"
  (cd "$V5_DIR" && PORT=$TMP_PORT DATABASE_NAME="$V5_DB" nohup npm run start > /tmp/v5-boot-$V3_DB.log 2>&1 &)
  for i in $(seq 1 60); do
    sleep 5
    grep -q "started successfully" /tmp/v5-boot-$V3_DB.log 2>/dev/null && break
  done
  grep -q "started successfully" /tmp/v5-boot-$V3_DB.log || { echo "schema boot failed:"; tail -20 /tmp/v5-boot-$V3_DB.log; exit 1; }
  pkill -f "stra[p]i start" || true; sleep 2

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
$MYSQL_ADMIN --single-transaction "$V3_DB" | gzip > ~/backups-v3/"$V3_DB"-$(date +%Y%m%d-%H%M).sql.gz

echo "==> 8. stopping v3 ($V3_NAME)"
pm2 stop "$V3_NAME"

echo "==> 9. ETL (fresh full copy) + validation"
(cd "$V5_DIR" && node tools/etl/migrate.js --from "$V3_DB" --to "$V5_DB")
(cd "$V5_DIR" && node tools/etl/validate.js --from "$V3_DB" --to "$V5_DB")
(cd "$V5_DIR" && node tools/etl/nullcheck.js --from "$V3_DB" --to "$V5_DB")

echo "==> 10. port admin users"
tenant_mysql -e "
INSERT INTO \`$V5_DB\`.admin_users
  (document_id, firstname, lastname, username, email, password, is_active, blocked, prefered_language, created_at, updated_at)
SELECT UUID(), firstname, lastname, username, email, password, isActive, IFNULL(blocked,0), preferedLanguage, NOW(), NOW()
FROM \`$V3_DB\`.strapi_administrator;
INSERT INTO \`$V5_DB\`.admin_users_roles_lnk (user_id, role_id, user_ord, role_ord)
SELECT id, 1, 1, 1 FROM \`$V5_DB\`.admin_users;"

echo "==> 11. starting v5 ($V5_NAME on port $PORT — nginx untouched)"
pm2 start "$V5_CONFIG_FILE" && pm2 save

echo "==> 12. health check"
sleep 10
STATUS="$(curl -s -o /dev/null -w '%{http_code}' "http://127.0.0.1:$PORT/api/logos?_limit=1" || true)"
pm2 ls | grep -E "$V3_NAME|$V5_NAME" || true
if [ "$STATUS" = "200" ] || [ "$STATUS" = "403" ]; then
  echo "✓ v5 answering (HTTP $STATUS). Rollback if needed:"
  echo "  pm2 stop $V5_NAME && pm2 start $CONFIG_FILE && pm2 save"
else
  echo "!! unexpected health status: $STATUS — check: pm2 logs $V5_NAME"
  echo "   rollback: pm2 stop $V5_NAME && pm2 start $CONFIG_FILE && pm2 save"
  exit 1
fi
