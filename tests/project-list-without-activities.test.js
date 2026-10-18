/**
 * issues/016 (2026-10-10): `GET /projects` answered with every activity of
 * every project (the v3 default populate): 11 MB and 4.4 s for a tenant with
 * 31,000 activities, on lists that never read them. The default populate of the
 * list now leaves `activities` out, and the views that work on the logged hours
 * ask `GET /projects/with-activities`, which nests them the way v3 did (their
 * relations as ids).
 */

describe('project list', () => {
  let controller;
  let superFind;
  let activityQuery;

  const ATTRIBUTES = {
    name: { type: 'string' },
    leader: { type: 'relation' },
    activities: { type: 'relation' },
    project_phases: { type: 'relation' },
    periodification: { type: 'component' },
    documents: { type: 'media' },
    createdBy: { type: 'relation' },
    updatedBy: { type: 'relation' },
  };

  beforeEach(() => {
    jest.resetModules();
    superFind = jest.fn(async () => ({ data: [{ id: 1, name: 'A' }, { id: 2, name: 'B' }], meta: {} }));
    jest.doMock('@strapi/strapi', () => ({
      factories: {
        // Stand-in for the core controller: the override's `super.find` lands on superFind.
        createCoreController: (uid, build) => (args) =>
          Object.setPrototypeOf(build(args), { find: superFind }),
      },
    }));
    activityQuery = jest.fn(async () => [
      { id: 10, hours: 2, date: '2026-01-05', project: { id: 1 }, users_permissions_user: { id: 7 }, activity_type: { id: 3 }, dedication_type: null },
      { id: 11, hours: 1, date: '2026-01-06', project: { id: 1 }, users_permissions_user: { id: 8 }, activity_type: null, dedication_type: { id: 4 } },
    ]);
    global.strapi = {
      contentType: () => ({ attributes: ATTRIBUTES }),
      db: { query: () => ({ findMany: activityQuery }) },
    };
    controller = require('../src/api/project/controllers/project')({ strapi: global.strapi });
    global.strapi.controller = () => controller;
  });

  afterEach(() => {
    delete global.strapi;
  });

  it('leaves the activities out of the default populate', async () => {
    const ctx = { query: { populate: '*' }, state: { v3DefaultPopulate: true } };
    await controller.find(ctx);
    expect(ctx.query.populate).toEqual(['leader', 'project_phases', 'periodification', 'documents']);
  });

  it('keeps a populate the caller asked for', async () => {
    const ctx = { query: { populate: ['activities'] }, state: {} };
    await controller.find(ctx);
    expect(ctx.query.populate).toEqual(['activities']);
  });

  it('with-activities: nests each project\'s activities, their relations as ids', async () => {
    const ctx = { query: {}, state: {} };
    const response = await controller.findWithActivities(ctx);
    expect(ctx.query.populate).not.toHaveProperty('activities');
    expect(activityQuery.mock.calls[0][0].where).toEqual({ project: { id: { $in: [1, 2] } } });
    expect(response.data[0].activities).toEqual([
      { id: 10, hours: 2, date: '2026-01-05', project: 1, users_permissions_user: 7, activity_type: 3, dedication_type: null },
      { id: 11, hours: 1, date: '2026-01-06', project: 1, users_permissions_user: 8, activity_type: null, dedication_type: 4 },
    ]);
    expect(response.data[1].activities).toEqual([]);
  });

  // issues/059: populating a component doesn't populate its relations, so the
  // grant years came without their `year` and Justificacions crashed on them
  it('with-activities: the grant years come with their year', async () => {
    const ctx = { query: {}, state: {} };
    await controller.findWithActivities(ctx);
    expect(ctx.query.populate).toMatchObject({
      leader: true,
      grantable_years: { populate: { year: true } },
      grantable_contacts: { populate: { contact: true } },
    });
  });

  // issues/128: the Panell de projectes counted (and summed) the trashed
  // projects: Arran de Terra 47 «actiu» against 32 in the projects list
  it('with-activities: leaves the trashed projects out', async () => {
    const ctx = { query: { _where: { project_state_eq: 1 } }, state: {} };
    await controller.findWithActivities(ctx);
    expect(superFind.mock.calls[0][0].query.filters).toMatchObject({ trashed: false });
  });

  it('with-activities: still answers the trashed ones when asked', async () => {
    const ctx = { query: { published_at_null: true }, state: {} };
    await controller.findWithActivities(ctx);
    expect(superFind.mock.calls[0][0].query.filters).toMatchObject({ trashed: true });
  });

  // issues/169: the Panell de projectes summed the mothers, whose totals the
  // list fills with their children's, on top of the children themselves
  it('with-activities: a mother keeps its own totals', async () => {
    superFind.mockResolvedValueOnce({
      data: [
        { id: 1, name: 'Mare', is_mother: true, total_real_incomes: 0 },
        { id: 2, name: 'Filla', mother: { id: 1 }, total_real_incomes: 500 },
      ],
      meta: {},
    });
    global.strapi.db.query = (uid) => ({
      findMany: uid === 'api::project.project' ? async () => [{ id: 2, total_real_incomes: 500 }] : activityQuery,
    });
    const response = await controller.findWithActivities({ query: {}, state: {} });
    expect(response.data.map((row) => row.total_real_incomes)).toEqual([0, 500]);
  });

  it('the list still adds the children up on their mother', async () => {
    superFind.mockResolvedValueOnce({ data: [{ id: 1, name: 'Mare', is_mother: true, total_real_incomes: 0 }], meta: {} });
    global.strapi.db.query = () => ({ findMany: async () => [{ id: 2, total_real_incomes: 500 }] });
    const response = await controller.find({ query: {}, state: {} });
    expect(response.data[0].total_real_incomes).toBe(500);
  });
});
