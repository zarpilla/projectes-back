'use strict';

/**
 * Reported from production diligencia: "les comandes de recollida no
 * s'agrupen" — every collection order was created separately instead of
 * reusing the existing one for the same owner, point, route and date.
 *
 * processCollectionOrder looks for a reusable collection order, then narrows
 * the result with:
 *
 *   const candidateRouteId = extractId(co.collection_pickup_route) || extractId(co.route);
 *   return candidatePickupDate === collectionPickupDate && candidateRouteId === groupingRouteId;
 *
 * Those are relations. v3 returned them as FK columns, so `co.route` was the
 * id. v5 omits an unpopulated relation entirely, so both were undefined,
 * extractId returned null, the comparison never matched, and the lookup always
 * came back empty.
 *
 * Production bore it out: 8 collection orders in one day, 7 sharing a pickup
 * date, each with exactly 1 child — against v3's 414 collection orders
 * averaging 2.39 children (max 12). Verified against the dev database that the
 * same rows go from candidateRouteId=null to 25, 3, 25, 25, 25, 25.
 */

const fs = require('fs');
const path = require('path');

const SRC = path.join(__dirname, '..', 'src');
const lifecycles = fs.readFileSync(
  path.join(SRC, 'api', 'order', 'content-types', 'order', 'lifecycles.js'),
  'utf8'
);

/** The real extractId, pulled from the lifecycles file. */
function loadExtractId() {
  const start = lifecycles.indexOf('const extractId =');
  const end = lifecycles.indexOf('\n};', start) + 3;
  // eslint-disable-next-line no-new-func
  return new Function(`${lifecycles.slice(start, end)}; return extractId;`)();
}

const extractId = loadExtractId();

/** The predicate the reuse filter applies, in terms of what a row carries. */
const candidateRouteId = (co) => extractId(co.collection_pickup_route) || extractId(co.route);

/** Source of the call that looks for a reusable collection order. */
function groupingLookupSource() {
  const start = lifecycles.indexOf('const existingCollectionOrdersRaw');
  expect(start).toBeGreaterThan(-1);
  return lifecycles.slice(start, lifecycles.indexOf('});', start) + 3);
}

describe('the reuse predicate', () => {
  it('resolves a populated relation object to its id', () => {
    expect(candidateRouteId({ route: { id: 25 } })).toBe(25);
  });

  it('resolves a bare FK id, which is what v3 returned', () => {
    expect(candidateRouteId({ route: 25 })).toBe(25);
  });

  it('prefers collection_pickup_route over route', () => {
    expect(candidateRouteId({ collection_pickup_route: { id: 9 }, route: { id: 25 } })).toBe(9);
  });

  it('yields null when the relation is unpopulated — the bug', () => {
    expect(candidateRouteId({ collection_pickup_route: undefined, route: undefined })).toBeNull();
    // null never equals a real grouping route id, so nothing was ever reused
    expect(candidateRouteId({ route: undefined }) === 25).toBe(false);
  });
});

describe('queries that dereference a relation populate it', () => {
  it('the collection-order lookup populates both route relations', () => {
    const q = groupingLookupSource();
    expect(q).toContain('collection_pickup_route: true');
    expect(q).toContain('route: true');
  });

  it('the city-route lookup populates route, which it then reads', () => {
    // calculateRouteForCollectionPoint maps cr.route -> id
    expect(lifecycles).toContain("where: { city: cityId }, populate: { route: true }");
    expect(lifecycles).toContain('cr.route.id');
  });

  it('every route fetch feeding a transfer_pickup read populates it', () => {
    // the two sites that dereference route.transfer_pickup
    const reads = lifecycles.match(/extractId\(route\.transfer_pickup\)/g) || [];
    expect(reads.length).toBeGreaterThan(0);
    const populated = lifecycles.match(/populate: \{ transfer_pickup: true \}/g) || [];
    expect(populated.length).toBeGreaterThanOrEqual(reads.length);
  });

  it('no bare route findOne remains next to a transfer_pickup read', () => {
    expect(lifecycles).not.toMatch(
      /findOne\(\{ where: \{ id: routeId \} \}\);\s*\n\s*const transferPickupId/
    );
  });
});

/**
 * Reported from production diligencia on 2026-10-06: order 24876 (and 24874,
 * 24877–24883) had no collection order, while their collection order 24875
 * picked up only 24886, the last one created that day.
 *
 * Reusing a collection order wrote `collection_orders: [...current, id]`, with
 * `current` read off a row that never populated it — so `[id]`. In v5 a plain
 * array REPLACES the relation: each new order unlinked every one grouped
 * before it. Verified against a production copy: setting [24876] on 24875
 * dropped 24886; `{ connect: [24876] }` kept it.
 *
 * The order hooks also re-read orders without their relations, so an edited
 * order was never regrouped and the collection order's totals were never
 * refreshed.
 */
describe('grouping adds to a collection order without unlinking the rest', () => {
  it('connects the new order instead of replacing collection_orders', () => {
    expect(lifecycles).toContain('updateData.collection_orders = { connect: [orderIdToAdd] }');
    expect(lifecycles).not.toMatch(/updateData\.collection_orders = \[/);
  });

  it('the order hooks re-read orders with the collection relations', () => {
    const populate = lifecycles.slice(
      lifecycles.indexOf('const COLLECTION_RELATIONS = {'),
      lifecycles.indexOf('};', lifecycles.indexOf('const COLLECTION_RELATIONS = {')),
    );
    for (const relation of ['collection_point', 'collection_order', 'collection_pickup_route', 'owner']) {
      expect(populate).toContain(`${relation}: true`);
    }
    for (const hook of ['afterCreate', 'beforeUpdate', 'afterUpdate', 'beforeDelete']) {
      const start = lifecycles.indexOf(`async ${hook}(event)`);
      const body = lifecycles.slice(start, lifecycles.indexOf('\n  },', start));
      expect(body).toContain('findWithCollectionRelations(');
      expect(body).not.toMatch(/findOne\(\{ where: \{ id: (params|result)\.id \} \}\)/);
    }
  });

  it('beforeDelete keeps its state off the delete where clause', () => {
    expect(lifecycles).not.toContain('params._deletedOrderCollectionOrder');
  });
});
