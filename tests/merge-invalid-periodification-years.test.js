'use strict';

/**
 * issues/015 — startup script that folds periodification rows saved with the
 * "Invalid date" year (undated lines, before the fix) into the project's
 * undated "9999" row, so the form shows a single undated row.
 */

let tables;

// Minimal in-memory knex: just the calls the script makes.
function fakeKnex(name) {
  let filter = () => true;
  const q = {
    join: () => q,
    where: (colOrObj, value) => {
      const prev = filter;
      const match =
        typeof colOrObj === 'string'
          ? (r) => r[colOrObj.split('.').pop()] === value
          : (r) => Object.entries(colOrObj).every(([k, v]) => r[k] === v);
      filter = (r) => prev(r) && match(r);
      return q;
    },
    select: async () =>
      tables.projects_cmps
        .filter(filter)
        .map((l) => ({ ...tables[name].find((p) => p.id === l.cmp_id), project_id: l.entity_id })),
    update: async (data) => tables[name].filter(filter).forEach((r) => Object.assign(r, data)),
    del: async () => {
      tables[name] = tables[name].filter((r) => !filter(r));
    },
  };
  return q;
}

const link = (cmp_id, entity_id) => ({ cmp_id, entity_id, component_type: 'periodification.periodification' });
const row = (id, year, incomes = 0, real_incomes = 0) => ({
  id,
  year,
  incomes,
  expenses: 0,
  real_incomes,
  real_expenses: 0,
});

beforeEach(() => {
  jest.resetModules();
  global.strapi = { log: { info: jest.fn() }, db: { connection: fakeKnex } };
});

afterEach(() => {
  delete global.strapi;
});

describe('mergeInvalidPeriodificationYears', () => {
  it('renames a lone junk row and merges one next to an existing 9999 row', async () => {
    tables = {
      components_periodification_periodifications: [
        row(1, '2025', 100),
        row(2, 'Invalid date', 5),
        row(3, '9999', 10, 1),
        row(4, 'Invalid date', 7, 2),
        row(5, '2026'),
      ],
      projects_cmps: [link(1, 100), link(2, 100), link(3, 200), link(4, 200), link(5, 300)],
    };

    const { mergeInvalidPeriodificationYears } = require('../src/services/merge-invalid-periodification-years');
    await mergeInvalidPeriodificationYears();

    const rows = tables.components_periodification_periodifications;
    expect(rows.find((r) => r.id === 1).year).toBe('2025');
    expect(rows.find((r) => r.id === 2).year).toBe('9999');
    expect(rows.find((r) => r.id === 3)).toMatchObject({ year: '9999', incomes: 17, real_incomes: 3 });
    expect(rows.find((r) => r.id === 4)).toBeUndefined();
    expect(tables.projects_cmps.find((l) => l.cmp_id === 4)).toBeUndefined();
    expect(rows.find((r) => r.id === 5).year).toBe('2026');
  });

  it('accepts only 4-digit years as real', () => {
    const { isRealYear } = require('../src/services/merge-invalid-periodification-years');
    expect(isRealYear('2025')).toBe(true);
    expect(isRealYear('9999')).toBe(true);
    expect(isRealYear('Invalid date')).toBe(false);
    expect(isRealYear('')).toBe(false);
    expect(isRealYear(null)).toBe(false);
  });
});
