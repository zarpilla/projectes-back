'use strict';

/**
 * Regression: changing an order's delivery day did not apply or remove the
 * multidelivery discount (Salt i Oli 24744 -> 24738; El Rebost 24740 / 24780).
 *
 * Three v5 differences kept the backend from ever recomputing it:
 *   - `me` was read with a bare findOne(): orders_options is a component and
 *     came back missing, so the discount read as unset and both passes
 *     returned before doing anything;
 *   - extractId did not understand v5 relation operations ({ set: [{ id }] }),
 *     so the owner of the saved order came out null;
 *   - the rows the hooks re-read were unpopulated, so the contact / owner /
 *     route that key the old and new date groups were missing.
 */

const fs = require('fs');
const path = require('path');

const SRC = fs.readFileSync(
  path.join(__dirname, '..', 'src', 'api', 'order', 'content-types', 'order', 'lifecycles.js'),
  'utf8',
);

function loadExtractId() {
  const start = SRC.indexOf('const extractId =');
  const end = SRC.indexOf('\n};', start) + 3;
  const { relationId } = require('../src/services/relation-input');
  // eslint-disable-next-line no-new-func
  return new Function('relationId', `${SRC.slice(start, end)}; return extractId;`)(relationId);
}

const extractId = loadExtractId();

describe('extractId', () => {
  it('reads ids, numeric strings and populated objects as before', () => {
    expect(extractId(65)).toBe(65);
    expect(extractId('65')).toBe(65);
    expect(extractId({ id: 65 })).toBe(65);
    expect(extractId(null)).toBeNull();
  });

  it('reads the relation operations v5 hands db lifecycles', () => {
    expect(extractId({ set: [{ id: 473 }] })).toBe(473);
    expect(extractId({ connect: [{ id: 473 }] })).toBe(473);
    expect(extractId({ set: [] })).toBeNull();
  });
});

describe('multidelivery passes', () => {
  it('read orders_options through getMe, never a bare me findOne()', () => {
    expect(SRC).not.toMatch(/query\('api::me\.me'\)\.findOne\(\)/);
    expect(SRC.match(/getMe\(\{ orders_options: true \}\)/g)).toHaveLength(2);
  });

  it('give the other-orders passes populated contact / owner / route', () => {
    expect(SRC).toContain('const DISCOUNT_RELATIONS = { contact: true, owner: true, route: true };');
    expect(SRC).toMatch(/processMultideliveryDiscountForOtherOrders\(params\.id, currentWithRelations, previousWithRelations\)/);
    expect(SRC).toMatch(/const previousOrder = await findWithDiscountRelations\(result\.id\);/);
  });
});
