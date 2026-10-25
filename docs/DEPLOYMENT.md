# Deployment (VPS, multi-tenant)

How the fleet is laid out and how to ship to it. The warnings are incidents that
actually happened, not hypotheticals.

Until 2026-10-09 the backend ran from per-tenant git checkouts under pm2 and was
released by rsync. That setup is gone: the backend is now one Docker image,
deployed by CI. The tenant directories no longer hold backend code, so there is
nothing to rsync into and no pm2 app to fall back to.

---

## 1. Topology

| Thing | Where |
| ----- | ----- |
| Host | `<user>@<vps-host>` (address and login are kept out of this repo) |
| Backend, all tenants | `/var/www/esstrapis-back` — one image, a blue and a green slot per tenant behind a Caddy proxy |
| Backend settings, per tenant | `/var/www/esstrapis-back/envs/<tenant>.env` |
| Uploads, per tenant | `/var/www/<tenant-dir>/uploads` |
| Database, per tenant | `<name>_v5` on the shared local MySQL |
| Frontend, per tenant | one docker container per tenant, all from **one shared image** |
| Frontend compose, per tenant | `/var/www/<tenant-dir>/docker/docker-compose.yml` |
| Frontend deploy scripts | `/var/www/esstrapis-front` |
| nginx vhost, per tenant | `/etc/nginx/sites-available/<host>` (symlinked from `sites-enabled`) |

Tenant directory names are not uniform — some carry a `projectes-` prefix, some
are a bare name, some are a full hostname. Never assume `projectes-<tenant>`; the
backend's `tenants.conf` and the frontend's `sites.conf` list the real ones.

The **orders module is used by a single tenant** (the "orders tenant" below).
Other tenants do not expose it.

---

## 2. Backend deploy

A push to `main` runs the tests, builds `esstrapis-back:v5-<sha>` and deploys it
to every tenant (`.github/workflows/v5.yml`). Pushes that only touch `deploy/`,
`docs/` or Markdown files don't build or deploy.

The deploy is zero-downtime: canary first, then the rest two at a time, with an
automatic rollback of the whole run if a tenant doesn't become healthy. How it
works, how to add a tenant and what lives where on the server are in
[`deploy/docker/README.md`](../deploy/docker/README.md).

To ship to some tenants only, or to roll back, run the same script on the VPS:

```bash
cd /var/www/esstrapis-back
./deploy.sh v5-<sha>                 # every tenant (what CI runs)
./deploy.sh v5-<sha> <tenant> ...    # only some
./deploy.sh v5-<earlier sha>         # roll back, zero downtime
```

Every `main` commit has its image, and `deploy.log` lists what was deployed when.

---

## 3. Frontend deploy

A push to `main` of `projectes-front` runs its tests, builds
`esstrapis-front:v5-vue3-<sha>` and deploys it to every site
(`.github/workflows/main.yml` there). Details are in that repository's
`deploy/docker/README.md`. The script takes the same arguments as the backend one:

```bash
cd /var/www/esstrapis-front
./deploy.sh v5-vue3-<sha>                # every site (what CI runs)
./deploy.sh v5-vue3-<sha> <site> ...     # only some
./deploy.sh v5-vue3-<earlier sha>        # roll back
```

Each site's container is recreated, so it stops answering for a second or two.

### Never pass `--remove-orphans`

All tenants share one compose **project name**, so each tenant's compose file sees
the other containers as orphans. `--remove-orphans` would delete them. The
"Found orphan containers" warning on every run is expected and harmless.

### Verify from outside

```bash
curl -s https://<host>/ | grep -oE 'js/app\.[a-f0-9]+\.js'
```

The bundle hash changes with every build, so it tells you which one a site serves.

---

## 4. Ordering: backend before frontend

The two repositories deploy independently. If a release adds a **backend endpoint
the frontend calls**, push the backend and let its deploy finish *before* pushing
the frontend. Otherwise a tenant briefly serves a frontend calling a route its
backend does not have.

---

## 5. Environment traps on the VPS

- **A non-interactive SSH shell gets Node 12.** The backend runs in its image and
  is not affected, but any Node script run on the host must source nvm first:
  ```bash
  export NVM_DIR="$HOME/.nvm"; . "$NVM_DIR/nvm.sh"; nvm use 22
  ```
- **nginx runs HTTP/2**, enabled per vhost with `listen 443 ssl http2;` (the
  `http2 on;` directive needs nginx ≥ 1.25.1, newer than what is installed).
- `at` is not installed. For scheduled work use the user crontab (no sudo needed).
- Server timezone is **Europe/Berlin**.

---

## 6. Scheduling unattended work

cron has no "run once", so the script must make itself one-shot — an `EXIT` trap
that removes its own crontab line (so a killed run cannot silently repeat) plus a
`.done` marker file:

```bash
drop_cron() { crontab -l 2>/dev/null | grep -v 'my-script.sh' | crontab - ; }
trap drop_cron EXIT
```

End the script with a single greppable `RESULT: OK` / `RESULT: ATTENTION` line.

---

## 7. Backups

Taken during the v3 → v5 cutover and the fixes that followed:

| Path | What |
| ---- | ---- |
| `~/backups-v3/` | per-tenant v3 SQL dump, taken at cutover |
| `~/backups-v5-order/` | `files_related_mph` before the `order` backfill |
| `~/backups-v5-merge/` | `orders` + link table before the collection-order merge |
| `/root/nginx-backup-*.tar.gz` | `sites-available` before enabling HTTP/2 |

Nightly backups live in `~/backups` (kept 7 days) and `~/backups-external`.
Disk is the binding constraint: the box ran out mid-rollout once.
