'use strict';

/**
 * The origins the API answers CORS for (issues/383).
 *
 * The default reflected any origin with credentials. Now: the instance's own
 * URL (`URL`), the front end URL kept in the database (`me.front_url`,
 * `config.front_url`), any extra in `CORS_ORIGINS` (comma-separated) and
 * localhost (local development and the e2e runs). An instance with none of
 * them set yet (a fresh local database) keeps the old open behaviour.
 * A refused origin is logged once, so a front end on an unexpected host shows
 * up in the logs.
 */
const TTL_MS = 60 * 1000;
const LOCAL = /^https?:\/\/(localhost|127\.0\.0\.1|\[::1\])(:\d+)?$/i;

let cache = { at: 0, origins: null };
const refused = new Set();

function originOf(url) {
  try {
    const { origin } = new URL(String(url || '').trim());
    return origin && origin !== 'null' ? origin : null;
  } catch {
    return null;
  }
}

async function databaseOrigins(strapi) {
  const origins = [];
  for (const uid of ['api::me.me', 'api::config.config']) {
    try {
      const rows = await strapi.db.query(uid).findMany({ select: ['front_url'] });
      for (const row of rows) origins.push(originOf(row.front_url));
    } catch {
      // a missing table on a fresh database
    }
  }
  return origins;
}

async function allowedOrigins(strapi, env = process.env) {
  if (cache.origins && Date.now() - cache.at < TTL_MS) return cache.origins;
  const origins = new Set(
    [
      originOf(env.URL),
      ...(await databaseOrigins(strapi)),
      ...String(env.CORS_ORIGINS || '').split(',').map(originOf),
    ].filter(Boolean),
  );
  cache = { at: Date.now(), origins };
  return origins;
}

/** For strapi::cors `origin`: the list to match the request's Origin against. */
async function corsOrigin(ctx, strapi = global.strapi, env = process.env) {
  const origin = ctx.get('Origin');
  const allowed = await allowedOrigins(strapi, env);
  if (!allowed.size) return '*';
  if (!origin || allowed.has(origin) || LOCAL.test(origin)) return [origin || '*'];
  if (!refused.has(origin)) {
    refused.add(origin);
    strapi.log.warn(`[cors] origin not allowed: ${origin} (add it to CORS_ORIGINS if it is a front end)`);
  }
  return [...allowed];
}

function resetCorsCache() {
  cache = { at: 0, origins: null };
  refused.clear();
}

module.exports = { corsOrigin, allowedOrigins, originOf, resetCorsCache };
