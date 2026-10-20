'use strict';

/**
 * issues/260 (2026-10-20): the Ingressos/Despeses «Tipus» filter asked for the
 * other document kinds with `_limit=0` (v3: no rows). `dbLimit` passed 0 to
 * db.query, which ignores a falsy limit, so `/emitted-invoices/basic?_limit=0`
 * returned EVERY invoice and the list, KPIs and export mixed in other types.
 * The front no longer sends it; the /basic endpoints answer [] again, as in v3.
 */

const { adaptQuery, wantsNoRows, dbLimit } = require('../src/services/query-adapter');

const TYPES = ['emitted-invoice', 'received-income', 'received-invoice', 'received-expense'];

describe('wantsNoRows', () => {
  it('is true only for _limit=0', () => {
    expect(wantsNoRows(adaptQuery({ _limit: '0' }))).toBe(true);
    expect(wantsNoRows(adaptQuery({ _limit: '-1' }))).toBe(false);
    expect(wantsNoRows(adaptQuery({ _limit: '25' }))).toBe(false);
    expect(wantsNoRows(adaptQuery({}))).toBe(false);
    expect(dbLimit(adaptQuery({ _limit: '-1' }))).toBeUndefined();
  });
});

describe.each(TYPES)('%s/basic?_limit=0', (type) => {
  beforeEach(() => jest.resetModules());

  const controllerWith = (findMany) => {
    const strapi = { db: { query: jest.fn(() => ({ findMany })) } };
    global.strapi = strapi;
    jest.doMock('@strapi/strapi', () => ({
      factories: { createCoreController: (_uid, cfg) => cfg({ strapi }) },
    }));
    return require(`../src/api/${type}/controllers/${type}`);
  };

  it('returns no rows without querying', async () => {
    const findMany = jest.fn().mockResolvedValue([{ id: 1 }, { id: 2 }]);
    const controller = controllerWith(findMany);
    expect(await controller.findBasic({ query: { _limit: '0', _where: { emitted_gte: '2026-01-01' } } })).toEqual([]);
    expect(findMany).not.toHaveBeenCalled();
  });

  it('still returns every row for _limit=-1', async () => {
    const findMany = jest.fn().mockResolvedValue([{ id: 1 }, { id: 2 }]);
    const controller = controllerWith(findMany);
    expect(await controller.findBasic({ query: { _limit: '-1' } })).toHaveLength(2);
  });
});
