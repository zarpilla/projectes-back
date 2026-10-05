'use strict';

/**
 * Regression: resilience — saving a project with a periodification answered
 * 500 "Cannot read properties of undefined (reading 'toString')".
 *
 * In a v5 db lifecycle the components of the payload are bare
 * `{ id, __pivot }` references. The project's beforeUpdate merged them over
 * the loaded project, so the financials read `pp.year` off a reference.
 */

const fs = require('fs');
const path = require('path');
const { resolveComponentRefs, isRef } = require('../src/services/component-refs');

const ROWS = {
  'periodification.periodification': [
    { id: 2, year: '2026', incomes: 100, expenses: 50 },
    { id: 3, year: '2027', incomes: 0, expenses: 10 },
  ],
  'grantable.grantable-year': [{ id: 9, year: '2026' }],
};

describe('resolveComponentRefs', () => {
  beforeEach(() => {
    global.strapi = {
      contentType: () => ({
        attributes: {
          name: { type: 'string' },
          periodification: { type: 'component', repeatable: true, component: 'periodification.periodification' },
          grantable_years: { type: 'component', repeatable: false, component: 'grantable.grantable-year' },
        },
      }),
      db: {
        query: (uid) => ({
          findMany: async ({ where }) => ROWS[uid].filter((r) => where.id.$in.includes(r.id)),
        }),
      },
    };
  });

  afterEach(() => {
    delete global.strapi;
  });

  it('replaces references with the stored rows, keeping order', async () => {
    const data = {
      name: 'P',
      periodification: [{ id: 3, __pivot: { field: 'periodification' } }, { id: 2, __pivot: {} }],
      grantable_years: { id: 9, __pivot: {} },
    };
    await resolveComponentRefs('api::project.project', data);
    expect(data.periodification.map((p) => p.year)).toEqual(['2027', '2026']);
    expect(data.grantable_years.year).toBe('2026');
    expect(data.name).toBe('P');
  });

  it('leaves values that already carry their fields, and empty lists, alone', async () => {
    const raw = { year: '2028', incomes: 1 };
    const data = { periodification: [raw], grantable_years: null };
    await resolveComponentRefs('api::project.project', data);
    expect(data.periodification[0]).toBe(raw);

    const empty = { periodification: [] };
    await resolveComponentRefs('api::project.project', empty);
    expect(empty.periodification).toEqual([]);
  });

  it('recognises only bare references', () => {
    expect(isRef({ id: 1, __pivot: {} })).toBe(true);
    expect(isRef({ id: 1 })).toBe(true);
    expect(isRef({ id: 1, year: '2026' })).toBe(false);
    expect(isRef(null)).toBe(false);
  });
});

describe('project beforeUpdate', () => {
  it('resolves component references before merging into the loaded project', () => {
    const src = fs.readFileSync(
      path.join(__dirname, '..', 'src', 'api', 'project', 'content-types', 'project', 'lifecycles.js'),
      'utf8',
    );
    const resolveAt = src.indexOf("await resolveComponentRefs('api::project.project', dataToMerge);");
    const mergeAt = src.indexOf('Object.assign(fullProject, dataToMerge);');
    expect(resolveAt).toBeGreaterThan(-1);
    expect(resolveAt).toBeLessThan(mergeAt);
  });
});
