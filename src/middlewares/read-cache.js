'use strict';

/**
 * Answers the master tables' GET routes from the read cache (issues/307).
 *
 * Put on the routes listed in services/read-cache/routes.js, right after
 * global::app-permissions: Strapi's role check, the app permissions and the
 * response cleaning for the caller still run on every request; only what the
 * controller returns is kept, per role, query string and route parameters.
 * A request that isn't a plain GET by a users-permissions user or the Public
 * role goes straight to the controller, and so does every request while the
 * cache is off. Only 200 answers with a JSON body are kept.
 */

const { getReadCache } = require('../services/read-cache');
const { callerOf, routeCacheKey, routeTables } = require('../services/read-cache/routes');

const isJsonBody = (body) =>
  body !== null &&
  typeof body === 'object' &&
  !Buffer.isBuffer(body) &&
  typeof body.pipe !== 'function' &&
  !(body instanceof ArrayBuffer);

module.exports = (_config, { strapi }) =>
  async function readCache(ctx, next) {
    const cache = getReadCache();
    if (ctx.method !== 'GET' || !cache.isOn()) return next();
    const caller = callerOf(ctx);
    if (!caller) return next();

    const body = await cache.get(
      routeCacheKey(ctx, caller),
      async () => {
        await next();
        return ctx.body;
      },
      {
        tables: routeTables(strapi, ctx.state.route),
        keep: (value) => ctx.status === 200 && isJsonBody(value),
      },
    );
    ctx.body = body;
  };
