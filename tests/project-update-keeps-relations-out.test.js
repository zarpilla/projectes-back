/**
 * Regression (issues/016, 2026-10-10): saving a project, or assigning an
 * invoice to one of its phase lines, took 7 seconds on a project with 4,400
 * activities.
 *
 * beforeUpdate loads the whole project graph (activities, phases) to recompute
 * the totals and merged the result back into the update — graph included. The
 * db layer then re-set every one of those relations: a deep-equal
 * de-duplication of the populated rows (quadratic) and a rewrite of all their
 * link rows. Guards that only the computed values reach the update.
 */

describe('project beforeUpdate', () => {
  let lifecycles;

  beforeEach(() => {
    jest.resetModules();
    const stored = {
      id: 7,
      name: 'Stored name',
      activities: [{ id: 1, hours: 2, activity_type: { id: 3 } }, { id: 2, hours: 1 }],
      project_phases: [{ id: 10, incomes: [{ id: 100 }], expenses: [] }],
      project_original_phases: [{ id: 20, incomes: [], expenses: [] }],
    };
    global.strapi = {
      contentType: () => ({ attributes: {} }),
      db: { query: () => ({ findOne: async () => stored }) },
      // Like the real calculateProject: returns the project it was given, with totals added.
      controller: () => ({
        calculateProject: async (project) => Object.assign(project, { total_incomes: 1500, total_expenses: 400 }),
      }),
    };
    lifecycles = require('../src/api/project/content-types/project/lifecycles');
  });

  afterEach(() => {
    delete global.strapi;
  });

  it('writes the computed totals and the edited fields', async () => {
    const event = { params: { where: { id: 7 }, data: { name: 'New name' } }, state: {} };
    await lifecycles.beforeUpdate(event);
    expect(event.params.data.name).toBe('New name');
    expect(event.params.data.total_incomes).toBe(1500);
    expect(event.params.data.total_expenses).toBe(400);
  });

  it('does not write the activities and phases it loaded for the calculation', async () => {
    const event = { params: { where: { id: 7 }, data: { name: 'New name' } }, state: {} };
    await lifecycles.beforeUpdate(event);
    expect(event.params.data).not.toHaveProperty('activities');
    expect(event.params.data).not.toHaveProperty('project_phases');
    expect(event.params.data).not.toHaveProperty('project_original_phases');
  });
});
