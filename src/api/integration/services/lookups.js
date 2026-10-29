'use strict';
/* global strapi */

/**
 * The integrations API names routes, warehouses, sectors and legal forms by
 * their name (or id), like the CSV import names the route: case, accents and
 * extra spaces don't count. The lists are read once per request.
 */

const norm = (value) =>
  String(value === undefined || value === null ? '' : value)
    .normalize('NFD')
    .replace(/[̀-ͯ]/g, '')
    .replace(/\s+/g, ' ')
    .trim()
    .toLowerCase();

const normNif = (value) =>
  String(value === undefined || value === null ? '' : value)
    .replace(/[\s.-]/g, '')
    .toUpperCase();

const isBlank = (value) => value === undefined || value === null || String(value).trim() === '';

/**
 * The item of `list` named by `value`: an id (number or digits) or a name
 * matching one of `fields`. → { item } | { error: 'not_found' | 'ambiguous' }
 */
function resolveNamed(list, value, fields = ['name']) {
  if (isBlank(value)) return { error: 'not_found' };
  if (typeof value === 'number' || /^\d+$/.test(String(value).trim())) {
    const item = list.find((x) => x.id === Number(value));
    if (item) return { item };
  }
  const wanted = norm(value);
  const matches = list.filter((x) => fields.some((f) => !isBlank(x[f]) && norm(x[f]) === wanted));
  if (matches.length === 1) return { item: matches[0] };
  return { error: matches.length ? 'ambiguous' : 'not_found' };
}

const WEEKDAYS = ['monday', 'tuesday', 'wednesday', 'thursday', 'friday', 'saturday', 'sunday'];

/** The lists one request needs, each read at most once. */
function createLookups() {
  const cache = new Map();
  const once = (key, load) => {
    if (!cache.has(key)) cache.set(key, load());
    return cache.get(key);
  };
  return {
    routes: () =>
      once('routes', () =>
        strapi.db.query('api::route.route').findMany({
          select: ['id', 'name', 'short_name', 'active', 'is_transfer_route', 'afternoon', ...WEEKDAYS],
          orderBy: [{ order: 'asc' }, { id: 'asc' }],
        }),
      ),
    pickups: () =>
      once('pickups', () =>
        strapi.db
          .query('api::pickup.pickup')
          .findMany({ select: ['id', 'name', 'alias', 'pickup'], orderBy: { id: 'asc' } }),
      ),
    sectors: () =>
      once('sectors', () =>
        strapi.db.query('api::sector.sector').findMany({ select: ['id', 'name'], orderBy: { id: 'asc' } }),
      ),
    legalForms: () =>
      once('legalForms', () =>
        strapi.db
          .query('api::legal-form.legal-form')
          .findMany({ select: ['id', 'name'], orderBy: { id: 'asc' } }),
      ),
    deliveryTypes: () =>
      once('deliveryTypes', () =>
        strapi.db
          .query('api::delivery-type.delivery-type')
          .findMany({ select: ['id', 'name', 'refrigerated'], orderBy: { id: 'asc' } }),
      ),
  };
}

module.exports = { norm, normNif, isBlank, resolveNamed, createLookups, WEEKDAYS };
