#!/usr/bin/env bash
#
# vps-migrate-all.sh — sequential tenant-by-tenant rollout wrapper around
# vps-migrate-tenant.sh, with a per-tenant confirmation prompt.
#
#   ./vps-migrate-all.sh                       # interactive, per-tenant menu
#   ./vps-migrate-all.sh --auto prepare        # batch: prepare every tenant
#   ./vps-migrate-all.sh --auto cutover        # batch: cutover every tenant
#   ./vps-migrate-all.sh --only arada,diligencia           # restrict tenants
#   ./vps-migrate-all.sh --auto cutover --only arada       # combine
#
# Tenant order: the low-risk ones first (empty template, tiny, heavy) so the
# runbook proves itself before general rollout; the rest alphabetically.
# The generated *-v5.config.js files and non-projectes apps are excluded.
#
# NOTE: cutover also needs that tenant's PARENT frontend redeployed with the
# P9 build — the script reminds you per tenant; the deploy itself is manual.

set -uo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
TENANT_SCRIPT="$SCRIPT_DIR/vps-migrate-tenant.sh"
PM2_APPS_DIR="${PM2_APPS_DIR:-$HOME/pm2-apps}"

AUTO=""
ONLY=""
while [ $# -gt 0 ]; do
  case "$1" in
    --auto) AUTO="${2:?--auto needs prepare|cutover}"; shift 2 ;;
    --only) ONLY="${2:?--only needs a comma list}"; shift 2 ;;
    *) echo "unknown option: $1"; exit 1 ;;
  esac
done

[ -x "$TENANT_SCRIPT" ] || { echo "missing $TENANT_SCRIPT"; exit 1; }
[ -d "$PM2_APPS_DIR" ] || { echo "pm2-apps dir not found: $PM2_APPS_DIR"; exit 1; }

# Ordered rollout: prove the pipeline on the empty template, the tiny tenant
# and the heavy one before touching the rest.
PRIORITY="buida arada diligencia"

configs() {
  local all=()
  for f in "$PM2_APPS_DIR"/strapi-projectes-*.config.js; do
    [ -e "$f" ] || continue
    case "$f" in *-v5.config.js) continue ;; esac   # generated, skip
    all+=("$(basename "$f" .config.js | sed 's/^strapi-projectes-//')")
  done
  # priority tenants first (only those present), rest alphabetically
  local ordered=() t
  for t in $PRIORITY; do
    for a in "${all[@]}"; do [ "$a" = "$t" ] && ordered+=("$t"); done
  done
  for a in $(printf '%s\n' "${all[@]}" | sort); do
    local skip=0
    for t in $ordered; do [ "$a" = "$t" ] && skip=1; done
    [ $skip -eq 0 ] && ordered+=("$a")
  done
  printf '%s\n' "${ordered[@]}"
}

in_only() {
  [ -z "$ONLY" ] && return 0
  case ",$ONLY," in *",$1,"*) return 0 ;; *) return 1 ;; esac
}

declare -a DONE=() FAILED=() SKIPPED=()

for tenant in $(configs); do
  cfg="$PM2_APPS_DIR/strapi-projectes-$tenant.config.js"
  in_only "$tenant" || continue

  action="$AUTO"
  if [ -z "$action" ]; then
    echo ""
    echo "──────── $tenant ($cfg)"
    echo -n "  [p]repare / [c]utover / [s]kip / [q]uit ? "
    IFS= read -r answer </dev/tty || answer="q"
    case "$answer" in
      p|P) action="prepare" ;;
      c|C) action="cutover" ;;
      s|S) action="skip" ;;
      *)   echo "stopping."; break ;;
    esac
  fi

  if [ "$action" = "skip" ]; then
    SKIPPED+=("$tenant"); continue
  fi

  echo "==> $tenant: $action"
  if [ "$action" = "cutover" ]; then
    echo "    reminder: deploy this tenant's P9 frontend build together with this step."
  fi

  if "$TENANT_SCRIPT" "$cfg" ${action:+--cutover}; then
    DONE+=("$tenant:$action")
  else
    FAILED+=("$tenant:$action")
    echo "!! $tenant $action FAILED — fix before continuing (previous tenants unaffected)."
    if [ -z "$AUTO" ]; then
      echo -n "  continue with the rest? [y/N] "
      IFS= read -r cont </dev/tty || cont="n"
      [ "$cont" = "y" ] || break
    fi
  fi
done

echo ""
echo "──── summary ────"
[ ${#DONE[@]}    -gt 0 ] && printf '  done:    %s\n' "${DONE[*]}"
[ ${#SKIPPED[@]} -gt 0 ] && printf '  skipped: %s\n' "${SKIPPED[*]}"
[ ${#FAILED[@]} -gt 0 ] && printf '  FAILED:  %s\n' "${FAILED[*]}"
[ ${#FAILED[@]} -eq 0 ] && echo "  ✓ no failures"
[ ${#FAILED[@]} -gt 0 ] && exit 1
exit 0
