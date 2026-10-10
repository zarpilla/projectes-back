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
    expect(ctx.query.populate).not.toContain('activities');
    expect(activityQuery.mock.calls[0][0].where).toEqual({ project: { id: { $in: [1, 2] } } });
    expect(response.data[0].activities).toEqual([
      { id: 10, hours: 2, date: '2026-01-05', project: 1, users_permissions_user: 7, activity_type: 3, dedication_type: null },
      { id: 11, hours: 1, date: '2026-01-06', project: 1, users_permissions_user: 8, activity_type: null, dedication_type: 4 },
    ]);
    expect(response.data[1].activities).toEqual([]);
  });
});
