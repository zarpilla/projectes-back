'use strict';

/**
 * issues/330 (2026-10-24): `phase-incomes/assigned` (Ingressos) and
 * `phase-expenses/assigned` (Despeses) answer only the ids of the documents
 * assigned to budget lines, but populated every assigned invoice, income and
 * expense whole, of every year: 0.1–0.2 s and 2–3.5 MB locally, p50 0.4–0.7 s
 * and up to 2.8 s on the VPS, the slowest request of Ingressos. They now read
 * the ids only; the answer is the same.
 */

const CASES = [
  ['phase-income', 'income', 'incomes'],
  ['phase-expense', 'expense', 'expenses'],
];

describe.each(CASES)('%s/assigned (issues/330)', (type, relation, key) => {
  let findMany;
  let controller;

  beforeEach(() => {
    jest.resetModules();
    findMany = jest.fn().mockResolvedValue([
      { id: 1, [relation]: { id: 10 }, invoice: null },
      { id: 2, [relation]: null, invoice: { id: 20 } },
      { id: 3, [relation]: null, invoice: null },
      { id: 4, [relation]: { id: 11 }, invoice: { id: 21 } },
    ]);
    const strapi = { db: { query: jest.fn(() => ({ findMany })) } };
    global.strapi = strapi;
    jest.doMock('@strapi/strapi', () => ({
      factories: { createCoreController: (_uid, cfg) => cfg({ strapi }) },
    }));
    controller = require(`../src/api/${type}/controllers/${type}`);
  });

  afterEach(() => {
    delete global.strapi;
    jest.dontMock('@strapi/strapi');
  });

  it('reads only the ids of the budget lines and their documents', async () => {
    await controller.findAssigned({ query: { _limit: '-1' } });
    const args = findMany.mock.calls[0][0];
    expect(args.select).toEqual(['id']);
    expect(args.populate).toEqual({ [relation]: { select: ['id'] }, invoice: { select: ['id'] } });
  });

  it('answers the ids as before', async () => {
    const body = await controller.findAssigned({ query: { _limit: '-1' } });
    expect(body).toEqual({ [key]: [10, 11], invoices: [20, 21] });
  });
});
