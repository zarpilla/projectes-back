/**
 * Regression (issues/232, review 7, 2026-10-19): every save of a project with a
 * periodification added one more untyped `projects_cmps` link per row (same
 * cmp_id, component_type NULL), so the API returned each row once more per
 * save and every per-year figure moved by the periodified amount again.
 *
 * beforeUpdate resolves the payload's `{ id, __pivot }` component references
 * to their stored rows for the financials (c0ac2ce) and then merged the
 * calculated project back into the update — resolved rows included. Linked
 * without their `__pivot`, they were written as untyped copies. Guards that
 * the references reach the db layer as they came, for periodification and the
 * grant components alike.
 */

const ROWS = {
  'periodification.periodification': [
    { id: 28, year: '2025', incomes: 4000, expenses: 0 },
    { id: 29, year: '2026', incomes: -4000, expenses: 0 },
  ],
  'grantable.grantable-year': [{ id: 5, amount: 100 }],
};

describe('project beforeUpdate component references (issues/232)', () => {
  let lifecycles;
  let calculatedWith;

  beforeEach(() => {
    jest.resetModules();
    calculatedWith = null;
    global.strapi = {
      contentType: () => ({
        attributes: {
          name: { type: 'string' },
          periodification: { type: 'component', repeatable: true, component: 'periodification.periodification' },
          grantable_years: { type: 'component', repeatable: true, component: 'grantable.grantable-year' },
          grantable_contacts: { type: 'component', repeatable: true, component: 'grantable-contact.grantable-contact' },
        },
      }),
      db: {
        query: (uid) => ({
          findOne: async () => ({ id: 265, name: 'Jordania', activities: [], project_phases: [], project_original_phases: [] }),
          findMany: async ({ where }) => (ROWS[uid] || []).filter((r) => where.id.$in.includes(r.id)),
        }),
      },
      controller: () => ({
        calculateProject: async (project) => {
          calculatedWith = JSON.parse(JSON.stringify(project));
          return Object.assign(project, { total_incomes: 1500 });
        },
      }),
    };
    lifecycles = require('../src/api/project/content-types/project/lifecycles');
  });

  afterEach(() => {
    delete global.strapi;
  });

  const refs = (field, ids) =>
    ids.map((id) => ({ id, __pivot: { field, component_type: field === 'periodification' ? 'periodification.periodification' : 'grantable.grantable-year' } }));

  it('keeps the references in the update and calculates with the stored values', async () => {
    const periodification = refs('periodification', [28, 29]);
    const grantableYears = refs('grantable_years', [5]);
    const event = {
      params: { where: { id: 265 }, data: { name: 'Jordania', periodification, grantable_years: grantableYears } },
      state: {},
    };
    await lifecycles.beforeUpdate(event);

    expect(event.params.data.periodification).toEqual(periodification);
    expect(event.params.data.grantable_years).toEqual(grantableYears);
    expect(event.params.data.total_incomes).toBe(1500);
    expect(calculatedWith.periodification.map((p) => p.year)).toEqual(['2025', '2026']);
    expect(calculatedWith.grantable_years[0].amount).toBe(100);
  });

  it('adds no component the payload did not carry', async () => {
    const event = { params: { where: { id: 265 }, data: { name: 'Jordania' } }, state: {} };
    await lifecycles.beforeUpdate(event);
    expect(event.params.data).not.toHaveProperty('periodification');
    expect(event.params.data).not.toHaveProperty('grantable_years');
    expect(event.params.data).not.toHaveProperty('grantable_contacts');
  });
});
