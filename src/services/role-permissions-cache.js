'use strict';
/* global strapi */

/**
 * Keeps the permissions of a role in memory between requests.
 *
 * The users-permissions strategy reads the role's permissions on every request:
 * 336 rows for Authenticated, turned into objects one by one (dates parsed, the
 * relation transformed). On a request that returns a few rows that was most of
 * the time spent: about 25 ms of 30 locally, and each tenant's backend is one
 * Node thread, so a page that sends 15 requests paid it 15 times in a row
 * (issues/016).
 *
 * Two things are kept: the role -> permissions list, and the ability (the
 * object that answers "may this role call this action") built from a given
 * list of actions, which Strapi otherwise rebuilds permission by permission on
 * every request and was the larger half of the cost. The user is still read on
 * every request, so blocking a user or changing their role applies at once.
 *
 * The list is dropped when a role or a permission is written in this process
 * (registerRolePermissionsInvalidation) and expires after TTL_MS, which bounds
 * how long another process (a second container during a deploy) or a manual
 * change in the database can go unnoticed.
 *
 * ROLE_PERMISSIONS_CACHE=false turns all of it off.
 */

const TTL_MS = 30 * 1000;

const MODELS = ['plugin::users-permissions.permission', 'plugin::users-permissions.role'];

const enabled = () => process.env.ROLE_PERMISSIONS_CACHE !== 'false';

const caches = new Set();

function clearRolePermissionsCache() {
  for (const cache of caches) cache.clear();
}

/**
 * Wraps the users-permissions `permission` service so that findRolePermissions
 * and findPublicPermissions answer from memory. The strategy calls them
 * detached (`.then(service.findRolePermissions)`), so they don't rely on `this`.
 */
function cachePermissionReads(service, { ttlMs = TTL_MS, now = Date.now } = {}) {
  if (!enabled()) return service;
  const cache = new Map();
  caches.add(cache);

  const remember = (key, load) => {
    const hit = cache.get(key);
    if (hit && now() - hit.at < ttlMs) return hit.promise;
    // The promise is kept, so requests arriving together share one read.
    const entry = { at: now(), promise: Promise.resolve().then(load) };
    // A failed read is not kept: the next request tries again.
    entry.promise.catch(() => {
      if (cache.get(key) === entry) cache.delete(key);
    });
    cache.set(key, entry);
    return entry.promise;
  };

  const findRolePermissions = service.findRolePermissions.bind(service);
  const findPublicPermissions = service.findPublicPermissions.bind(service);

  service.findRolePermissions = (roleID) => remember(`role:${roleID}`, () => findRolePermissions(roleID));
  service.findPublicPermissions = () => remember('public', () => findPublicPermissions());
  return service;
}

const MAX_ABILITIES = 50;

/**
 * Makes the content API permission engine build the ability of a given list of
 * actions once. The ability depends only on that list (and on the actions
 * registered at startup), so two requests with the same list can share it; a
 * changed list is a different key and is built anew. Anything other than plain
 * `{ action }` permissions without options is passed through untouched.
 */
function cacheAbilities(engine) {
  if (!enabled()) return engine;
  const abilities = new Map();
  caches.add(abilities);
  const generateAbility = engine.generateAbility.bind(engine);

  engine.generateAbility = (permissions, options) => {
    const plain =
      Array.isArray(permissions) &&
      (options === undefined || Object.keys(options).length === 0) &&
      permissions.every((p) => p && typeof p.action === 'string' && Object.keys(p).length === 1);
    if (!plain) return generateAbility(permissions, options);

    const key = permissions.map((p) => p.action).join('\n');
    const hit = abilities.get(key);
    if (hit) return hit;
    const promise = generateAbility(permissions, options);
    promise.catch(() => {
      if (abilities.get(key) === promise) abilities.delete(key);
    });
    if (abilities.size >= MAX_ABILITIES) abilities.clear();
    abilities.set(key, promise);
    return promise;
  };
  return engine;
}

/** Drops what is kept whenever a role or a permission is written. */
function registerRolePermissionsInvalidation() {
  cacheAbilities(strapi.contentAPI.permissions.engine);
  const handler = () => clearRolePermissionsCache();
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

module.exports = {
  cachePermissionReads,
  cacheAbilities,
  clearRolePermissionsCache,
  registerRolePermissionsInvalidation,
  TTL_MS,
};
