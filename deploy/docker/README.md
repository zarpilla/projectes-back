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

## Adding a tenant

1. Create its database and its uploads dir (`/var/www/<tenant>/uploads`). Write `envs/<name>.env` (`KEY='value'` lines; `pm2-env-to-dotenv.js` converts a PM2 config), then `chmod 600` it.
2. Add `<name> <port> <uploads dir>` to `tenants.conf`, pick a free port, and point the tenant's nginx site at `127.0.0.1:<port>`.
3. Run:
   ```bash
   ./render.sh && BACK_TAG=$(sed -n 's/^BACK_TAG=//p' .env) docker compose up -d <name>-blue
   # once http://127.0.0.1:<port+10000>/api/logos answers 200:
   echo blue > state/<name> && ./render.sh && docker compose exec proxy caddy reload --config /etc/caddy/Caddyfile
   ```

`migrate-to-proxy.sh` did the one-time move from one container per port to this setup (2026-10-09). It is kept for reference.

## Rolling back

```bash
./deploy.sh v5-<earlier sha>              # every tenant, zero downtime
./deploy.sh v5-<earlier sha> diligencia   # just one
```

Every `main` commit has its image on Docker Hub (`webcoop/esstrapis-back:v5-<sha>`); `deploy.log` lists what was deployed when. There is no PM2 fallback any more: since 2026-10-09 the tenant directories hold only `uploads/` (and the fronts' `docker/`), not the backend code.
