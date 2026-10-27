'use strict';

/**
 * A contact's capital contribution becomes a list (2026-10-25): date, amount and
 * comment per contribution (component partners.capital-contribution). The old
 * `partner_amount` / `partner_amount_date` become the total and the last date,
 * kept by the contact lifecycles, and the run-once `migratePartnerAmounts`
 * turns each contact's old amount and date into its first contribution
 * (diligencia has 33 contacts with an amount; none may be lost).
 */
const path = require('path');

const SERVICE = path.join(__dirname, '..', 'src', 'services', 'capital-contributions.js');
const LIFECYCLES = path.join(
  __dirname,
  '..',
  'src',
  'api',
  'contact',
  'content-types',
  'contact',
  'lifecycles.js',
);

describe('capital contributions', () => {
  beforeEach(() => {
    jest.resetModules();
  });

  test('rows are cleaned: empty ones dropped, comma amounts, bad amounts refused', () => {
    const { cleanContributions } = require(SERVICE);
    expect(
      cleanContributions([
        { id: 4, date: '2024-04-27', amount: '100', comment: ' Alta ' },
        { date: '', amount: '', comment: '' },
        { date: '2025-03-01', amount: '50,5' },
      ]),
    ).toEqual([
      { id: 4, date: '2024-04-27', amount: 100, comment: 'Alta' },
      { date: '2025-03-01', amount: 50.5, comment: null },
    ]);
    expect(() => cleanContributions([{ amount: 'abc' }])).toThrow('número');
    expect(() => cleanContributions([{ date: '27/04/2024' }])).toThrow('data');
    expect(cleanContributions(null)).toEqual([]);
  });

  test('the summary is the total and the last date', () => {
    const { summarize } = require(SERVICE);
    expect(
      summarize([
        { date: '2025-03-01', amount: '50.50' },
        { date: '2024-04-27', amount: 100 },
        { date: null, amount: 10 },
      ]),
    ).toEqual({ partner_amount: 160.5, partner_amount_date: '2025-03-01' });
    expect(summarize([])).toEqual({ partner_amount: null, partner_amount_date: null });
    // a date without amount keeps the date, as before
    expect(summarize([{ date: '2024-01-01', amount: null }])).toEqual({
      partner_amount: null,
      partner_amount_date: '2024-01-01',
    });
  });

  test('the migration moves every old amount and date, once', async () => {
    const updates = [];
    global.strapi = {
      log: { info: () => {} },
      db: {
        query: () => ({
          findMany: async () => [
            {
              id: 1,
              documentId: 'a',
              partner_amount: '200.00',
              partner_amount_date: '2023-05-02',
              capital_contributions: [],
            },
            {
              id: 2,
              documentId: 'b',
              partner_amount: '0.00',
              partner_amount_date: '2024-01-10',
              capital_contributions: [],
            },
            { id: 3, documentId: 'c', partner_amount: null, partner_amount_date: '2024-02-01' },
            // already migrated (a second instance booting): left alone
            {
              id: 4,
              documentId: 'd',
              partner_amount: '50.00',
              partner_amount_date: null,
              capital_contributions: [{ id: 9 }],
            },
          ],
        }),
      },
      documents: () => ({ update: async (args) => updates.push(args) }),
    };
    const { migratePartnerAmounts } = require(SERVICE);
    expect(await migratePartnerAmounts()).toEqual([1, 2, 3]);
    expect(updates).toEqual([
      {
        documentId: 'a',
        data: { capital_contributions: [{ date: '2023-05-02', amount: 200, comment: null }] },
      },
      {
        documentId: 'b',
        data: { capital_contributions: [{ date: '2024-01-10', amount: 0, comment: null }] },
      },
      {
        documentId: 'c',
        data: { capital_contributions: [{ date: '2024-02-01', amount: null, comment: null }] },
      },
    ]);
  });

  test('a contact save with contributions ignores the old fields and writes their summary', async () => {
    const written = [];
    global.strapi = {
      db: {
        query: () => ({
          findOne: async () => ({ id: 7, capital_contributions: [{ date: '2024-04-28', amount: '100.00' }] }),
          update: async (args) => written.push(args),
        }),
      },
    };
    const lifecycles = require(LIFECYCLES);
    const data = {
      name: 'X',
      partner_amount: 999,
      partner_amount_date: '2020-01-01',
      capital_contributions: [],
    };
    await lifecycles.beforeUpdate({ params: { data, where: { id: 7 } } });
    expect(data).not.toHaveProperty('partner_amount');
    expect(data).not.toHaveProperty('partner_amount_date');
    await lifecycles.afterUpdate({ params: { data }, result: { id: 7 } });
    expect(written).toEqual([
      { where: { id: 7 }, data: { partner_amount: 100, partner_amount_date: '2024-04-28' } },
    ]);

    // a save without them leaves everything as it was
    written.length = 0;
    const other = { name: 'Y', partner_amount: 5 };
    await lifecycles.beforeUpdate({ params: { data: other, where: { id: 8 } } });
    await lifecycles.afterUpdate({ params: { data: other }, result: { id: 8 } });
    expect(other.partner_amount).toBe(5);
    expect(written).toEqual([]);
  });
});
