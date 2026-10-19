/**
 * issues/205 (2026-10-19): projects without a project_state never appeared in
 * Ingressos/Despeses and Preu hora: the reports always ask for the states of
 * their chips. The «Sense estat» chip sends the id 0, which asks for them.
 */

describe('economic detail: «Sense estat» (issues/205)', () => {
  let controller;
  let projectArgs;

  beforeEach(() => {
    jest.resetModules();
    projectArgs = [];
    jest.doMock('@strapi/strapi', () => ({
      factories: { createCoreController: (uid, build) => (args) => build(args) },
    }));
    global.strapi = {
      db: {
        query: (uid) => ({
          findMany: async (args) => {
            if (uid === 'api::project.project') projectArgs.push(args);
            return [];
          },
        }),
      },
      documents: () => ({ findFirst: async () => ({ options: {} }) }),
    };
    controller = require('../src/api/project/controllers/project')({ strapi: global.strapi });
  });

  afterEach(() => {
    delete global.strapi;
  });

  const stateFilter = (where) => where.$and[1];

  it('asks only for the chosen states', async () => {
    await controller.findWithEconomicDetail({ query: { _where: { project_state_in: '1,2' } } });
    expect(stateFilter(projectArgs[0].where)).toEqual({ project_state: { id: { $in: [1, 2] } } });
  });

  it('id 0 adds the projects without a state', async () => {
    await controller.findWithEconomicDetail({ query: { _where: { project_state_in: '1,0' } } });
    expect(stateFilter(projectArgs[0].where)).toEqual({
      $or: [{ project_state: { id: { $in: [1] } } }, { project_state: { id: { $null: true } } }],
    });
  });

  it('also when searching by name', async () => {
    await controller.findWithEconomicDetail({ query: { _q: 'P', _where: { project_state_in: '0' } } });
    const { where } = projectArgs[0];
    expect(where.$and[0].$or).toEqual([{ name: { $contains: 'P' } }]);
    expect(stateFilter(where).$or[1]).toEqual({ project_state: { id: { $null: true } } });
  });
});
