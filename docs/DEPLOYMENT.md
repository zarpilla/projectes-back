# Deployment (VPS, multi-tenant)

How the fleet is laid out and how to ship to it. Everything here was exercised
during the v3 → v5 cutover and the days of fixes that followed; the warnings are
incidents that actually happened, not hypotheticals.

---

## 1. Topology

| Thing | Where |
| ----- | ----- |
| Host | `webcoop@89.117.62.105` (Contabo, Ubuntu) |
| Backend code, per tenant | `/var/www/<tenant-dir>/projectes-v5` (a git clone) |
| Backend process, per tenant | pm2 app `strapi-projectes-<tenant>-v5` |
| pm2 config, per tenant | `~/pm2-apps/strapi-projectes-<tenant>-v5.config.js` |
| Database, per tenant | `<name>_v5` on the shared local MySQL |
| Frontend, per tenant | one docker container per tenant, all from **one shared image** |
| Frontend compose, per tenant | `/var/www/<tenant-dir>/docker/docker-compose.yml` |
| nginx vhost, per tenant | `/etc/nginx/sites-available/<host>` (symlinked from `sites-enabled`) |
| Deploy scripts | `~/v5-migration-tools/` |
| Staged source tree | `~/v5-migration-tools/src-staging/` |

**16 live tenants.** `milvietnams` was retired (pm2 apps deleted, configs renamed
`.disabled`, databases and files kept). Tenant directory names are not uniform —
`projectes-arada`, `diligencia`, `demo.projectes`, `projectes.webcoop.cat`. Never
assume `projectes-<tenant>`; read `cwd` out of the pm2 config:

```bash
node -e 'console.log(require(require("path").resolve(process.argv[1])).apps[0].cwd)' "$cfg"
```

The **orders module is used by diligencia only**. Other tenants do not expose it,
so orders-specific work is routinely deployed to diligencia alone.

---

## 2. Environment traps on the VPS

- **A non-interactive SSH shell gets Node 12.** Every script must source nvm
  first, or Strapi 5 refuses to boot:
  ```bash
  export NVM_DIR="$HOME/.nvm"; . "$NVM_DIR/nvm.sh"; nvm use 20
  ```
- **`/var/www/projectes-v5-src` is root-owned.** Git operations there need
  `sudo`; without it you get *"detected dubious ownership"*.
- **Migration scripts need `MYSQL_ADMIN`**, or `CREATE DATABASE` is denied:
  ```bash
  export MYSQL_ADMIN="mysql --defaults-extra-file=$HOME/.my-admin.cnf"
  ```
- **nginx runs HTTP/2** (enabled on 30 vhosts; nginx 1.18 → `listen 443 ssl http2;`,
  the `http2 on;` directive needs ≥ 1.25.1).
- `at` is not installed. For scheduled work use the user crontab (no sudo needed).

---

## 3. Backend deploy

The tenant checkouts are git clones, but in practice releases are **rsynced**
from a staged tree:

```bash
# from the dev machine, with a clean working tree at the commit you want
rsync -a src/ webcoop@89.117.62.105:~/v5-migration-tools/src-staging/
```

then, per tenant: rsync into `$cwd/src/`, `pm2 restart`, wait for health.
`~/v5-migration-tools/` holds several single-purpose variants of this loop; they
all follow the same shape and differ only in the marker they grep for.

### Verify what landed, not that rsync exited 0

Every rollout script greps the deployed file for a distinctive marker of the
commit (`grep -c "populate: { contact: true, route: true, delivery_type: true }"`).
This caught a real problem: a rollout reads from the staging directory *while it
runs*, so if you re-stage mid-run, early tenants get the old tree and later ones
the new. Re-run the whole pass rather than tracking which tenant caught which
version.

### pm2: restart from the config FILE

```bash
pm2 restart ~/pm2-apps/strapi-projectes-<t>-v5.config.js   # good
pm2 restart strapi-projectes-<t>-v5 --update-env           # NEVER
```

`pm2 restart <name> --update-env` broke every tenant it touched. Two faults, both
in pm2's `lib/API.js`:

1. `restart` only reads a config file when the argument *is* a config file
   (`Common.isConfigFile`); given a name it calls `_operate`, which never opens
   the file — so an edit to `env` is not applied at all.
2. `_operate` with `updateEnv` does `Object.assign({}, process.env)`, replacing
   the app environment with the **calling shell's**. That wiped the Node-20 `PATH`
   prefix the tenant configs set, `npm start` resolved Node 16, and Strapi 5
   refused to boot (`Invalid regular expression flags` in node-ical).

A plain `pm2 restart <name>` (no `--update-env`) is safe — it keeps the stored
environment — and is what the rollout scripts use when only code changed. After
`pm2 delete` + `pm2 start <file>`, run `pm2 save`.

