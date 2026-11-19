'use strict';

/**
 * issues/436 (resilience-earth, 2026-11-13): the capital contributions entered
 * in Contactes from a cut-off date on (Configuració › «Aportacions de capital a
 * Tresoreria a partir del») show in Tresoreria as «Aportació de capital <nom>».
 * What counts is when a contribution was ENTERED, not its date: the ones
 * entered before were already recorded in Tresoreria by hand and must not be
 * duplicated; a backdated one entered after the cut-off does go. The
 * annotation follows the contribution (changed, deleted) and the contact.
 */
const path = require('path');

const SERVICE = path.join(__dirname, '..', 'src', 'services', 'capital-treasury.js');
const CONTACT_LIFECYCLES = path.join(
  __dirname,
  '..',
  'src',
  'api',
  'contact',
  'content-types',
  'contact',
  'lifecycles.js',
);

const CONTACT = 'api::contact.contact';
const TREASURY = 'api::treasury.treasury';
const ME = 'api::me.me';

/** A tiny in-memory db: one contact, `me` options and the treasury rows. */
function fakeStrapi({ cutoff = '2026-11-13', contact, treasuries = [] } = {}) {
  const state = { cutoff, contact, treasuries: treasuries.map((t) => ({ ...t })), nextId: 100 };
  const matches = (t, where) =>
    (where.id === undefined || t.id === where.id) &&
    (where.contact === undefined || t.contact === where.contact) &&
    (!where.capital_contribution_id || (t.capital_contribution_id !== null && t.capital_contribution_id !== undefined));
  const queries = {
    [ME]: { findOne: jest.fn(async () => ({ id: 1, options: { capital_treasury_from: state.cutoff } })) },
    [CONTACT]: {
      findOne: jest.fn(async () => state.contact),
      findMany: jest.fn(async () => (state.contact ? [{ id: state.contact.id }] : [])),
      update: jest.fn(async () => ({})),
    },
    [TREASURY]: {
      findMany: jest.fn(async ({ where }) =>
        state.treasuries.filter((t) => matches(t, where)).map((t) => ({ ...t, contact: { id: t.contact } })),
      ),
      create: jest.fn(async ({ data }) => {
        const row = { id: state.nextId++, ...data };
        state.treasuries.push(row);
        return row;
      }),
      update: jest.fn(async ({ where, data }) => {
        const row = state.treasuries.find((t) => t.id === where.id);
        Object.assign(row, data);
        return row;
      }),
      delete: jest.fn(async ({ where }) => {
        state.treasuries = state.treasuries.filter((t) => t.id !== where.id);
      }),
    },
  };
  global.strapi = {
    db: { query: (uid) => queries[uid] },
    log: { info: jest.fn() },
  };
  return { state, queries };
}

const BEFORE = '2026-11-10T09:00:00';
const AFTER = '2026-11-18T09:00:00';

