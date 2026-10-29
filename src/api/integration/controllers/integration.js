'use strict';
/* global strapi */

/**
 * Integrations API (routes/integration.js, docs/INTEGRATIONS_API.md).
 *
 * The write endpoints answer 200 with one result per item and a summary, even
 * when some items are rejected; 400 only for a malformed request, 401/403/429
 * from the api-key policy.
 */
const crypto = require('crypto');
const { createLookups, WEEKDAYS } = require('../services/lookups');
const {
  itemsOf,
  dryRunOf,
  runItems,
  summaryOf,
  withOwnerLock,
  externalIdOf,
  MAX_ITEMS,
} = require('../services/sync-common');
const { syncContact } = require('../services/contacts-sync');
const { syncOrder, cancelOrder, lookupOrders } = require('../services/orders-sync');
const { readDefaultPickup } = require('../../../services/user-default-pickup');
const { appPermissionsOf } = require('../../../services/app-permissions');
const refs = require('../../../services/integrations/refs');
const apiKeys = require('../../../services/integrations/api-keys');

/** The member the key acts for; also `state.user`, so the order history names her. */
function memberOf(ctx) {
  const { user, permissions, key } = ctx.state.integration;
  ctx.state.user = { id: user.id, username: `${user.username || user.email} (API)`, email: user.email };
  return { userId: user.id, user: { id: user.id }, permissions, key };
}

async function runWrite(ctx, field, handle) {
  const { items, error } = itemsOf(ctx.request.body, field);
  if (error) return ctx.badRequest(error);
  const member = memberOf(ctx);
  const dryRun = dryRunOf(ctx.request.body);
  const requestId = crypto.randomUUID();
  const started = Date.now();
  const hctx = { ...member, lookups: createLookups(), dryRun, cache: {} };
  const results = await withOwnerLock(member.userId, () =>
    runItems(items, (item, externalId) => handle(item, externalId, hctx), strapi.log),
  );
  const summary = summaryOf(results);
  const counts = Object.entries(summary)
    .filter(([k, v]) => v && k !== 'received')
    .map(([k, v]) => `${k}=${v}`)
    .join(' ');
  strapi.log.info(
    `[integrations] ${ctx.method} ${ctx.path} user=${member.userId} key=${member.key.prefix} ` +
      `request=${requestId}${dryRun ? ' dry_run' : ''} received=${summary.received} ${counts} ${Date.now() - started}ms`,
  );
  ctx.body = { request_id: requestId, dry_run: dryRun, summary, results };
  return ctx.body;
}

const weekdaysOf = (route) => WEEKDAYS.filter((day) => route[day]);

module.exports = () => ({
  async syncContacts(ctx) {
    return runWrite(ctx, 'contacts', syncContact);
  },

  async syncOrders(ctx) {
    return runWrite(ctx, 'orders', syncOrder);
  },

  async cancelOrders(ctx) {
    return runWrite(ctx, 'orders', cancelOrder);
  },

  /** GET /integrations/orders?external_id=A&external_id=B (or A,B) */
  async orders(ctx) {
    const { userId } = memberOf(ctx);
    const raw = ctx.query.external_id;
    const list = (Array.isArray(raw) ? raw : [raw])
      .filter((v) => v !== undefined && v !== null)
      .flatMap((v) => String(v).split(','))
      .map((v) => externalIdOf({ external_id: v }).value)
      .filter(Boolean);
    const unique = [...new Set(list)];
    if (!unique.length) return ctx.badRequest('Cal indicar external_id');
    if (unique.length > MAX_ITEMS) return ctx.badRequest(`Com a màxim ${MAX_ITEMS} external_id per petició`);
    ctx.body = { orders: await lookupOrders(unique, userId) };
    return ctx.body;
  },

  /** GET /integrations/catalog: what the orders and points can name. */
  async catalog(ctx) {
    const { userId } = memberOf(ctx);
    const lookups = createLookups();
    const [routes, pickups, sectors, legalForms, preferred, points] = await Promise.all([
      lookups.routes(),
      lookups.pickups(),
      lookups.sectors(),
      lookups.legalForms(),
      readDefaultPickup(userId),
      strapi.db.query('api::contact.contact').findMany({
        where: { owner: { id: userId } },
        select: ['id', 'name', 'trade_name', 'nif', 'city'],
        orderBy: { id: 'asc' },
      }),
    ]);
    const external = await refs.externalIdsOf(
      userId,
      'contact',
      points.map((p) => p.id),
    );
    ctx.body = {
      routes: routes
        .filter((r) => r.active && !r.is_transfer_route)
        .map((r) => ({
          id: r.id,
          name: r.name,
          short_name: r.short_name || null,
          weekdays: weekdaysOf(r),
          afternoon: Boolean(r.afternoon),
        })),
      pickups: pickups
        .filter((p) => !p.pickup)
        .map((p) => ({
          id: p.id,
          name: p.name,
          alias: p.alias || null,
          default: Boolean(preferred && preferred.id === p.id),
        })),
      sectors: sectors.map((s) => ({ id: s.id, name: s.name })),
      legal_forms: legalForms.map((l) => ({ id: l.id, name: l.name })),
      delivery_points: points.map((p) => ({
        id: p.id,
        external_id: external.get(p.id) || null,
        trade_name: p.trade_name || null,
        name: p.name || null,
        nif: p.nif || null,
        city: p.city || null,
      })),
    };
    return ctx.body;
  },

  // --- API keys (Administració › Usuàries, app admins) ----------------------

  /** GET /integrations/api-keys?user=<id> */
  async listApiKeys(ctx) {
    const userId = Number(ctx.query.user);
    if (!Number.isInteger(userId) || userId <= 0) return ctx.badRequest('Cal indicar la usuària (user)');
    ctx.body = await apiKeys.listKeys(userId);
    return ctx.body;
  },

  /** POST /integrations/api-keys { user, name } → the key, shown only now */
  async createApiKey(ctx) {
    const body = ctx.request.body && typeof ctx.request.body === 'object' ? ctx.request.body : {};
    const data = body.data && typeof body.data === 'object' ? body.data : body;
    const userId = Number(data.user);
    if (!Number.isInteger(userId) || userId <= 0) return ctx.badRequest('Cal indicar la usuària (user)');
    const user = await strapi.db
      .query('plugin::users-permissions.user')
      .findOne({ where: { id: userId }, select: ['id', 'blocked'] });
    if (!user) return ctx.notFound('Usuària no trobada');
    if (!(await appPermissionsOf(userId)).includes('orders')) {
      return ctx.badRequest("Només les usuàries amb el permís de comandes poden tenir claus d'API");
    }
    const created = await apiKeys.createKey({
      userId,
      name: data.name,
      createdBy: ctx.state.user && ctx.state.user.id,
    });
    strapi.log.info(
      `[integrations] api key ${created.prefix} created for user=${userId} by user=${ctx.state.user && ctx.state.user.id}`,
    );
    ctx.body = created;
    return ctx.body;
  },

  /** DELETE /integrations/api-keys/:id → revoked (kept, no longer valid) */
  async revokeApiKey(ctx) {
    const id = Number(ctx.params.id);
    const key = Number.isInteger(id) ? await apiKeys.findKey(id) : null;
    if (!key) return ctx.notFound("Clau d'API no trobada");
    await apiKeys.revokeKey(id);
    strapi.log.info(
      `[integrations] api key ${key.prefix} revoked by user=${ctx.state.user && ctx.state.user.id}`,
    );
    ctx.body = await apiKeys.findKey(id);
    return ctx.body;
  },
});
