'use strict';

/**
 * Which GET routes are answered from the read cache, and what their answers
 * depend on (issues/307).
 *
 * First the master tables: the lists behind the app's selects («Taules
 * auxiliars» of the administration, plus months, routes and city routes).
 * They are small, change rarely and are read on almost every page. Only reads
 * whose answer depends on nothing but the query, the route's parameters, the
 * data and the caller's role are listed: the core find/findOne, and the
 * custom reads reviewed one by one. «Festius d'usuari» is left out (each
 * person's own), and so is GET /activity-types/global, which writes.
 */

const CORE_READS = ['find', 'findOne'];

/** api name -> the actions served from the cache */
const CACHED_ROUTES = {
  'project-scope': CORE_READS,
  'project-state': CORE_READS,
  'project-likelihood': CORE_READS,
  'project-type': CORE_READS,
  strategy: CORE_READS,
  'dedication-type': CORE_READS,
  'activity-type': [...CORE_READS, 'getBasic'],
  'task-state': CORE_READS,
  'bank-account': CORE_READS,
  'payment-method': CORE_READS,
  serie: CORE_READS,
  'expense-type': CORE_READS,
  'income-type': CORE_READS,
  'document-type': CORE_READS,
  'vat-type': CORE_READS,
  product: CORE_READS,
  year: CORE_READS,
  month: CORE_READS,
  'festive-type': CORE_READS,
  'contact-type': CORE_READS,
  'legal-form': CORE_READS,
  region: CORE_READS,
  sector: CORE_READS,
  'social-entity': CORE_READS,
  pickup: CORE_READS,
  'delivery-type': CORE_READS,
  city: CORE_READS,
  route: CORE_READS,
  'route-rate': CORE_READS,
  'city-route': [...CORE_READS, 'basic'],
};

// what the role-based cleaning of an answer reads (sanitizeOutput): kept
// answers are per role, and stale when the role's permissions change
const PERMISSION_TABLES = ['up_permissions', 'up_roles', 'up_permissions_role_lnk'];

const MIDDLEWARE = 'global::read-cache';

/** The action of a route handler: 'api::city.city.find' / 'city.find' → 'find'. */
function actionOf(handler) {
  if (typeof handler !== 'string') return null;
  const parts = handler.split('.');
  return parts[parts.length - 1] || null;
}

function instantiate(routers, strapi) {
  for (const [key, router] of Object.entries(routers || {})) {
    if (typeof router === 'function') routers[key] = router({ strapi });
  }
  return routers || {};
}

/**
 * Puts the cache middleware on the listed routes, after app-permissions (so
 * access is checked and the answer cleaned for the caller on every request).
 * Runs in register(), after registerAppPermissions. Returns the routes
 * changed.
 */
function registerReadCacheRoutes(strapi, cached = CACHED_ROUTES) {
  let count = 0;
  const loaded = new Set(Object.keys(strapi.apis || {}));
  for (const [name, actions] of Object.entries(cached)) {
    if (!loaded.has(name)) continue;
    const api = strapi.api(name);
    if (!api) continue;
    for (const router of Object.values(instantiate(api.routes, strapi))) {
      for (const route of router.routes || []) {
        if (route.method !== 'GET' || !actions.includes(actionOf(route.handler))) continue;
        route.config = route.config || {};
        const middlewares = route.config.middlewares || [];
        if (!middlewares.includes(MIDDLEWARE)) route.config.middlewares = [...middlewares, MIDDLEWARE];
        count++;
      }
    }
  }
  return count;
}

/**
 * The tables a content type is stored in: its own, its relations' link
 * tables, its components' tables. What a cached answer depends on besides the
 * tables its load read.
 */
function tablesOf(strapi, uid, seen = new Set()) {
  if (seen.has(uid)) return [];
  seen.add(uid);
  let meta;
  try {
    meta = strapi.db.metadata.get(uid);
  } catch {
    return [];
  }
  if (!meta) return [];
  const tables = [meta.tableName];
  for (const attribute of Object.values(meta.attributes || {})) {
    if (attribute.joinTable && attribute.joinTable.name) tables.push(attribute.joinTable.name);
    if (attribute.type === 'component' && attribute.component)
      tables.push(...tablesOf(strapi, attribute.component, seen));
    if (attribute.type === 'dynamiczone' && Array.isArray(attribute.components)) {
      for (const c of attribute.components) tables.push(...tablesOf(strapi, c, seen));
    }
  }
  return [...new Set(tables.filter(Boolean).map((t) => String(t).toLowerCase()))];
}

/** The content type behind a route: 'api::city.city.find' → 'api::city.city'. */
function uidOfRoute(route, apiName) {
  const handler = route && route.handler;
  if (typeof handler === 'string' && handler.startsWith('api::'))
    return handler.split('.').slice(0, 2).join('.');
  const name = apiName || (route && route.info && route.info.apiName);
  return name ? `api::${name}.${name}` : null;
}

/** Everything a route's kept answer depends on besides what its load reads. */
function routeTables(strapi, route) {
  const uid = uidOfRoute(route);
  return [...(uid ? tablesOf(strapi, uid) : []), ...PERMISSION_TABLES];
}

/** JSON with sorted keys, so the same query always gives the same key. */
function stableJson(value) {
  if (value === undefined) return 'undefined';
  if (value === null || typeof value !== 'object') return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(stableJson).join(',')}]`;
  const keys = Object.keys(value).sort();
  return `{${keys.map((k) => `${JSON.stringify(k)}:${stableJson(value[k])}`).join(',')}}`;
}

/**
 * Who asks, as far as the answer can depend on it: the role (the core
 * controllers clean their answer by the role's permissions), or the Public
 * role. Null for any other way of authenticating (API tokens, ...): not cached.
 */
function callerOf(ctx) {
  const auth = ctx.state && ctx.state.auth;
  const user = ctx.state && ctx.state.user;
  if (!auth) return user ? null : 'public';
  if (!auth.strategy || auth.strategy.name !== 'users-permissions') return null;
  if (!user) return 'public';
  const role = user.role;
  if (!role || role.id === undefined || role.id === null) return null;
  return `role:${role.id}`;
}

function routeCacheKey(ctx, caller) {
  const route = (ctx.state && ctx.state.route) || {};
  return `route|${route.method} ${route.path}|${route.handler}|${caller}|${stableJson(ctx.params || {})}|${stableJson(ctx.query || {})}`;
}

module.exports = {
  CACHED_ROUTES,
  PERMISSION_TABLES,
  MIDDLEWARE,
  registerReadCacheRoutes,
  tablesOf,
  uidOfRoute,
  routeTables,
  stableJson,
  callerOf,
  routeCacheKey,
  actionOf,
};
