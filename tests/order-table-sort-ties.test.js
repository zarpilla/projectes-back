'use strict';

/**
 * issues/445 (2026-11-17, Diligència): the orders list pages /orders/table by
 * 150 sorted on one column (Punt d'entrega, Sòcia…). Several orders share the
 * value (multi-delivery points), and MySQL may order equal rows differently on
 * each query, so between pages an order showed twice and another one was
 * missing. The id now breaks the ties, in the direction of the sort.
 */

const path = require('path');

const src = (...parts) => path.join(__dirname, '..', 'src', ...parts);

function load() {
  jest.resetModules();
  const findMany = jest.fn(async () => []);
  global.strapi = { db: { query: jest.fn(() => ({ findMany })) } };
  jest.doMock('@strapi/strapi', () => ({
    factories: { createCoreController: (_uid, cfg) => cfg({ strapi: global.strapi }) },
  }));
  const ctrl = require(src('api', 'order', 'controllers', 'order'));
  return { ctrl, orderBy: () => findMany.mock.calls[0][0].orderBy };
}

afterEach(() => {
  delete global.strapi;
  jest.dontMock('@strapi/strapi');
});

describe('GET /orders/table sort ties (issues/445)', () => {
  it('breaks ties on a column by id, same direction', async () => {
    const { ctrl, orderBy } = load();
    await ctrl.table({ query: { _limit: '150', _start: '0', _sort: 'contact_trade_name:DESC' } });
    expect(orderBy()).toEqual([{ contact_trade_name: 'desc' }, { id: 'desc' }]);
  });

  it('breaks ties on a relation column by id', async () => {
    const { ctrl, orderBy } = load();
    await ctrl.table({ query: { _sort: 'owner.fullname:DESC' } });
    expect(orderBy()).toEqual([{ owner: { fullname: 'desc' } }, { id: 'desc' }]);
  });

  it('adds nothing when the sort is the id already', async () => {
    const { ctrl, orderBy } = load();
    await ctrl.table({ query: { _sort: 'id:DESC' } });
    expect(orderBy()).toEqual([{ id: 'desc' }]);
  });

  it('sorts by id with no sort given', async () => {
    const { ctrl, orderBy } = load();
    await ctrl.table({ query: {} });
    expect(orderBy()).toEqual([{ id: 'asc' }]);
  });
});
