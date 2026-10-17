/**
 * 2026-10-17: `GET /projects/phases-both?activities=true` (the dedication report,
 * Informes › Dedicació) loaded each project's activities without their relations,
 * so every logged hour had no person, dedication type or function and the report
 * put them all under «Sense assignar». The activities now come with those
 * relations as ids, as `with-activities` gives them (issues/016) and the report
 * expects.
 */

describe('phases-both activities', () => {
  let controller;
  let projectQuery;

  beforeEach(() => {
    jest.resetModules();
    jest.doMock('@strapi/strapi', () => ({
      factories: {
        createCoreController: (uid, build) => (args) => build(args),
      },
    }));
    projectQuery = jest.fn(async () => [
      {
        id: 1,
        name: 'A',
        project_phases: [],
        project_original_phases: [],
        activities: [
          { id: 10, hours: 2, date: '2026-01-05', users_permissions_user: { id: 7 }, activity_type: { id: 3 }, dedication_type: null },
          { id: 11, hours: 1, date: '2026-01-06', users_permissions_user: null, activity_type: null, dedication_type: { id: 4 } },
        ],
      },
    ]);
    global.strapi = {
      contentType: () => ({ attributes: {} }),
      db: { query: () => ({ findMany: projectQuery }) },
    };
    controller = require('../src/api/project/controllers/project')({ strapi: global.strapi });
  });

  afterEach(() => {
    delete global.strapi;
  });

  it('loads the person, dedication type and function of each activity', async () => {
    await controller.findWithPhasesBoth({ query: { activities: 'true', _where: { project_state_in: '1' } } });
    expect(projectQuery.mock.calls[0][0].populate.activities).toEqual({
      populate: { users_permissions_user: true, activity_type: true, dedication_type: true },
    });
  });

  it('gives them as ids', async () => {
    const [project] = await controller.findWithPhasesBoth({ query: { activities: 'true' } });
    expect(project.activities).toEqual([
      { id: 10, hours: 2, date: '2026-01-05', users_permissions_user: 7, activity_type: 3, dedication_type: null },
      { id: 11, hours: 1, date: '2026-01-06', users_permissions_user: null, activity_type: null, dedication_type: 4 },
    ]);
  });
});
