/**
 * issues/135 (2026-10-18): «Esborrar projecte» sends a project to the trash
 * (`trashed`). Lists and reports left it out, but its mother still added it
 * into her totals, and a project whose children were all trashed stayed a
 * mother (`is_mother`, «Projectes mare»). Guards the mother's totals in the
 * list, the flag kept by the lifecycles when a child goes to the trash, and
 * the startup script that repairs the stored flags.
 */
const PROJECT = 'api::project.project';

// in-memory projects table, with the where clauses these paths use
const matches = (row, where = {}) =>
  Object.entries(where).every(([key, cond]) => {
    if (key === '$or') return cond.some((c) => matches(row, c));
    if (key === 'mother') return (row.mother && row.mother.id) === cond;
    return row[key] === cond;
  });

function fakeDb(rows) {
  const updates = [];
  const tableUpdates = [];
  const db = {
    query: () => ({
      findMany: jest.fn(async ({ where } = {}) => rows.filter((r) => matches(r, where))),
      findOne: jest.fn(async ({ where }) => rows.find((r) => matches(r, where)) || null),
      count: jest.fn(async ({ where }) => rows.filter((r) => matches(r, where)).length),
      update: jest.fn(async ({ where, data }) => updates.push({ id: where.id, ...data })),
    }),
    metadata: { get: () => ({ tableName: 'projects' }) },
    connection: () => ({
      whereIn: (col, ids) => ({ update: async (data) => tableUpdates.push({ ids, ...data }) }),
    }),
  };
  return { db, updates, tableUpdates };
}

const rows = () => [
  { id: 1, name: 'Mare', is_mother: true, trashed: false },
  { id: 2, mother: { id: 1 }, trashed: false, total_real_hours: 10, total_real_incomes_expenses: 100 },
  { id: 3, mother: { id: 1 }, trashed: true, total_real_hours: 100, total_real_incomes_expenses: 1000 },
  { id: 4, mother: { id: 1 }, trashed: null, total_real_hours: 5, total_real_incomes_expenses: 50 },
];

beforeEach(() => {
  jest.resetModules();
});

afterEach(() => {
  delete global.strapi;
});

describe('trashed children of a mother project (issues/135)', () => {
  it('are left out of the mother\'s totals in the list', async () => {
    const data = rows();
    jest.doMock('@strapi/strapi', () => ({
      factories: {
        createCoreController: (uid, build) => (args) =>
          Object.setPrototypeOf(build(args), { find: async () => ({ data: [{ ...data[0] }], meta: {} }) }),
      },
    }));
    const { db } = fakeDb(data);
    global.strapi = { db, contentType: () => ({ attributes: {} }), log: { error: jest.fn() } };
    const controller = require('../src/api/project/controllers/project')({ strapi: global.strapi });

    const response = await controller.find({ query: {}, state: {} });

    expect(response.data[0].total_real_hours).toBe(15);
    expect(response.data[0].total_real_incomes_expenses).toBe(150);
  });

  it('a child going to the trash clears is_mother when it was the last one', async () => {
    const data = rows().filter((r) => r.id !== 4 && r.id !== 3);
    const { db, updates } = fakeDb(data);
    global.strapi = { db };
    const lifecycles = require('../src/api/project/content-types/project/lifecycles');

    data[1].trashed = true; // what the update wrote
    await lifecycles.afterUpdate({ params: { where: { id: 2 }, data: { trashed: true } }, state: { oldMotherId: 1 } });

    expect(updates).toEqual([{ id: 1, is_mother: false }]);
  });

  it('beforeUpdate remembers the mother when only the trash state changes', async () => {
    const data = rows();
    jest.doMock('../src/services/component-refs', () => ({ resolveComponentRefs: jest.fn() }));
    const { db } = fakeDb(data);
    global.strapi = { db, contentType: () => ({ attributes: {} }), controller: () => ({ calculateProject: async () => ({}) }) };
    const lifecycles = require('../src/api/project/content-types/project/lifecycles');

    const event = { params: { where: { id: 2 }, data: { trashed: true } }, state: {} };
    await lifecycles.beforeUpdate(event);

    expect(event.state.oldMotherId).toBe(1);
  });

  it('the startup script sets is_mother from the live children only', async () => {
    const data = [
      { id: 1, is_mother: true, trashed: false }, // only a trashed child: cleared
      { id: 2, mother: { id: 1 }, trashed: true },
      { id: 5, is_mother: false, trashed: false }, // a live child: set
      { id: 6, mother: { id: 5 }, trashed: null },
      { id: 7, is_mother: true, trashed: false }, // right already: untouched
      { id: 8, mother: { id: 7 }, trashed: false },
    ];
    const { db, tableUpdates } = fakeDb(data);
    global.strapi = { db, log: { info: jest.fn() } };
    const { recountMotherFlags } = require('../src/services/recount-mother-flags');

    expect(await recountMotherFlags()).toEqual({ on: [5], off: [1] });
    expect(tableUpdates).toEqual([{ ids: [5], is_mother: true }, { ids: [1], is_mother: false }]);
  });
});
