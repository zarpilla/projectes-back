'use strict';

/**
 * The orders page loaded `contacts?_limit=-1` — the core route, which the
 * v3-compat middleware gives `populate: '*'`. Measured on 1175 contacts:
 * 126ms of database work and 942ms of contentAPI.sanitize.output for a 2.02 MB
 * payload, and a second call for the socies list paid it again.
 *
 * Sanitisation dominates and scales with rows × fields, so populating fewer
 * relations barely helped (942 -> 732ms). Selecting only the fields the page
 * reads, from a custom handler that skips sanitisation, gives 36ms / 0.59 MB.
 *
 * The field list is derived from what OrdersTable dereferences. These
 * assertions keep it honest: every name has to be a real attribute, the
 * scalars must not be relations, and the endpoint must be granted or it 403s
 * the way /api/upload did.
 */

const fs = require('fs');
const path = require('path');

const SRC = path.join(__dirname, '..', 'src');
const read = (...p) => fs.readFileSync(path.join(SRC, ...p), 'utf8');

const {
  FOR_ORDERS_FIELDS,
  FOR_ORDERS_POPULATE,
  SOCIES_POPULATE,
} = require('../src/api/contact/services/for-orders');

const attrs = JSON.parse(
  read('api', 'contact', 'content-types', 'contact', 'schema.json')
).attributes;

describe('for-orders field selection', () => {
  it('selects something, and always the id', () => {
    expect(FOR_ORDERS_FIELDS.length).toBeGreaterThan(5);
    expect(FOR_ORDERS_FIELDS).toContain('id');
  });

  it.each(FOR_ORDERS_FIELDS.filter((f) => f !== 'id'))(
    '%s is a real scalar attribute, not a relation',
    (field) => {
      expect(attrs[field]).toBeDefined();
      // db.query `select` takes scalars only; a relation there is silently dropped
      expect(attrs[field].type).not.toBe('relation');
      expect(attrs[field].type).not.toBe('component');
    }
  );

  it('carries the fields the CSV import and the display string need', () => {
    for (const f of ['name', 'trade_name', 'city', 'postcode', 'time_slot_1_ini', 'time_slot_1_end']) {
      expect(FOR_ORDERS_FIELDS).toContain(f);
    }
  });
});

describe('for-orders populate', () => {
  it.each(Object.keys(FOR_ORDERS_POPULATE))('%s is a real relation', (name) => {
    expect(attrs[name]).toBeDefined();
    expect(attrs[name].type).toBe('relation');
  });

  it('includes legal_form and sector, which the orders screens read', () => {
    expect(FOR_ORDERS_POPULATE.legal_form).toBe(true);
    expect(FOR_ORDERS_POPULATE.sector).toBe(true);
  });

  it('the socies variant adds the two relations the collection-point lookup walks', () => {
    expect(SOCIES_POPULATE.users_permissions_user).toEqual({ select: ['id'] });
    expect(SOCIES_POPULATE.collection_points).toEqual({ select: ['id'] });
    expect(attrs.users_permissions_user.type).toBe('relation');
    expect(attrs.collection_points.type).toBe('relation');
  });

  it('keeps the heavy project collections out', () => {
    for (const p of [FOR_ORDERS_POPULATE, SOCIES_POPULATE]) {
      expect(p.projects).toBeUndefined();
      expect(p.projectes).toBeUndefined();
    }
  });
});

describe('wiring', () => {
  it('the route exists and points at the handler', () => {
    const routes = read('api', 'contact', 'routes', '01-custom-contact.js');
    expect(routes).toContain("path: '/contacts/for-orders'");
    expect(routes).toContain("handler: 'contact.forOrders'");
  });

  it('the handler uses the shared selection rather than its own copy', () => {
    const controller = read('api', 'contact', 'controllers', 'contact.js');
    expect(controller).toContain('async forOrders(ctx)');
    expect(controller).toContain('select: FOR_ORDERS_FIELDS');
    expect(controller).toContain("require('../services/for-orders')");
  });

  it('authenticated users are granted it — an ungranted custom route 403s', () => {
    const matrix = read('services', 'bootstrap-permissions.js');
    expect(matrix).toMatch(/contacts: \[[^\]]*'forOrders'/);
  });
});
