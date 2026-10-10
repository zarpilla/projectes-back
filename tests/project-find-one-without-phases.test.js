/**
 * issues/016 (2026-10-10): ProjectForm downloaded the phases of a project
 * twice — once inside `projects/:id`, then again from the phase endpoints,
 * whose rows are the ones it edits. `projects/:id?_phases=false` leaves the
 * embedded copy out (380 of the 485 KB of a large project). The totals are
 * still computed from the phases, and callers that don't ask keep getting them.
 */

describe('project findOne', () => {
  let controller;

  const storedProject = () => ({
    id: 7,
    name: 'Project',
    activities: [],
    project_phases: [
      { id: 10, incomes: [{ id: 100, quantity: 2, amount: 500, total_amount: 1000, date: '2026-03-01' }], expenses: [] },
    ],
    project_original_phases: [{ id: 20, incomes: [], expenses: [] }],
  });

  beforeEach(() => {
    jest.resetModules();
    jest.doMock('@strapi/strapi', () => ({ factories: { createCoreController: (uid, build) => build } }));
    jest.doMock('../src/services/me-settings', () => ({ getMe: async () => ({ options: {} }) }));
    jest.doMock('../src/api/project/services/projectCache', () => ({
      getDailyDedications: async () => [],
      getFestives: async () => [],
    }));
    global.strapi = {
      db: {
        query: () => ({ findOne: async () => storedProject(), findMany: async () => [], count: async () => 0 }),
      },
    };
    controller = require('../src/api/project/controllers/project')({ strapi: global.strapi });
  });

  afterEach(() => {
    delete global.strapi;
  });

  const ctxFor = (query) => ({ params: { id: 7 }, state: {}, query });

  it('answers with the phases by default', async () => {
    const project = await controller.findOne(ctxFor({}));
    expect(project.project_phases).toHaveLength(1);
    expect(project.project_original_phases).toHaveLength(1);
  });

  it('leaves the phases out with _phases=false, and still computes the totals from them', async () => {
    const project = await controller.findOne(ctxFor({ _phases: 'false' }));
    expect(project).not.toHaveProperty('project_phases');
    expect(project).not.toHaveProperty('project_original_phases');
    expect(project.total_estimated_incomes).toBe(1000);
  });
});
