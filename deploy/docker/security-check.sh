#!/usr/bin/env bash
# Security state of the VPS (issues/395, 404). Reports only, unless --fix.
# Run as root from /var/www/esstrapis-back. Prints no secrets.
#
#   sudo ./security-check.sh          what is wrong
#   sudo ./security-check.sh --fix    also: envs to 600, and nginx's global snippet
set -uo pipefail
cd "$(dirname "$0")"
FIX=false; [ "${1:-}" = --fix ] && FIX=true
[ "$(id -u)" = 0 ] || { echo "Run with sudo"; exit 1; }

echo "== env files not 600"
find envs -maxdepth 1 -name '*.env' ! -perm 600 -print
$FIX && chmod 600 envs/*.env

echo "== tenants sharing a secret (count of repeated values, should be 0)"
for key in JWT_SECRET ADMIN_JWT_SECRET APP_KEYS ENCRYPTION_KEY TICKETS_SSO_KEY DOCS_SSO_KEY; do
  printf '%s: ' "$key"
  ls envs/*.env | grep -v '/_shared.env' | xargs grep -h "^$key=" | sort | uniq -d | wc -l
done

echo "== Strapi API tokens per tenant (should be none unless you made them)"
while read -r name _; do
  [[ -z "$name" || "$name" == \#* ]] && continue
  db=$(grep '^DATABASE_NAME=' "envs/$name.env" | cut -d= -f2- | tr -d "'\"")
  printf '%s: ' "$name"
  mysql -N -B "$db" -e "SELECT COALESCE(GROUP_CONCAT(name), '-') FROM strapi_api_tokens" 2>&1
done < tenants.conf

echo "== active files under uploads (HTML, XML, scripts; served as downloads since issues/395)"
while read -r name _ uploads; do
  [[ -z "$name" || "$name" == \#* ]] && continue
  find "$uploads" -type f \( -iname '*.html' -o -iname '*.htm' -o -iname '*.xhtml' -o -iname '*.xml' -o -iname '*.js' -o -iname '*.mjs' \) -print
done < tenants.conf

echo "== nginx"
SNIPPET=/etc/nginx/conf.d/esstrapis-security.conf
if [ -f "$SNIPPET" ]; then echo "$SNIPPET in place"
elif $FIX; then
  {
    echo '# Browsers stay on HTTPS, and no nginx version in answers (issues/404). Inherited'
    echo '# by the sites that set no add_header of their own.'
    echo 'add_header Strict-Transport-Security "max-age=31536000" always;'
    # a second server_tokens in the same block is an error
    grep -qE '^\s*server_tokens\s' /etc/nginx/nginx.conf || echo 'server_tokens off;'
  } > "$SNIPPET"
  if output=$(nginx -t 2>&1); then systemctl reload nginx; echo "added $SNIPPET, nginx reloaded"
  else rm -f "$SNIPPET"; echo "nginx -t failed, snippet removed:"; echo "$output" | grep -v '\[warn\]'; fi
else echo "$SNIPPET missing"
fi
