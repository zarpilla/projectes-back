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

// contacts/orders no longer loads orders through the entity layer; its owner
// aggregation is covered against real SQL in contact-orders-summary.test.js.

describe('contacts/withorders', () => {
  it('populates the contact relations the table renders', () => {
    // ContactsTable pushes contacts from this endpoint that /basic did not
    // return, and they go through the same columns.
    // issues/326: the contacts are read once each, no longer through the orders
    expect(controller).toContain('contactsWithOrders(strapi, ctx.state.user.id, ctx.query.contact_id, BASIC_POPULATE)');
  });
});
