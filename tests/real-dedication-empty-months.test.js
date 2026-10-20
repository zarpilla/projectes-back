'use strict';

/**
 * issues/300 (2026-10-20, review 9): in «% Dedicació real» a month with a
 * working day but no hours showed «Sense dedicació», with no 0 % and no
 * «Hores període». It is 0 % of the period's hours now; months still to come
 * and months without a working day stay empty.
 */

const ACTIVITY = 'api::activity.activity';

describe('% Dedicació real, months with a working day and no hours (issues/300)', () => {
  const users = [
    { id: 1, username: 'amb-hores', hidden: false, daily_dedications: [{ from: '2026-01-01', to: '2026-12-31', hours: 8 }], permissions: [{ permission: 'projects' }] },
    { id: 2, username: 'sense-hores', hidden: false, daily_dedications: [{ from: '2026-01-01', to: '2026-12-31', hours: 6 }], permissions: [{ permission: 'hours' }] },
    { id: 3, username: 'sense-jornada', hidden: false, daily_dedications: [], permissions: [{ permission: 'hours' }] },
  ];
  const activities = [
    { date: '2026-03-02', hours: 8, users_permissions_user: { id: 1 }, project: { id: 9, name: 'P' } },
    { date: '2026-12-01', hours: 8, users_permissions_user: { id: 1 }, project: { id: 9, name: 'P' } },
  ];
  beforeEach(() => {
    jest.resetModules();
    jest.useFakeTimers({ now: new Date('2026-10-20T10:00:00Z'), doNotFake: ['nextTick', 'setImmediate'] });
    global.strapi = {
      db: {
        query: (uid) => ({
          findMany: async () =>
            uid === ACTIVITY ? activities : uid === 'plugin::users-permissions.user' ? users : [],
        }),
      },
    };
  });
  afterEach(() => {
    jest.useRealTimers();
    delete global.strapi;
  });

  it('shows 0 % and the period hours', async () => {
    const { buildRealDedicationGantt } = require('../src/api/project/services/realDedicationGantt');
    const { cells } = await buildRealDedicationGantt({ projectStateIds: [], year: 2026, view: 'month' });
    // March 2026: 22 weekdays × 6 h
    expect(cells[2]['2026-03']).toMatchObject({
      hours: '0.00',
      percentage: '0',
      cssClass: 'dedication-low',
      expected: 132,
      diff: 132,
      noSchedule: false,
      breakdown: [],
    });
    expect(cells[2]['2026-03'].tooltip).toContain('Hores període: 132.00h');
  });

  it('leaves months to come and people without a working day empty', async () => {
    const { buildRealDedicationGantt } = require('../src/api/project/services/realDedicationGantt');
    const { cells } = await buildRealDedicationGantt({ projectStateIds: [], year: 2026, view: 'month' });
    expect(cells[2]['2026-12']).toEqual({ hours: '0.00', percentage: '0', cssClass: 'dedication-empty', tooltip: 'Sense dedicació' });
    expect(cells[3]['2026-03']).toEqual({ hours: '0.00', percentage: '0', cssClass: 'dedication-empty', tooltip: 'Sense dedicació' });
  });

  it('also by week', async () => {
    const { buildRealDedicationGantt } = require('../src/api/project/services/realDedicationGantt');
    const { cells } = await buildRealDedicationGantt({ projectStateIds: [], year: 2026, view: 'week' });
    expect(cells[2]['2026-W10']).toMatchObject({ hours: '0.00', percentage: '0', expected: 30, noSchedule: false });
  });
});
