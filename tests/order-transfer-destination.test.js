'use strict';

/**
 * issues/156 (2026-10-18): in Transferències 48 of the 82 live transfers of the
 * logistics copy showed «Destinació -», although their routes have a transfer
 * destination (`route.transfer_pickup`).
 *
 * checkTransferNeededForCollectionOrder (order lifecycles) read the route and
 * the pickup without populating their relations. v3 returned them as FK
 * columns; v5 omits an unpopulated relation, so `route.transfer_pickup` was
 * undefined (the destination saved as null) and `pickup.city` too (a pickup
 * outside the route's towns was never seen as needing a transfer).
 */

// v5 shape: a relation is on the row only when populated
const ROUTES = { 7: { id: 7, name: 'Ruta Barcelona', transfer_pickup: { id: 30, name: 'Magatzem Girona' } } };
const PICKUPS = {
  3: { id: 3, name: 'Artés', pickup: false, city: { id: 50, name: 'Artés' } },
  4: { id: 4, name: 'Finca', pickup: true, city: null },
};

const withPopulated = (row, populate) => {
  if (!row) return null;
  const out = {};
  for (const [key, value] of Object.entries(row)) {
    const isRelation = value !== null && typeof value === 'object';
    if (!isRelation || (populate && populate[key])) out[key] = value;
  }
  return out;
};

function stubStrapi() {
  global.strapi = {
    log: { info: jest.fn(), warn: jest.fn(), error: jest.fn() },
    db: {
      query: jest.fn((uid) => ({
        findOne: jest.fn(async ({ where, populate }) => {
          if (uid === 'api::route.route') return withPopulated(ROUTES[where.id], populate);
          if (uid === 'api::pickup.pickup') return withPopulated(PICKUPS[where.id], populate);
          if (uid === 'api::contact.contact') return { id: where.id, city: 'Vic' };
          return null;
        }),
        findMany: jest.fn(async ({ where }) => {
          if (uid === 'api::city.city') return where.name === 'Vic' ? [{ id: 60, name: 'Vic' }] : [];
          // the route serves neither Artés nor Vic
          if (uid === 'api::city-route.city-route') return [];
          return [];
        }),
      })),
    },
  };
}

describe('transfer destination of an order (issues/156)', () => {
  let helpers;
  beforeEach(() => {
    jest.resetModules();
    stubStrapi();
    helpers = require('../src/api/order/content-types/order/lifecycles').collectionOrderHelpers;
  });

  it("takes the destination from the route's transfer pickup (farm order with a collection point)", async () => {
    const info = await helpers.checkTransferNeededForCollectionOrder(4, 7, { collection_point: 99 });
    expect(info).toEqual({ transfer: true, transfer_pickup_origin: 4, transfer_pickup_destination: 30 });
  });

  it("sees a transfer from a pickup whose town the route doesn't serve", async () => {
    const info = await helpers.checkTransferNeededForCollectionOrder(3, 7, {});
    expect(info).toEqual({ transfer: true, transfer_pickup_origin: 3, transfer_pickup_destination: 30 });
  });
});
