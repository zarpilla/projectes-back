# Backend in Docker (one image for every tenant)

`webcoop/esstrapis-back:v5` is built by `.github/workflows/v5.yml` on every push to `main`. Each build also publishes `:v5-<sha>` for pinning or rollback. The admin panel is built once in the image. With the admin on the same origin as the API and `URL` without a sub-path, Strapi bakes only `"/"` as the backend URL, so one build serves every domain. Keep it that way: don't set `admin.url` to another host, don't add a path to `URL`, and don't add `STRAPI_ADMIN_*` variables.

What makes each tenant different:
- **Environment:** the same variables as its PM2 config, converted with `pm2-env-to-dotenv.js` into `envs/<tenant>.env`.
- **Uploads:** `<tenant dir>/public/uploads` is mounted at `/opt/app/public/uploads`. It holds images, generated PDFs and e-invoicing certificates.
- **Network:** `network_mode: host`, so the tenant keeps its `127.0.0.1:<PORT>`, its nginx site and MySQL on `127.0.0.1`.

## Automatic deploy

When a push to `main` passes the tests and the image is pushed, the `deploy` job in `.github/workflows/v5.yml` SSHes to the VPS and runs `deploy.sh v5-<sha>`:
- The canary `buida` goes first, then the rest two at a time. Each must answer `/api/logos` within 180 s.
- If one doesn't, every tenant updated in that run goes back to the previous build, and the job fails.
- The deployed tag is kept in `.env` (`BACK_TAG`), which `docker-compose.yml` reads.
- A lock prevents two deploys at once.
- The log is in `deploy.log`.

The SSH key used by GitHub can only run this script. Its `~/.ssh/authorized_keys` line is `command="/var/www/esstrapis-back/deploy.sh",restrict ssh-ed25519 …`, so it gets no shell and no forwarding, and the tag is validated. GitHub pins the server's host key.

Repository secrets: `VPS_HOST`, `VPS_USER`, `VPS_SSH_KEY` (private key), `VPS_KNOWN_HOSTS` (`ssh-keyscan -t ed25519 <host>`), plus `DOCKERHUB_USERNAME` / `DOCKERHUB_TOKEN`. The job runs in the `production` environment: add required reviewers there to approve each deploy by hand.

## On the server (`/var/www/esstrapis-back`)

```bash
./to-docker.sh demo                    # PM2 -> Docker; rolls back by itself if unhealthy
./to-pm2.sh demo                       # Docker -> PM2
./deploy.sh v5-<sha>                   # deploy a build to every tenant (what CI runs)
./deploy.sh v5-<sha> demo diligencia   # only some tenants (doesn't change BACK_TAG in .env)
./deploy.sh v5-<previous sha>          # roll everything back
docker compose logs -f demo
```

`to-docker.sh` renames `~/pm2-apps/strapi-projectes-<t>-v5.config.js` to `.config.js.docker`, so `deploy-projectes-back.sh` skips Docker tenants. Settings stay in the PM2 config. After changing one, rerun `./to-docker.sh <t>`: it regenerates the env file. That needs the `.docker` file renamed back first, or edit `envs/<t>.env` directly and run `docker compose up -d <t>`.
