'use strict';

/**
 * issues/325 (2026-10-23): Despeses (ReceivedInvoicesTable) read a whole
 * period of received invoices, received expenses and payrolls with the core
 * find and populate=*: 3–9 s per load on resilience, single requests up to
 * 19 s, while every other request of the tenant waited. The lists now come
 * from GET /<type>/list: only what the screen shows and exports, kept in the
 * read cache (issues/307), with the projects (and a payroll's person) read on
 * every request, out of the cache.
 *
 * Guards: the narrow populate (no projects, bank account, series, payment
 * method or attachments in the kept rows); the filters of the query adapter;
 * rows by id unless a sort is asked; one load per query; the projects / person
 * added on each request by the core populate of those relations, without
 * changing the kept rows; only full access reaches the lists.
 */

const RI = 'api::received-invoice.received-invoice';
const RE = 'api::received-expense.received-expense';
const PAYROLL = 'api::payroll.payroll';

// like the real cache: one load per key, every caller gets its own copy
function fakeReadCache() {
  const kept = new Map();
  const calls = [];
  return {
    calls,
    kept,
    get: async (key, loader, opts) => {
      calls.push({ key, opts });
      if (!kept.has(key)) kept.set(key, await loader());
      return structuredClone(kept.get(key));
    },
  };
}

function load({ rows = {}, live = {} } = {}) {
  jest.resetModules();
  const cache = fakeReadCache();
  const findMany = jest.fn(async (uid, args) => {
    // the live read: by ids, select id, populate the live relations
    if (args.where && args.where.id && args.where.id.$in)
      return (live[uid] || []).filter((r) => args.where.id.$in.includes(r.id));
    return rows[uid] || [];
  });
  global.strapi = { db: { query: jest.fn((uid) => ({ findMany: (args) => findMany(uid, args) })) } };
  const queryTables = jest.fn(() => new Set(['received_invoices']));
  jest.doMock('../src/services/read-cache', () => ({ getReadCache: () => cache }));
  jest.doMock('../src/services/query-tables', () => ({ queryTables }));
  const lists = require('../src/services/expense-lists');
  return { lists, cache, findMany, queryTables };
}

afterEach(() => {
  delete global.strapi;
  jest.dontMock('../src/services/read-cache');
  jest.dontMock('../src/services/query-tables');
});

const YEAR = { _limit: '-1', _where: { emitted_gte: '2025-01-01' }, emitted_lte: '2025-12-31' };

