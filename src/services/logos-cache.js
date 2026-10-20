'use strict';
/* global strapi */

/**
 * Keeps the answers of GET /api/logos in memory (issues/308).
 *
 * Logos are read on every login page and almost never change, so the list is
 * read from the database once per query and then served from here. It is
 * dropped when a logo or an uploaded file is written in this process
 * (registerLogosCacheInvalidation): a file write covers replacing a logo's
 * image, and other uploads only cost one extra read.
 *
 * The key is the raw query string plus who asks (public or a role), since the
 * sanitized answer depends on the caller's permissions.
 *
 * LOGOS_CACHE=false turns it off.
 */

const MODELS = ['api::logo.logo', 'plugin::upload.file'];
const MAX_ENTRIES = 50;

const enabled = () => process.env.LOGOS_CACHE !== 'false';

const cache = new Map();

function clearLogosCache() {
  cache.clear();
}

/** The cache key of a request: query string and caller. */
function logosCacheKey(ctx) {
  const role =
    ctx.state && ctx.state.user ? `role:${ctx.state.user.role ? ctx.state.user.role.id : '?'}` : 'public';
  return `${role}?${ctx.querystring || ''}`;
}

/**
 * Answers from memory, or runs `load` and keeps its result. Requests arriving
 * together share one read; a failed read is not kept. Each caller gets its own
 * copy, so a later change to a response can't reach the kept one.
 */
async function rememberLogos(key, load) {
  if (!enabled()) return load();
  let entry = cache.get(key);
  if (!entry) {
    entry = Promise.resolve()
      .then(load)
      .then((body) => structuredClone(body));
    entry.catch(() => {
      if (cache.get(key) === entry) cache.delete(key);
    });
    if (cache.size >= MAX_ENTRIES) cache.clear();
    cache.set(key, entry);
  }
  return structuredClone(await entry);
}

/** Drops what is kept whenever a logo or an uploaded file is written. */
function registerLogosCacheInvalidation() {
  const handler = () => clearLogosCache();
  strapi.db.lifecycles.subscribe({
    models: MODELS,
    afterCreate: handler,
    afterCreateMany: handler,
    afterUpdate: handler,
    afterUpdateMany: handler,
    afterDelete: handler,
    afterDeleteMany: handler,
  });
}

module.exports = { rememberLogos, logosCacheKey, clearLogosCache, registerLogosCacheInvalidation };
