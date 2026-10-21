'use strict';

/**
 * Fills the Node compile cache (NODE_COMPILE_CACHE, set in the Dockerfile) at
 * image build time, so every tenant's Strapi starts without compiling its
 * modules first: loading the modules is about a third of the start, and
 * compiling them half of that.
 *
 * It runs Strapi's register phase (it loads the config, the APIs, the plugins
 * and their dependencies) without a database: there is none during the build,
 * and the bootstrap that needs one is not run. Placeholder secrets only let
 * the config load. Whatever is loaded before a failure is still cached, so a
 * failure never breaks the build: the image then only starts a bit slower.
 */
const mod = require('module');

if (!mod.flushCompileCache || !process.env.NODE_COMPILE_CACHE) {
  console.log('[warm-compile-cache] no compile cache in this Node, skipped');
  process.exit(0);
}

for (const key of ['APP_KEYS', 'ADMIN_JWT_SECRET', 'API_TOKEN_SALT', 'TRANSFER_TOKEN_SALT', 'JWT_SECRET', 'ENCRYPTION_KEY']) {
  if (!process.env[key]) process.env[key] = 'build-time-placeholder';
}
process.env.CRON_ENABLED = 'false';
// The production client, so its driver is loaded too (nothing connects in register).
process.env.DATABASE_CLIENT = process.env.DATABASE_CLIENT || 'mysql';

async function main() {
  const { createStrapi } = require('@strapi/strapi');
  const app = createStrapi();
  await app.register();
}

const started = Date.now();
main()
  .catch((err) => console.log(`[warm-compile-cache] register stopped early: ${err.message}`))
  .finally(() => {
    mod.flushCompileCache();
    console.log(`[warm-compile-cache] ${Object.keys(require.cache).length} modules cached in ${Date.now() - started} ms`);
    process.exit(0);
  });
