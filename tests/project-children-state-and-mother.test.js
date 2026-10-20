/**
 * issues/282 (2026-10-20, review 8): two project-area slips.
 * - A mother's Planificació listed its active children under «Projectes fills
 *   no actius» and hid their Gantt: /projects/:id/children didn't populate the
 *   children's project_state, so the form never saw them as active.
 * - Ingressos/Despeses: the «Mare» dimension carried the project's own name
 *   (280 «S1 wizard prova» instead of «S1 mare prova») because the economic
 *   detail query didn't populate `mother` and the row fell back to p.name.
 * The db stub only fills a relation when the query asks to populate it, like
 * the real one.
 */

describe('project children state and «Mare» dimension (issues/282)', () => {
  let controller;

  const MOTHER = { id: 281, name: 'S1 mare prova', is_mother: true };
  const STATE = { id: 1, name: 'Obert' };
  const CHILD = {
    id: 280,
    name: 'S1 wizard prova',
    is_mother: false,
    project_phases: [
      {
        incomes: [{ quantity: 1, amount: 1000, total_amount: 1000, date: '2026-03-01', estimated_hours: [] }],
        expenses: [],
      },
    ],
    project_original_phases: [],
  };

  const withPopulated = (row, populate) => {
    const out = { ...row };
    if (populate && populate.project_state) out.project_state = STATE;
    if (populate && populate.mother) out.mother = MOTHER;
    return out;
  };

  beforeEach(() => {
    jest.resetModules();
    jest.doMock('@strapi/strapi', () => ({
      factories: { createCoreController: (uid, build) => (args) => build(args) },
    }));
    global.strapi = {
      db: {
        query: (uid) => ({
          findMany: async (args = {}) => {
            if (uid !== 'api::project.project') return [];
            return [withPopulated(CHILD, args.populate)];
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

  it('findChildren returns each child with its project_state', async () => {
    const { children } = await controller.findChildren({ params: { id: 281 } });
    expect(children).toHaveLength(1);
    expect(children[0].project_state).toEqual(STATE);
  });

  it('economic detail rows carry the mother\'s name in «Mare»', async () => {
    const rows = await controller.findWithEconomicDetail({ query: {} });
    expect(rows.length).toBeGreaterThan(0);
    rows.forEach((r) => {
      expect(r.project_name).toBe('S1 wizard prova');
      expect(r.mother).toBe('S1 mare prova');
    });
  });
});
