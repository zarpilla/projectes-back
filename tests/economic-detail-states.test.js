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
    jest.doMock('../src/api/project/services/economic-detail-activities', () => ({
      loadActivitiesByProjectMonth: async () => new Map(),
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

  // Since issues/307 the rows of every project are kept by the read cache and
  // the chips filter them in memory: the database is asked for all of them.
  const projects = () => [
    { id: 1, name: 'Actiu', project_state: { id: 1, name: 'Actiu' }, project_phases: [{ name: 'F', incomes: [{ quantity: 1, amount: 100, date: '2026-03-01' }] }] },
    { id: 2, name: 'Tancat', project_state: { id: 2, name: 'Tancat' }, project_phases: [{ name: 'F', incomes: [{ quantity: 1, amount: 200, date: '2026-03-01' }] }] },
    { id: 3, name: 'Sense', project_state: null, project_phases: [{ name: 'F', incomes: [{ quantity: 1, amount: 300, date: '2026-03-01' }] }] },
  ];
  const projectIds = (rows) => [...new Set(rows.map((r) => r.id))].sort();
  const ask = async (query) => {
    global.strapi.db.query = (uid) => ({
      findMany: async (args) => {
        if (uid === 'api::project.project') projectArgs.push(args);
        return uid === 'api::project.project' ? projects() : [];
      },
    });
    return controller.findWithEconomicDetail({ query });
  };

  it('asks only for the chosen states', async () => {
    expect(projectIds(await ask({ _where: { project_state_in: '1,2' } }))).toEqual([1, 2]);
    expect(projectIds(await ask({ _where: { project_state_in: '2' } }))).toEqual([2]);
    // the database is asked for every published project
    expect(projectArgs.every((args) => !JSON.stringify(args.where || {}).includes('project_state'))).toBe(true);
  });

  it('id 0 adds the projects without a state', async () => {
    expect(projectIds(await ask({ _where: { project_state_in: '1,0' } }))).toEqual([1, 3]);
    expect(projectIds(await ask({ _where: { project_state_in: '0' } }))).toEqual([3]);
  });

  it('also when searching by name', async () => {
    await controller.findWithEconomicDetail({ query: { _q: 'P', _where: { project_state_in: '0' } } });
    const { where } = projectArgs[0];
    expect(where.$and[0].$or).toEqual([{ name: { $contains: 'P' } }]);
    expect(stateFilter(where).$or[1]).toEqual({ project_state: { id: { $null: true } } });
  });
});
