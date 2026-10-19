'use strict';

/**
 * issues/215 — startup script that gives the delivery points saved without
 * «Nom comercial» their name as trade name. Contacts without an owner don't
 * need one; the query only asks for points.
 */

let updates;
let findManyArgs;

// what the query returns: delivery points only (owner not null)
const points = [
  // no trade name: takes the name
  { id: 1, name: 'Can Pep ', trade_name: null },
  // blank trade name: takes the name
  { id: 2, name: 'La Botiga', trade_name: '  ' },
  // already has one: untouched
  { id: 3, name: 'Fleca', trade_name: 'Fleca Sol' },
  // no name either: nothing to copy
  { id: 4, name: null, trade_name: null },
];

beforeEach(() => {
  jest.resetModules();
  updates = [];
  const connection = jest.fn((table) => ({
    where: (where) => ({ update: async (data) => updates.push({ table, where, data }) }),
  }));
  global.strapi = {
    log: { info: jest.fn() },
    db: {
      query: jest.fn(() => ({
        findMany: jest.fn(async (args) => {
          findManyArgs = args;
          return points;
        }),
      })),
      metadata: { get: () => ({ tableName: 'contacts' }) },
      connection,
    },
  };
});

describe('fillDeliveryPointTradeNames (issues/215)', () => {
  it('asks for the delivery points only (contacts with an owner)', async () => {
    const { fillDeliveryPointTradeNames } = require('../src/services/fill-delivery-point-trade-names');
    await fillDeliveryPointTradeNames();
    expect(findManyArgs.where).toEqual({ owner: { $notNull: true } });
  });

  it('copies the name into an empty or blank trade name, and nothing else', async () => {
    const { fillDeliveryPointTradeNames } = require('../src/services/fill-delivery-point-trade-names');
    const fixes = await fillDeliveryPointTradeNames();
    expect(fixes).toEqual([
      { id: 1, trade_name: 'Can Pep' },
      { id: 2, trade_name: 'La Botiga' },
    ]);
    expect(updates).toEqual([
      { table: 'contacts', where: { id: 1 }, data: { trade_name: 'Can Pep' } },
      { table: 'contacts', where: { id: 2 }, data: { trade_name: 'La Botiga' } },
    ]);
  });
});
