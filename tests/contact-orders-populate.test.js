'use strict';

/**
 * The "Sòcies" column in ContactsTable rendered "-" for every contact.
 *
 * It shows `owners_flattened`, built by GET /api/contacts/orders from
 * `order.owner`. That query populated only `{ contact: true }`, so in v5
 * `order.owner` was undefined and the accumulation branch never ran. v3
 * returned owner as an FK column, which is why the same code worked there —
 * note the original comparison `o.id === order.owner`, treating it as an id.
 *
 * The neighbouring "Rutes" column kept working because `routes` is matched on
 * `contact.city`, a scalar, so the table looked selectively broken.
 *
 * diligencia at the time: 13,571 orders in the last year, every one with an
 * owner, 43 distinct owners, 831 contacts that should list at least one.
 */

const fs = require('fs');
const path = require('path');

const SRC = path.join(__dirname, '..', 'src');
const read = (...p) => fs.readFileSync(path.join(SRC, ...p), 'utf8');

const controller = read('api', 'contact', 'controllers', 'contact.js');
const orderAttrs = JSON.parse(
  read('api', 'order', 'content-types', 'order', 'schema.json')
).attributes;

describe('contacts/orders owner aggregation', () => {
  it('order.owner is a relation — the assumption this rests on', () => {
    expect(orderAttrs.owner).toBeDefined();
    expect(orderAttrs.owner.type).toBe('relation');
  });

  it('populates owner alongside contact', () => {
    expect(controller).toContain('populate: { contact: true, owner: true }');
  });

  it('reads the populated object, not a bare FK id', () => {
    // the v3-shaped comparison that silently never matched in v5
    expect(controller).not.toContain('o.id === order.owner');
    expect(controller).not.toContain('{ id: order.owner, name:');
    expect(controller).toContain('contact.owners.find((o) => o.id === owner.id)');
  });

  it('no longer scans the entire user table to resolve a name', () => {
    expect(controller).not.toContain("query('plugin::users-permissions.user').findMany({})");
    expect(controller).toContain('owner.username');
  });
});

describe('contacts/withorders', () => {
  it('populates the contact relations the table renders', () => {
    // ContactsTable pushes contacts from this endpoint that /basic did not
    // return, and they go through the same columns.
    expect(controller).toContain('populate: { contact: { populate: BASIC_POPULATE } }');
  });
});
