'use strict';

/**
 * issues/156 — startup script that gives the transfers saved without a
 * destination (route read unpopulated in the order lifecycles) the transfer
 * pickup of their route.
 */

let inserted;
let findManyArgs;

const orders = [
  // saved on v5 without destination: fixed
  { id: 1, transfer_pickup_destination: null, route: { id: 7, transfer_pickup: { id: 30 } } },
  // already has one: untouched
  { id: 2, transfer_pickup_destination: { id: 31 }, route: { id: 7, transfer_pickup: { id: 30 } } },
  // route without a transfer pickup: nothing to set
  { id: 3, transfer_pickup_destination: null, route: { id: 8, transfer_pickup: null } },
  // no route
  { id: 4, transfer_pickup_destination: null, route: null },
];

beforeEach(() => {
  jest.resetModules();
  inserted = [];
  const connection = jest.fn((table) => ({
    insert: async (rows) => inserted.push({ table, rows }),
  }));
  global.strapi = {
    log: { info: jest.fn() },
    db: {
      query: jest.fn(() => ({
        findMany: jest.fn(async (args) => {
          findManyArgs = args;
          return orders;
        }),
      })),
      metadata: {
        get: () => ({
          attributes: {
            transfer_pickup_destination: {
              joinTable: {
                name: 'orders_transfer_pickup_destination_lnk',
                joinColumn: { name: 'order_id' },
                inverseJoinColumn: { name: 'pickup_id' },
              },
            },
          },
        }),
      },
      connection,
    },
  };
});

describe('backfillTransferDestinations (issues/156)', () => {
  it("links each transfer without destination to its route's transfer pickup", async () => {
    const { backfillTransferDestinations } = require('../src/services/backfill-transfer-destinations');
    const fixes = await backfillTransferDestinations();
    expect(findManyArgs.where).toEqual({ transfer: true });
    expect(fixes).toEqual([{ order: 1, pickup: 30 }]);
    expect(inserted).toEqual([
      { table: 'orders_transfer_pickup_destination_lnk', rows: [{ order_id: 1, pickup_id: 30 }] },
    ]);
  });

  it('writes nothing when every transfer has its destination', async () => {
    orders.splice(0, 1);
    const { backfillTransferDestinations } = require('../src/services/backfill-transfer-destinations');
    expect(await backfillTransferDestinations()).toEqual([]);
    expect(inserted).toEqual([]);
  });
});
