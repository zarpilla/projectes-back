'use strict';

/**
 * issues/328 — a project's stored totals and `dirty` moved from `projects` to
 * `project_totals`: every hours entry and every totals cron run wrote
 * `projects`, which made the read cache load again everything that read a
 * project (raiels: the Tresoreria forecast 8 times in 26 minutes). The API must
 * not change. Guards:
 *   - every project read gets its totals and dirty back (as numbers / booleans,
 *     null without a row), also on a whole populated mother; a read whose
 *     `select` names none of them gets nothing and reads nothing;
 *   - a project PUT keeps its computed totals (and the dirty sent by the form)
 *     out of the `projects` update and writes them to project_totals;
 *   - a new project is marked dirty; marking dirty and writing totals are
 *     upserts that join the transaction in progress;
 *   - at boot every project without a row gets one, dirty.
 */

const projectTotals = () => require('../src/api/project/services/project-totals');

let calls;

/** A knex-like stub recording what reaches project_totals / projects. */
function fakeKnex(tables) {
  const knex = (table) => {
    const q = { table, where: null, whereIn: null };
    const builder = {
      select: (...cols) => {
        q.select = cols;
        return builder;
      },
      whereIn: (col, ids) => {
        q.whereIn = [col, ids];
        return builder;
      },
      where: (w) => {
        q.where = w;
        return builder;
      },
      leftJoin: () => builder,
      whereNull: () => builder,
      count: async () => [{ n: (tables[table] || []).filter((r) => r.dirty).length }],
      insert: (rows) => ({
        onConflict: (col) => ({
          merge: async (cols) => calls.push({ table, insert: rows, onConflict: col, merge: cols, trx: knex.isTrx }),
        }),
      }),
      then: (resolve, reject) => {
        calls.push({ table, ...q, trx: knex.isTrx });
        let rows = tables[table] || [];
        if (q.whereIn) rows = rows.filter((r) => q.whereIn[1].includes(r[q.whereIn[0]]));
        if (q.where) rows = rows.filter((r) => Object.entries(q.where).every(([k, v]) => r[k] === v));
        return Promise.resolve(rows).then(resolve, reject);
      },
    };
    return builder;
  };
  knex.schema = { hasTable: async () => true };
  return knex;
}

function stub({ tables = {}, inTransaction = false } = {}) {
  calls = [];
  const pool = fakeKnex(tables);
  const trx = fakeKnex(tables);
  trx.isTrx = true;
  global.strapi = {
    db: {
      connection: pool,
      inTransaction: () => inTransaction,
      transaction: async (cb) => cb({ trx }),
    },
    log: { info: jest.fn(), warn: jest.fn() },
  };
}

beforeEach(() => {
  jest.resetModules();
});
afterEach(() => {
  delete global.strapi;
});

describe('reading the totals', () => {
  it('wantsTotals: yes without select or with one naming a total; no otherwise', () => {
    const { wantsTotals } = projectTotals();
    expect(wantsTotals({})).toBe(true);
    expect(wantsTotals({ select: '*' })).toBe(true);
    expect(wantsTotals({ select: ['id', 'balance'] })).toBe(true);
    expect(wantsTotals({ select: ['id', 'dirty'] })).toBe(true);
    expect(wantsTotals({ select: ['id', 'name', 'trashed'] })).toBe(false);
    expect(wantsTotals({ select: 'name' })).toBe(false);
  });

  it('gives numbers, booleans and nulls like the old columns', () => {
    const { fromRow, TOTAL_COLUMNS } = projectTotals();
    const r = fromRow({ balance: '12.50', total_real_hours: '3.00', dirty: 1, total_incomes: null });
    expect(r).toMatchObject({ balance: 12.5, total_real_hours: 3, total_incomes: null, dirty: true });
    const none = fromRow(undefined);
    expect(none.dirty).toBe(false);
    for (const c of TOTAL_COLUMNS) expect(none[c]).toBeNull();
    expect(TOTAL_COLUMNS).toEqual(expect.arrayContaining(['total_expenses_hours', 'total_expenses_vat', 'balance']));
  });

  it('attaches them in one query, also to a whole populated mother, never to an id-only one', async () => {
    stub({
      tables: {
        project_totals: [
          { project_id: 1, balance: '10.00', dirty: 0 },
          { project_id: 9, balance: '90.00', dirty: 1 },
        ],
      },
    });
    const projects = [
      { id: 1, name: 'a', mother: { id: 9, name: 'Mare' } },
      { id: 2, name: 'b', mother: { id: 9 } },
    ];
    await projectTotals().attachTotals(projects);
    expect(projects[0]).toMatchObject({ balance: 10, dirty: false });
    expect(projects[0].mother).toMatchObject({ balance: 90, dirty: true });
    expect(projects[1]).toMatchObject({ balance: null, dirty: false });
    expect(projects[1].mother).toEqual({ id: 9 });
    const reads = calls.filter((c) => c.table === 'project_totals');
    expect(reads).toHaveLength(1);
    expect(reads[0].whereIn[1].sort()).toEqual([1, 2, 9]);
  });
});

