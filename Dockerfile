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
#
# Layers, from the most stable to the one that changes on every commit, so a
# deploy pulls only what changed: the production node_modules (~860 MB, changes
# only with package-lock.json), the admin build (~12 MB), the app code (~3 MB)
# and the Node compile cache. With node_modules in the same layer as the code,
# every deploy pulled the whole image again (~2.5 min on the VPS).

FROM node:22-bookworm-slim AS deps
WORKDIR /opt/app
COPY package.json package-lock.json ./
RUN npm ci --omit=dev --no-audit --no-fund \
 && npm cache clean --force

FROM node:22-bookworm-slim AS build
WORKDIR /opt/app
ENV NODE_ENV=production
COPY package.json package-lock.json ./
RUN npm ci --include=dev --no-audit --no-fund
COPY . .
RUN npm run build

FROM node:22-bookworm-slim
# NODE_COMPILE_CACHE: Node keeps the compiled code of every module it loads
# there, so the next start skips compiling them (filled below).
ENV NODE_ENV=production \
    HOST=0.0.0.0 \
    PORT=1337 \
    NODE_COMPILE_CACHE=/opt/app/.node-compile-cache
WORKDIR /opt/app
# Strapi writes in the app folder at runtime (.tmp), and so does the cache below.
RUN chown node:node /opt/app
COPY --from=deps --chown=node:node /opt/app/node_modules ./node_modules
COPY --from=build --chown=node:node /opt/app/build ./build
COPY --chown=node:node . .
USER node
RUN node scripts/warm-compile-cache.js
# Tenant uploads (images, generated PDFs, e-invoicing certificates): mount a volume.
VOLUME /opt/app/public/uploads
EXPOSE 1337
HEALTHCHECK --interval=30s --timeout=5s --start-period=120s --retries=3 \
  CMD node -e "fetch('http://127.0.0.1:'+(process.env.PORT||1337)+'/_health').then(r=>process.exit(r.ok?0:1),()=>process.exit(1))"
# Strapi directly (not through npm), so it gets SIGTERM and shuts down cleanly.
CMD ["node", "node_modules/@strapi/strapi/bin/strapi.js", "start"]
