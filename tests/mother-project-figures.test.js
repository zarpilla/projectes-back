/**
 * issues/172 (2026-10-18): a mother project showed three different sets of
 * figures. Mother 770 (Resilience): the form said «Hores · Previstes 0,00 h»
 * because it copied the children's original hours over their estimated ones;
 * Projectes mare summed the children (672,1 h previstes); Projectes showed what
 * the mother has on itself (0 h, or legacy hours and costs on other mothers).
 * The user chose one definition: a mother's figures are its children's,
 * added up; what it has on itself doesn't count.
 */

describe('mother project figures', () => {
  let controller;
  let childrenQueries;

  const MOTHER = { id: 770, name: 'Mare', is_mother: true, total_estimated_hours: 4, incomes_expenses: -75.59, total_real_hours: 1065 };
  const CHILDREN = [
    {
      id: 779,
      name: 'Filla',
      mother: { id: 770 },
      // 100 h estimated in the planning, none in the original budget
      project_phases: [{ incomes: [{ quantity: 1, amount: 0, estimated_hours: [{ from: '2026-01-01', to: '2026-12-31', quantity: 100, users_permissions_user: { id: 1 } }] }], expenses: [] }],
      project_original_phases: [],
      total_original_hours: 0, total_estimated_hours: 672.15, total_estimated_hours_price: 16000, total_real_hours: 159.9, estimated_incomes_expenses: 17815.76, incomes_expenses: 17815.76 },
    { id: 780, name: 'Filla 2', mother: { id: 770 }, total_estimated_hours: 10, total_real_hours: 0, estimated_incomes_expenses: 100, incomes_expenses: 100 },
  ];

  beforeEach(() => {
    jest.resetModules();
    childrenQueries = 0;
    jest.doMock('@strapi/strapi', () => ({
      factories: { createCoreController: (uid, build) => (args) => build(args) },
    }));
    global.strapi = {
      db: {
        query: () => ({
          findMany: async (args) => {
            if (args.where && args.where.mother) {
              childrenQueries++;
              return CHILDREN.map((c) => ({ ...c }));
            }
            return [{ ...MOTHER }, ...CHILDREN.map((c) => ({ ...c }))];
          },
          findOne: async () => ({ ...MOTHER }),
          count: async () => 0,
        }),
      },
      documents: () => ({ findFirst: async () => ({ options: {} }) }),
    };
    controller = require('../src/api/project/controllers/project')({ strapi: global.strapi });
  });

  afterEach(() => {
    delete global.strapi;
  });

  it('addChildrenTotals: the children added up, not what the mother has on itself', () => {
    const { addChildrenTotals } = require('../src/api/project/services/motherChildren');
    const mother = addChildrenTotals({ ...MOTHER }, CHILDREN);
    expect(mother.total_estimated_hours).toBeCloseTo(682.15);
    expect(mother.total_real_hours).toBeCloseTo(159.9);
    expect(mother.incomes_expenses).toBeCloseTo(17915.76);
  });

  it('Projectes (projects/basic): a mother shows its children\'s figures, with one query', async () => {
    const rows = await controller.findWithBasicInfo({ query: {} });
    const mother = rows.find((r) => r.id === 770);
    expect(mother.total_estimated_hours).toBeCloseTo(682.15);
    expect(mother.total_real_hours).toBeCloseTo(159.9);
    expect(rows.find((r) => r.id === 779).total_estimated_hours).toBe(672.15);
    expect(childrenQueries).toBe(1);
  });

  it('the form (findChildren): estimated hours are the children\'s estimated ones', async () => {
    const { totals } = await controller.findChildren({ params: { id: 770 } });
    expect(totals.total_original_hours).toBe(0);
    expect(totals.total_estimated_hours).toBeCloseTo(100);
  });
});