describe('writing them', () => {
  it('markDirty upserts only dirty, on the pool outside a transaction', async () => {
    stub();
    await projectTotals().markDirty([5, '6', 5, 0]);
    expect(calls).toEqual([
      {
        table: 'project_totals',
        insert: [
          { project_id: 5, dirty: true },
          { project_id: 6, dirty: true },
        ],
        onConflict: 'project_id',
        merge: ['dirty'],
        trx: undefined,
      },
    ]);
  });

  it('markDirty joins the transaction in progress (a project PUT)', async () => {
    stub({ inTransaction: true });
    await projectTotals().markDirty(5);
    expect(calls[0].trx).toBe(true);
  });

  it('writeTotals writes the totals given, and dirty only when asked', async () => {
    stub();
    const { writeTotals } = projectTotals();
    await writeTotals(5, { balance: 3, total_real_hours: 1, name: 'not a total' });
    await writeTotals(6, { balance: 4 }, { dirty: false });
    expect(calls[0].insert).toEqual({ project_id: 5, balance: 3, total_real_hours: 1 });
    expect(calls[0].merge.sort()).toEqual(['balance', 'total_real_hours']);
    expect(calls[0].insert).not.toHaveProperty('dirty');
    expect(calls[1].insert).toEqual({ project_id: 6, balance: 4, dirty: false });
    expect(calls[1].merge.sort()).toEqual(['balance', 'dirty']);
  });

  it('dirtyIds reads the queue from project_totals', async () => {
    stub({ tables: { project_totals: [{ project_id: 3, dirty: true }, { project_id: 4, dirty: false }] } });
    expect(await projectTotals().dirtyIds()).toEqual([3]);
  });
});

describe('the project lifecycles', () => {
  function lifecycles() {
    return require('../src/api/project/content-types/project/lifecycles');
  }

  it('afterFindMany / afterFindOne attach, unless the select leaves the totals out', async () => {
    stub({ tables: { project_totals: [{ project_id: 1, balance: '7.00', dirty: 0 }] } });
    const l = lifecycles();
    const many = { params: {}, result: [{ id: 1 }] };
    await l.afterFindMany(many);
    expect(many.result[0].balance).toBe(7);
    const one = { params: {}, result: { id: 1 } };
    await l.afterFindOne(one);
    expect(one.result.balance).toBe(7);
    const narrow = { params: { select: ['id', 'name'] }, result: [{ id: 1 }] };
    await l.afterFindMany(narrow);
    expect(narrow.result[0]).toEqual({ id: 1 });
    expect(calls.filter((c) => c.table === 'project_totals')).toHaveLength(2);
  });

  it('beforeUpdate keeps the totals and dirty out of the projects update; afterUpdate writes the totals', async () => {
    stub();
    global.strapi.contentType = () => ({ attributes: { name: { type: 'string' } } });
    global.strapi.db.query = () => ({ findOne: async () => ({ id: 7, name: 'Old', dirty: true }) });
    global.strapi.controller = () => ({
      calculateProject: async (project) => Object.assign(project, { total_incomes: 1500, balance: 20, dirty: true }),
    });
    const l = lifecycles();
    const event = { params: { where: { id: 7 }, data: { name: 'New', dirty: false, balance: 999 } }, state: {} };
    await l.beforeUpdate(event);
    expect(event.params.data.name).toBe('New');
    for (const c of ['total_incomes', 'balance', 'dirty']) expect(event.params.data).not.toHaveProperty(c);
    expect(event.state.totals).toMatchObject({ total_incomes: 1500, balance: 20 });
    expect(event.state.totals).not.toHaveProperty('dirty');

    await l.afterUpdate({ ...event, result: { id: 7 } });
    const write = calls.find((c) => c.insert);
    expect(write.insert).toMatchObject({ project_id: 7, total_incomes: 1500, balance: 20 });
    expect(write.insert).not.toHaveProperty('dirty');
  });

  it('afterCreate marks the new project dirty', async () => {
    stub();
    await lifecycles().afterCreate({ result: { id: 44 }, state: {} });
    expect(calls).toEqual([expect.objectContaining({ insert: [{ project_id: 44, dirty: true }], merge: ['dirty'] })]);
  });
});