---

## 4. Frontend deploy

One image (`webcoop/esstrapis-front:v5`) serves **all** tenants. CI builds it on
push to the `v5` branch of `projectes-front`.

```
push to v5  →  GitHub Actions builds and pushes :v5  →  docker pull  →  recreate containers
```

```bash
docker pull webcoop/esstrapis-front:v5
cd /var/www/<tenant>/docker && docker compose up -d --force-recreate
```

### Never pass `--remove-orphans`

All tenants share one compose **project name**, so each tenant's compose file sees
the other 15 containers as orphans. `--remove-orphans` would delete them. The
"Found orphan containers" warning on every run is expected and harmless.

Each tenant's compose file declares exactly one service, so `--force-recreate`
touches only that tenant.

### The tag is shared; the deploy is not

Recreating one tenant moves only that container, but the **`:v5` tag has already
moved for everyone**. Tenants not recreated keep running the old image until
something restarts them, at which point they silently jump forward. Either
recreate all 16 to keep the fleet uniform, or accept and track the drift.

Verify by **image id**, not by tag:

```bash
docker inspect <container> --format '{{.Image}}'   # compare to the :v5 id
```

…and from outside, by bundle hash:

```bash
curl -s https://<host>/stats/ | grep -oE 'js/app\.[a-f0-9]+\.js'
```

### Pushing the frontend

`projectes-front`'s `origin` is HTTPS with no stored credentials. Push over SSH
without changing the remote:

```bash
git push git@github.com:zarpilla/projectes-front.git v5
```

---

## 5. Ordering: backend before frontend

If a release adds a **backend endpoint the frontend calls**, deploy the backend to
every tenant that will get the new frontend *first*. Otherwise a tenant briefly
serves a frontend calling a route its backend does not have.

This is why `/api/city-routes/basic` went to all 16 backends before any frontend
was recreated (`CityRoute` and `ContactsTable` are used by every tenant), while
`/api/contacts/for-orders` went to diligencia only (orders module).

---

## 6. Scheduling an unattended deploy

`at` is not installed; use the user crontab. cron has no "run once", so the
script must make itself one-shot — an `EXIT` trap that removes its own crontab
line (so a killed run cannot silently repeat) plus a `.done` marker file:

```bash
drop_cron() { crontab -l 2>/dev/null | grep -v 'my-script.sh' | crontab - ; }
trap drop_cron EXIT
```

`~/v5-migration-tools/deploy-all-night.sh` is a worked example: backend to all
tenants, then frontend, then a public check, ending in a single greppable
`RESULT: OK` / `RESULT: ATTENTION` line. Server timezone is **Europe/Berlin**.

---

## 7. Rollback

Per tenant, printed by the cutover script:

```bash
pm2 stop strapi-projectes-<t>-v5 && pm2 start ~/pm2-apps/strapi-projectes-<t>.config.js && pm2 save
cp /var/www/<t>/docker/docker-compose.yml.pre-v5 /var/www/<t>/docker/docker-compose.yml
(cd /var/www/<t>/docker && docker compose up -d --force-recreate)
```

**Caveat:** `buida`, `demo` and `webcoop` no longer have v3 `node_modules` (removed
to free disk), so rolling those back needs `npm install` in the v3 directory
first. The v3 code, databases and uploads are intact for every tenant.

The frontend `master` branch (`:latest` image) is the only remaining way to build
a v3-compatible frontend. Keep the `master` / `v5` split until you are confident;
`v5` is a strict fast-forward of `master`.

---

## 8. Backups taken during this work

| Path | What |
| ---- | ---- |
| `~/backups-v3/` | per-tenant v3 SQL dump, taken at cutover |
| `~/backups-v5-order/` | `files_related_mph` before the `order` backfill |
| `~/backups-v5-merge/` | `orders` + link table before the collection-order merge |
| `/root/nginx-backup-*.tar.gz` | `sites-available` before enabling HTTP/2 |

Nightly backups live in `~/backups` (kept 7 days) and `~/backups-external`.
Disk is the binding constraint: each tenant checkout is ~1.1 GB of
`node_modules`, and the box ran out mid-rollout once.

---

## 9. Known drift (as of 2026-09-29)

- Tenant checkouts are at an older **git** ref with newer files rsynced over them.
  Everything runs correctly, but `git status` there is misleading and a future
  `reset --hard` would silently revert the rsynced files. Reconcile with
  `sudo git -C /var/www/projectes-v5-src pull` plus a per-tenant pull.
- diligencia's backend may be ahead of the other 15 whenever orders-only work has
  been deployed to it alone.
