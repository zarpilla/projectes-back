/**
 * issues/174 (2026-10-18): Saldo d'hores and Bestretes (`activities/total-by-day`)
 * and «% Dedicació real» with a state filter left out the activities without a
 * project (642 in 2026 on Resilience, mostly iCal imports not assigned yet), so
 * «Total hores treballades 1.105,00 h» against 1.111,3 h in Hores dedicades.
 * The user chose to count them: they are worked hours.
 */

describe('hours without a project', () => {
  let activityArgs;

  beforeEach(() => {
    jest.resetModules();
    activityArgs = [];
    jest.doMock('@strapi/strapi', () => ({
      factories: { createCoreController: (uid, build) => (args) => build(args) },
    }));
    global.strapi = {
      db: {
        query: (uid) => ({
          findMany: async (args) => {
            if (uid === 'api::activity.activity') {
              activityArgs.push(args);
              return [
                { date: '2026-03-02', hours: 6, project: { id: 1 } },
                { date: '2026-03-02', hours: 1.25, project: null },
                { date: '2026-03-03', hours: 5 },
              ];
            }
            if (uid === 'api::project.project') return [{ id: 1 }];
            return [];
          },
        }),
      },
    };
  });

  afterEach(() => {
    delete global.strapi;
  });

  it('total-by-day sums every activity of the day', async () => {
    const controller = require('../src/api/activity/controllers/activity')({ strapi: global.strapi });
    const days = await controller.totalByDay({ query: {} });
    expect(days).toEqual([
      { date: '2026-03-02', hours: 7.25 },
      { date: '2026-03-03', hours: 5 },
    ]);
  });

  // issues/185: with `select: ['hours', 'date']` and a person filter Strapi
  // adds DISTINCT, so two 2 h entries of one day came back as one row (2 h).
  it('total-by-day selects the id, so equal entries of a day are not merged', async () => {
    const controller = require('../src/api/activity/controllers/activity')({ strapi: global.strapi });
    await controller.totalByDay({ query: { filters: { users_permissions_user: { id: 8 } } } });
    expect(activityArgs[0].select).toContain('id');
  });

  it('% Dedicació real: a state filter keeps the activities without a project', async () => {
    const { buildRealDedicationGantt } = require('../src/api/project/services/realDedicationGantt');
    await buildRealDedicationGantt({ projectStateIds: ['1'], year: 2026 });
    expect(activityArgs[0].where.$or).toEqual([{ project: { $in: [1] } }, { project: { id: { $null: true } } }]);
  });
});
