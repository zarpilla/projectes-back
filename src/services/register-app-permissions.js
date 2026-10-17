'use strict';

/**
 * Puts the `global::app-permissions` middleware (issues/099) on every
 * content-API route: the app's APIs and the plugins' content-API routers
 * (users-permissions, upload). Admin-panel routes are left alone, their users
 * are not app users.
 *
 * Runs in register(): Strapi registers the routes during bootstrap, from the
 * same router objects. Router factories are instantiated here the way Strapi
 * would (it only calls the ones that are still functions), so the routes this
 * adds the middleware to are the ones that get registered.
 */
const MIDDLEWARE = 'global::app-permissions';

function instantiate(routers, strapi) {
  for (const [key, router] of Object.entries(routers || {})) {
    if (typeof router === 'function') routers[key] = router({ strapi });
  }
  return routers || {};
}

function addTo(route) {
  route.config = route.config || {};
  const middlewares = route.config.middlewares || [];
  if (!middlewares.includes(MIDDLEWARE)) route.config.middlewares = [...middlewares, MIDDLEWARE];
}

function registerAppPermissions(strapi) {
  let count = 0;
  for (const name of Object.keys(strapi.apis || {})) {
    const api = strapi.api(name);
    // every API router is a content-API router (Strapi forces the type)
    for (const router of Object.values(instantiate(api.routes, strapi))) {
      for (const route of router.routes || []) {
        addTo(route);
        count++;
      }
    }
  }
  for (const plugin of Object.values(strapi.plugins || {})) {
    if (Array.isArray(plugin.routes)) continue; // legacy array form: admin routes
    for (const router of Object.values(instantiate(plugin.routes, strapi))) {
      if (router.type !== 'content-api') continue;
      for (const route of router.routes || []) {
        addTo(route);
        count++;
      }
    }
  }
  return count;
}

module.exports = { registerAppPermissions, MIDDLEWARE };
