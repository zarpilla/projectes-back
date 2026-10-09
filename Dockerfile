# Strapi v5 backend: one image for every tenant.
#
# Everything tenant-specific comes from the environment (database, URL, secrets,
# SMTP, TICKETS_SSO_KEY...) and from the uploads volume. The admin panel is built
# once here: with the admin on the same origin as the API (admin.url not set to
# another host) and URL without a sub-path, Strapi bakes only the path "/" as the
# backend URL, so the same build works on every tenant's domain.
#
# Run with Docker Compose (deploy/docker: docker-compose.example.yml, to-docker.sh).
# The env files there quote their values, which Compose understands and plain
# `docker run --env-file` does not (it would pass the quotes on to Strapi).

FROM node:20-bookworm-slim AS build
WORKDIR /opt/app
ENV NODE_ENV=production
COPY package.json package-lock.json ./
RUN npm ci --include=dev --no-audit --no-fund
COPY . .
RUN npm run build \
 && npm prune --omit=dev \
 && npm cache clean --force

FROM node:20-bookworm-slim
ENV NODE_ENV=production \
    HOST=0.0.0.0 \
    PORT=1337
WORKDIR /opt/app
COPY --from=build --chown=node:node /opt/app ./
USER node
# Tenant uploads (images, generated PDFs, e-invoicing certificates): mount a volume.
VOLUME /opt/app/public/uploads
EXPOSE 1337
HEALTHCHECK --interval=30s --timeout=5s --start-period=120s --retries=3 \
  CMD node -e "fetch('http://127.0.0.1:'+(process.env.PORT||1337)+'/api/logos?_limit=1').then(r=>process.exit(r.ok?0:1),()=>process.exit(1))"
# Strapi directly (not through npm), so it gets SIGTERM and shuts down cleanly.
CMD ["node", "node_modules/@strapi/strapi/bin/strapi.js", "start"]