describe('Despeses lists (issues/325)', () => {
  it('keeps the invoices with only what the screen reads, filtered as find, by id', async () => {
    const { lists, findMany } = load({ rows: { [RI]: [{ id: 2, code: 'F2' }] } });
    await lists.expenseList(RI, { ...YEAR, contact_eq: '336' });

    const [uid, args] = findMany.mock.calls[0];
    expect(uid).toBe(RI);
    expect(Object.keys(args.populate).sort()).toEqual(['contact', 'contact_info', 'lines']);
    expect(args.populate.contact.select).toEqual(['id', 'name', 'nif', 'address', 'postcode', 'city']);
    expect(JSON.stringify(args.where)).toContain('2025-01-01');
    expect(JSON.stringify(args.where)).toContain('2025-12-31');
    expect(JSON.stringify(args.where)).toContain('336');
    expect(args.orderBy).toEqual([{ id: 'asc' }]);
    expect(args.limit).toBeUndefined();
  });

  it('keeps the document type of an expense too', async () => {
    const { lists, findMany } = load();
    await lists.expenseList(RE, YEAR);
    expect(Object.keys(findMany.mock.calls[0][1].populate).sort()).toEqual([
      'contact',
      'contact_info',
      'document_type',
      'lines',
    ]);
    expect(findMany.mock.calls[0][1].populate.document_type.select).toEqual(['id', 'name']);
  });

  it('keeps a sort the caller asked for', async () => {
    const { lists, findMany } = load();
    await lists.expenseList(RI, { ...YEAR, _sort: 'emitted:DESC' });
    expect(JSON.stringify(findMany.mock.calls[0][1].orderBy)).toContain('emitted');
  });

  it('loads a query once; another query is another entry', async () => {
    const { lists, findMany, cache } = load({ rows: { [RI]: [] } });
    await lists.expenseList(RI, YEAR);
    await lists.expenseList(RI, YEAR);
    await lists.expenseList(RI, { ...YEAR, paid_date_null: 'true' });
    const loads = findMany.mock.calls.filter(([, a]) => !(a.where && a.where.id));
    expect(loads).toHaveLength(2);
    expect(new Set(cache.calls.map((c) => c.key)).size).toBe(2);
  });

  it('adds the projects on every request, by the core populate, without changing the kept rows', async () => {
    const live = {
      [RI]: [
        {
          id: 2,
          projects: [
            { id: 9, name: 'Nou nom' },
            { id: 4, name: 'Altre' },
          ],
          project: { id: 9, name: 'Nou nom' },
        },
        { id: 3, projects: [], project: null },
      ],
    };
    const { lists, findMany, cache } = load({
      rows: {
        [RI]: [
          { id: 2, code: 'F2' },
          { id: 3, code: 'F3' },
        ],
      },
      live,
    });

    const answer = await lists.expenseList(RI, YEAR);

    const liveCall = findMany.mock.calls.find(([, a]) => a.where && a.where.id);
    expect(liveCall[1].where.id.$in).toEqual([2, 3]);
    expect(liveCall[1].populate).toEqual({
      projects: { select: ['id', 'name'] },
      project: { select: ['id', 'name'] },
    });
    expect(answer[0].projects.map((p) => p.name)).toEqual(['Nou nom', 'Altre']);
    expect(answer[0].project.name).toBe('Nou nom');
    expect(answer[1].projects).toEqual([]);
    expect(answer[1].project).toBeNull();
    // the kept rows hold no project: a project renamed or marked dirty doesn't drop them
    expect([...cache.kept.values()][0][0].projects).toBeUndefined();
  });

  it("keeps a payroll's year and month, adds its person on every request", async () => {
    const live = {
      [PAYROLL]: [{ id: 5, users_permissions_user: { id: 7, username: 'anna', fullname: 'Anna' } }],
    };
    const { lists, findMany } = load({ rows: { [PAYROLL]: [{ id: 5, total: 100 }] }, live });
    const [row] = await lists.expenseList(PAYROLL, YEAR);
    expect(Object.keys(findMany.mock.calls[0][1].populate).sort()).toEqual(['month', 'year']);
    expect(row.users_permissions_user).toEqual({ id: 7, username: 'anna', fullname: 'Anna' });
  });

  it('declares to the cache only the tables of the kept rows', async () => {
    const { lists, queryTables, cache } = load();
    await lists.expenseList(RI, YEAR);
    expect(queryTables.mock.calls[0][1]).toBe(RI);
    expect(Object.keys(queryTables.mock.calls[0][2])).not.toContain('projects');
    expect(cache.calls[0].opts.tables).toEqual(['received_invoices']);
  });

  it('answers nothing for _limit=0, as find', async () => {
    const { lists, findMany } = load();
    expect(await lists.expenseList(RI, { _limit: '0' })).toEqual([]);
    expect(findMany).not.toHaveBeenCalled();
  });

  it('is open to full access only, like the documents themselves', () => {
    jest.resetModules();
    const { isAllowed } = require('../src/services/app-access-rules');
    for (const uid of [RI, RE, PAYROLL]) {
      expect(isAllowed(`${uid}.list`, ['projects'])).toBe(true);
      expect(isAllowed(`${uid}.list`, ['admin'])).toBe(true);
      for (const p of ['hours', 'orders', 'orders_admin', 'orders_delivery'])
        expect(isAllowed(`${uid}.list`, [p])).toBe(false);
    }
  });

  it.each([
    ['received-invoice', RI],
    ['received-expense', RE],
    ['payroll', PAYROLL],
  ])('GET /%s/list is routed to expenseList', (name, uid) => {
    jest.resetModules();
    const expenseList = jest.fn(async () => []);
    jest.doMock('../src/services/expense-lists', () => ({
      ...jest.requireActual('../src/services/expense-lists'),
      expenseList,
    }));
    jest.doMock('@strapi/strapi', () => ({
      factories: { createCoreController: (_uid, cfg) => cfg({ strapi: {} }) },
    }));
    const ctrl = require(`../src/api/${name}/controllers/${name}`);
    ctrl.list({ query: YEAR });
    expect(expenseList).toHaveBeenCalledWith(uid, YEAR);
    const routes = require(`../src/api/${name}/routes/01-custom-${name}`).routes;
    expect(routes.find((r) => r.handler === `${name}.list`)).toMatchObject({
      method: 'GET',
      path: expect.stringMatching(/\/list$/),
    });
    jest.dontMock('../src/services/expense-lists');
    jest.dontMock('@strapi/strapi');
  });
});
