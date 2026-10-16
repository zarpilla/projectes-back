# Backend in Docker: one image, zero-downtime deploys

`webcoop/esstrapis-back:v5-<sha>` is built by `.github/workflows/v5.yml` on every push to `main`, and deployed to every tenant on the VPS by the same workflow.

The admin panel is built once in the image. With the admin on the same origin as the API and `URL` without a sub-path, Strapi bakes only `"/"` as the backend URL, so one build serves every domain. Keep it that way: don't set `admin.url` to another host, don't add a path to `URL`, and don't add `STRAPI_ADMIN_*` variables.

## How it runs (`/var/www/esstrapis-back`)

```
nginx (domain) ──> 127.0.0.1:<port>  Caddy ("proxy" container)
                                        └──> <tenant>-blue  127.0.0.1:<port+10000>
                                         or  <tenant>-green 127.0.0.1:<port+20000>
```

- `tenants.conf` lists each tenant: `<name> <port> <uploads dir>`. See `tenants.conf.example`.
- `envs/<tenant>.env` holds the tenant's environment: database, `URL`, secrets, SMTP, `TICKETS_SSO_KEY`. It was generated from the old PM2 config with `pm2-env-to-dotenv.js`. Its `PORT` is overridden per slot.
- `state/<tenant>` says which slot is live (`blue` or `green`).
- `render.sh` generates `docker-compose.yml` and `caddy/Caddyfile` from those files. Never edit the generated files.
- The backend services are in the `backends` profile, so `docker compose up -d` without names only starts the proxy. Always name backend services explicitly.
- Every container uses `network_mode: host`. MySQL is reached at `127.0.0.1`, and the tenant's uploads dir (`/var/www/<tenant>/uploads`) is mounted at `/opt/app/public/uploads`.
- Caddy trusts nginx's `X-Forwarded-*` headers, so Strapi still sees `https` and the client IP.

## Deploys

A push to `main` runs the tests, pushes the image, then SSHes to the VPS and runs `deploy.sh v5-<sha>`. The SSH key is restricted to that script (`command="/var/www/esstrapis-back/deploy.sh",restrict` in `authorized_keys`), and GitHub pins the host key.

For each tenant, `deploy.sh`:
1. starts the new build in the idle slot;
2. waits until it answers `/api/logos`;
3. switches Caddy to it with a graceful reload;
4. lets the old slot drain for 10 s, then stops it.

The site never stops answering. The canary `buida` goes first, then the rest two at a time. If a new slot doesn't become healthy, it is stopped (the old slot kept serving), every tenant already switched in that run goes back to its previous slot (also without downtime), and the job fails. The deployed tag is kept in `.env` (`BACK_TAG`). The log is in `deploy.log`.

Cron jobs take a MySQL lock per tenant database (`src/services/cron-lock.js`), so the few seconds where old and new slots overlap never run a job twice.

```bash
./deploy.sh v5-<sha>                   # every tenant (what CI runs)
./deploy.sh v5-<sha> demo diligencia   # only some (doesn't change BACK_TAG)
./deploy.sh v5-<previous sha>          # roll everything back
docker compose logs -f demo-$(cat state/demo)
```

The scripts on the server are copies of `deploy/docker/`. After changing them here, copy them to `/var/www/esstrapis-back`. Pushes that only touch `deploy/`, `docs/` or Markdown files don't build or deploy.

Secrets in GitHub: `VPS_HOST`, `VPS_USER`, `VPS_SSH_KEY`, `VPS_KNOWN_HOSTS`, `DOCKERHUB_USERNAME`, `DOCKERHUB_TOKEN`. Add required reviewers to the `production` environment to approve each deploy by hand.

## Access logs (response times and sizes)

Caddy logs every API request as one JSON line on the proxy's stdout (`docker logs esstrapis-back-proxy`): tenant (logger `http.log.access.<tenant>`), method, URI, status, `duration` (seconds) and `size` (bytes sent, gzipped when compressed). Request and response headers are not logged, the client IP is cut to /16 and tokens in the query string are replaced by `REDACTED` (see the `access_log` snippet in `render.sh`). The proxy's Docker log is capped at 3 × 10 MB.

They reach Grafana through the host promtail, like the backend logs:

- `logging/promtail-caddy-access.yaml`: the `caddy-access` job to append under `scrape_configs:` in `/etc/promtail/promtail-config.yaml` (then `sudo systemctl restart promtail`). Labels `job="caddy"`, `instance="<tenant>"`; other Caddy lines (admin API health checks, reloads) are dropped.
- `logging/caddy-access-dashboard.json`: the "API requests — duration & size" dashboard. Copy it to `~/centralized-logging/grafana/dashboards/`; Grafana loads it within 30 s. It shows requests, p95 duration, 5xx and response size per tenant, the slowest and largest endpoints (ids collapsed to `:id`), and the requests slower than a threshold.

## Adding a tenant

Point the domain's DNS at the VPS, then on the server:

```bash
cd /var/www/esstrapis-back
./create-tenant.sh <name> <domain> --user-email <e-mail> --dry-run   # shows the ports and paths it would use
./create-tenant.sh <name> <domain> --user-email <e-mail>
```

`create-tenant.sh`:
1. writes `envs/<name>.env`: the shared settings (SMTP, API keys, `TICKETS_SSO_KEY`) copied from `envs/buida.env`, plus new secrets and a new database password;
2. creates the empty database `<name>_v5` and the MySQL user `<name>` (it asks for the MySQL admin password);
3. adds the tenant to `tenants.conf` on the next free port, starts `<name>-blue`, waits for it and points the proxy at it;
4. creates the front in `/var/www/projectes-<name>/docker`, starts it and adds it to the front's `sites.conf`;
5. installs the nginx site and runs certbot (asks for the sudo password; with `--skip-nginx` it prints the commands instead).

Each step is skipped when already done, so a run that failed halfway is simply run again. It never drops or overwrites anything, and refuses a name whose database, MySQL user, directory or env file already exists.

No other tenant is copied. The database starts empty: the first boot creates the tables and seeds what an instance needs (catalogs, Configuració General with demo values, home menu, the current year and its invoice series; see `src/services/seed-new-database.js`). With `--user-email`, that boot also creates a first app user with the `admin` permission; the script prints its generated password once and then removes `SEED_USER_*` from the env file. The Strapi admin user is registered at `/admin` as usual.

It holds the deploy lock while the backend starts (a few minutes on the first boot), so a CI deploy arriving in that window fails with "Another deploy is running" and has to be rerun.

`migrate-to-proxy.sh` did the one-time move from one container per port to this setup (2026-10-09). It is kept for reference.

## Rolling back

```bash
./deploy.sh v5-<earlier sha>              # every tenant, zero downtime
./deploy.sh v5-<earlier sha> diligencia   # just one
```

Every `main` commit has its image on Docker Hub (`webcoop/esstrapis-back:v5-<sha>`); `deploy.log` lists what was deployed when. There is no PM2 fallback any more: since 2026-10-09 the tenant directories hold only `uploads/` (and the fronts' `docker/`), not the backend code.
