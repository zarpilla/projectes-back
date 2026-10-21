/**
 * 2026-10-17: `GET /projects/phases-both?activities=true` (the dedication report,
 * Informes › Dedicació) loaded each project's activities without their relations,
 * so every logged hour had no person, dedication type or function and the report
 * put them all under «Sense assignar». The activities now come with those
 * relations as ids, as `with-activities` gives them (issues/016) and the report
 * expects.
 *
 * issues/309: they are loaded apart (all of them, kept by the read cache) with
 * only the fields the report reads, and grouped under their project.
 */

describe('phases-both activities', () => {
  let controller;
  let calls;

  beforeEach(() => {
    jest.resetModules();
    jest.doMock('@strapi/strapi', () => ({
      factories: {
        createCoreController: (uid, build) => (args) => build(args),
      },
    }));
    calls = {};
    const rows = {
      'api::project.project': [
        { id: 1, name: 'A', project_state: { id: 1 }, project_phases: [], project_original_phases: [] },
      ],
      'api::activity.activity': [
        { id: 10, hours: 2, date: '2026-01-05', cost_by_hour: 20, project: { id: 1 }, users_permissions_user: { id: 7 }, activity_type: { id: 3 }, dedication_type: null },
        { id: 11, hours: 1, date: '2026-01-06', cost_by_hour: null, project: { id: 1 }, users_permissions_user: null, activity_type: null, dedication_type: { id: 4 } },
        { id: 12, hours: 5, date: '2026-01-07', cost_by_hour: 20, project: { id: 2 }, users_permissions_user: { id: 7 }, activity_type: null, dedication_type: null },
      ],
    };
    global.strapi = {
      contentType: () => ({ attributes: {} }),
      db: {
        query: (uid) => ({
          findMany: async (args) => {
            calls[uid] = args;
            return rows[uid] || [];
          },
        }),
      },
    };
    controller = require('../src/api/project/controllers/project')({ strapi: global.strapi });
  });

  afterEach(() => {
    delete global.strapi;
  });

  it('loads the person, dedication type and function of each activity', async () => {
    await controller.findWithPhasesBoth({ query: { activities: 'true', _where: { project_state_in: '1' } } });
    expect(calls['api::activity.activity']).toEqual({
      select: ['id', 'date', 'hours', 'cost_by_hour'],
      populate: {
        project: { select: ['id'] },
        users_permissions_user: { select: ['id'] },
        activity_type: { select: ['id'] },
        dedication_type: { select: ['id'] },
      },
    });
  });

  it('gives them as ids, under their project', async () => {
    const [project] = await controller.findWithPhasesBoth({ query: { activities: 'true' } });
    expect(project.activities).toEqual([
      { id: 10, hours: 2, date: '2026-01-05', cost_by_hour: 20, users_permissions_user: 7, activity_type: 3, dedication_type: null },
      { id: 11, hours: 1, date: '2026-01-06', cost_by_hour: null, users_permissions_user: null, activity_type: null, dedication_type: 4 },
    ]);
  });
});
