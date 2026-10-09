# Backend in Docker (one image for every tenant)

`webcoop/esstrapis-back:v5` is built by `.github/workflows/v5.yml` on every push to `main`. Each build also publishes `:v5-<sha>` for pinning or rollback. The admin panel is built once in the image. With the admin on the same origin as the API and `URL` without a sub-path, Strapi bakes only `"/"` as the backend URL, so one build serves every domain. Keep it that way: don't set `admin.url` to another host, don't add a path to `URL`, and don't add `STRAPI_ADMIN_*` variables.

What makes each tenant different:
- **Environment:** the same variables as its PM2 config, converted with `pm2-env-to-dotenv.js` into `envs/<tenant>.env`.
- **Uploads:** `<tenant dir>/public/uploads` is mounted at `/opt/app/public/uploads`. It holds images, generated PDFs and e-invoicing certificates.
- **Network:** `network_mode: host`, so the tenant keeps its `127.0.0.1:<PORT>`, its nginx site and MySQL on `127.0.0.1`.

## On the server (`/var/www/esstrapis-back`)

```bash
./to-docker.sh demo                    # PM2 -> Docker; rolls back by itself if unhealthy
./to-pm2.sh demo                       # Docker -> PM2
docker compose pull && docker compose up -d     # deploy a new image to the Docker tenants
BACK_TAG=v5-<sha> docker compose up -d demo     # pin or roll back one tenant
docker compose logs -f demo
```

`to-docker.sh` renames `~/pm2-apps/strapi-projectes-<t>-v5.config.js` to `.config.js.docker`, so `deploy-projectes-back.sh` skips Docker tenants. Settings stay in the PM2 config. After changing one, rerun `./to-docker.sh <t>`: it regenerates the env file. That needs the `.docker` file renamed back first, or edit `envs/<t>.env` directly and run `docker compose up -d <t>`.
