'use strict';

/**
 * The `http` line of every request, in Strapi's format
 * (`GET /api/orders?... (12 ms) 200`, read by the Loki dashboards), without
 * what people type (issues/394).
 *
 * strapi::logger wrote the whole URL, so searches, names, NIFs and filters
 * went to Loki for 90 days, while Caddy's own access log redacts them. The
 * shape of the query stays (it is what the performance reviews need, e.g.
 * issues/324): every parameter name, and the value only of the paging, sorting
 * and populate ones; the other values become `…`.
 */
const KEEP_VALUE = /^(_limit|_start|_sort|sort|pagination|populate|fields|publicationState|status)(\[|$)/;

function redactedQuery(querystring) {
  if (!querystring) return '';
  const parts = querystring.split('&').map((part) => {
    const eq = part.indexOf('=');
    const rawKey = eq === -1 ? part : part.slice(0, eq);
    let key;
    try {
      key = decodeURIComponent(rawKey);
    } catch {
      key = rawKey;
    }
    if (eq === -1) return rawKey;
    return KEEP_VALUE.test(key) ? part : `${rawKey}=…`;
  });
  return `?${parts.join('&')}`;
}

module.exports = (config, { strapi }) =>
  async function requestLog(ctx, next) {
    const start = Date.now();
    await next();
    const delta = Math.ceil(Date.now() - start);
    strapi.log.http(`${ctx.method} ${ctx.path}${redactedQuery(ctx.querystring)} (${delta} ms) ${ctx.status}`);
  };

module.exports.redactedQuery = redactedQuery;