describe('capital contributions in Tresoreria (issues/436)', () => {
  beforeEach(() => {
    jest.resetModules();
  });

  test('a new row is stamped; a row sent back keeps its stamp (or none), whatever the request says', () => {
    const { stampEnteredAt } = require(SERVICE);
    const now = new Date('2026-11-19T10:00:00');
    const rows = [
      { id: 1, date: '2024-01-01', amount: 100, entered_at: '2026-11-19T00:00:00' }, // forged
      { id: 2, date: '2026-11-18', amount: 10 },
      { date: '2026-11-01', amount: 20 },
      { id: 999, date: '2026-11-01', amount: 5 }, // not one of this contact's rows
    ];
    stampEnteredAt(rows, [{ id: 1, entered_at: null }, { id: 2, entered_at: AFTER }], now);
    expect(rows[0]).not.toHaveProperty('entered_at');
    expect(rows[1].entered_at).toBe(AFTER);
    expect(rows[2].entered_at).toBe(now);
    expect(rows[3]).not.toHaveProperty('id');
    expect(rows[3].entered_at).toBe(now);
  });

  test('only rows entered from the cut-off go, backdated ones too; concept with the name', () => {
    const { expectedAnnotations } = require(SERVICE);
    const contact = {
      id: 7,
      name: 'Anna Puig',
      capital_contributions: [
        { id: 1, date: '2024-01-01', amount: '100', entered_at: null }, // before this change
        { id: 2, date: '2026-11-12', amount: 50, entered_at: BEFORE }, // entered before the cut-off
        { id: 3, date: '2026-11-18', amount: '10.00', entered_at: AFTER },
        { id: 4, date: '2026-10-01', amount: 30, entered_at: AFTER }, // backdated, entered after
        { id: 5, date: '2026-11-18', amount: 0, entered_at: AFTER },
        { id: 6, date: null, amount: -25, entered_at: AFTER }, // a refund without date
      ],
    };
    expect(expectedAnnotations(contact, '2026-11-13')).toEqual([
      { capital_contribution_id: 3, total: 10, date: '2026-11-18', comment: 'Aportació de capital Anna Puig' },
      { capital_contribution_id: 4, total: 30, date: '2026-10-01', comment: 'Aportació de capital Anna Puig' },
      { capital_contribution_id: 6, total: -25, date: '2026-11-18', comment: 'Aportació de capital Anna Puig' },
    ]);
    expect(expectedAnnotations(contact, null)).toEqual([]);
  });

  test('the sync creates, updates and deletes the contact’s annotations only', async () => {
    const { state } = fakeStrapi({
      contact: {
        id: 7,
        name: 'Anna Puig',
        capital_contributions: [
          { id: 3, date: '2026-11-18', amount: 15, entered_at: AFTER }, // amount changed
          { id: 4, date: '2026-10-01', amount: 30, entered_at: AFTER }, // new
        ],
      },
      treasuries: [
        { id: 1, contact: 7, capital_contribution_id: 3, total: 10, date: '2026-11-18', comment: 'Aportació de capital Anna Puig' },
        { id: 2, contact: 7, capital_contribution_id: 9, total: 5, date: '2026-11-15', comment: 'Aportació de capital Anna Puig' }, // removed
        { id: 3, contact: null, capital_contribution_id: null, total: 500, date: '2026-11-01', comment: 'Manual' },
      ],
    });
    const { syncContactCapitalTreasury } = require(SERVICE);
    await expect(syncContactCapitalTreasury(7)).resolves.toEqual({ created: 1, updated: 1, deleted: 1 });
    expect(state.treasuries.map((t) => [t.id, t.capital_contribution_id, t.total, t.date])).toEqual([
      [1, 3, 15, '2026-11-18'],
      [3, null, 500, '2026-11-01'],
      [100, 4, 30, '2026-10-01'],
    ]);
    expect(state.treasuries[2]).toMatchObject({ contact: 7, comment: 'Aportació de capital Anna Puig' });
    // again: nothing to do
    await expect(syncContactCapitalTreasury(7)).resolves.toEqual({ created: 0, updated: 0, deleted: 0 });
  });

  test('with the option off nothing is created nor removed', async () => {
    const { state, queries } = fakeStrapi({
      cutoff: null,
      contact: { id: 7, name: 'Anna', capital_contributions: [{ id: 3, date: '2026-11-18', amount: 10, entered_at: AFTER }] },
      treasuries: [{ id: 1, contact: 7, capital_contribution_id: 9, total: 5, date: '2026-11-15', comment: 'x' }],
    });
    const { syncContactCapitalTreasury } = require(SERVICE);
    await syncContactCapitalTreasury(7);
    expect(queries[TREASURY].create).not.toHaveBeenCalled();
    expect(state.treasuries).toHaveLength(1);
  });

  test('the middleware stamps the rows before Strapi saves them', async () => {
    const { queries } = fakeStrapi({
      contact: { id: 7, capital_contributions: [{ id: 2, entered_at: AFTER }] },
    });
    const { stampCapitalContributions } = require(SERVICE);
    const data = { capital_contributions: [{ id: 2, amount: 10 }, { amount: 5 }] };
    const next = jest.fn(async () => 'saved');
    await expect(
      stampCapitalContributions({ uid: CONTACT, action: 'update', params: { documentId: 'abc', data } }, next),
    ).resolves.toBe('saved');
    expect(queries[CONTACT].findOne.mock.calls[0][0].where).toEqual({ documentId: 'abc' });
    expect(data.capital_contributions[0].entered_at).toBe(AFTER);
    expect(data.capital_contributions[1].entered_at).toBeInstanceOf(Date);
    // other content types are left alone
    const other = { capital_contributions: [{ amount: 1 }] };
    await stampCapitalContributions({ uid: 'api::order.order', action: 'update', params: { data: other } }, next);
    expect(other.capital_contributions[0]).not.toHaveProperty('entered_at');
  });

  test('Configuració saved with a new cut-off syncs every contact; the same one does not', async () => {
    const { state, queries } = fakeStrapi({
      cutoff: null,
      contact: { id: 7, name: 'Anna', capital_contributions: [{ id: 3, date: '2026-11-18', amount: 10, entered_at: AFTER }] },
    });
    const { syncOnCutoffChange } = require(SERVICE);
    const ctx = { uid: ME, action: 'update', params: { data: { options: { capital_treasury_from: '2026-11-13' } } } };
    await syncOnCutoffChange(ctx, async () => {
      state.cutoff = '2026-11-13';
    });
    expect(state.treasuries).toHaveLength(1);
    queries[TREASURY].create.mockClear();
    await syncOnCutoffChange(ctx, async () => {});
    expect(queries[CONTACT].findMany).toHaveBeenCalledTimes(1);
  });

  test('the contact lifecycles sync on a change of contributions or name, and clean up on delete', async () => {
    const { state } = fakeStrapi({
      contact: { id: 7, name: 'Anna Puig', capital_contributions: [{ id: 3, date: '2026-11-18', amount: 10, entered_at: AFTER }] },
      treasuries: [{ id: 1, contact: 7, capital_contribution_id: 3, total: 10, date: '2026-11-18', comment: 'Aportació de capital Anna' }],
    });
    // what beforeDelete also touches
    const refs = { findOne: jest.fn(async () => null), deleteMany: jest.fn(async () => ({})) };
    const query = global.strapi.db.query;
    global.strapi.db.query = (uid) => query(uid) || refs;
    const lifecycles = require(CONTACT_LIFECYCLES);
    await lifecycles.afterUpdate({ params: { data: { name: 'Anna Puig' } }, result: { id: 7 } });
    expect(state.treasuries[0].comment).toBe('Aportació de capital Anna Puig');
    await lifecycles.afterUpdate({ params: { data: { phone: '1' } }, result: { id: 7 } });
    await lifecycles.beforeDelete({ params: { where: { id: 7 } } });
    expect(state.treasuries).toHaveLength(0);
  });
});
