'use strict';

/**
 * issues/238 (2026-10-19, review 7): only Saldo d'hores followed a period's
 * weekly distribution («Distribució setmanal», hoursperday). % Dedicació real
 * and Previsió dedicació used the flat hours per day, so with Quim's 3,6 h/dia
 * period set to 4,4,4,3,3,0,0 October 2026 expected 75,6 h instead of 74 h.
 */

const { capacityForMonth, capacityForWeek, dayHours } = require('../src/api/project/services/ganttCapacity');

const PERIOD = { from: '2026-01-01', to: '2026-12-31', hours: 3.6, hoursperday: '4,4,4,3,3,0,0' };

describe('gantt capacity with a weekly distribution (issues/238)', () => {
  it('follows the distribution, Monday first, like Saldo d\'hores', () => {
    expect(dayHours([PERIOD], '2026-10-19', 1)).toBe(4); // Monday
    expect(dayHours([PERIOD], '2026-10-22', 4)).toBe(3); // Thursday
    expect(dayHours([PERIOD], '2026-10-24', 6)).toBe(0); // Saturday
    // weekend hours of a distribution count too
    expect(dayHours([{ ...PERIOD, hoursperday: '0,0,0,0,0,5,0' }], '2026-10-24', 6)).toBe(5);
    // without one: the daily hours from Monday to Friday
    expect(dayHours([{ ...PERIOD, hoursperday: null }], '2026-10-22', 4)).toBe(3.6);
    expect(dayHours([{ ...PERIOD, hoursperday: '' }], '2026-10-24', 6)).toBe(0);
  });

  it('gives October 2026 its 74 h (78 h − the 12th) instead of 75,6 h', () => {
    expect(capacityForMonth('2026-10', [PERIOD], new Set(['2026-10-12']))).toEqual({ expected: 74, festive: 4 });
    expect(capacityForWeek('2026-W42', [PERIOD], new Set())).toEqual({ expected: 18, festive: 0 });
  });

  it('% Dedicació real compares with the distribution', async () => {
    jest.resetModules();
    global.strapi = {
      db: {
        query: (uid) => ({
          findMany: async () => {
            if (uid === 'api::activity.activity') {
              return [{ date: '2026-10-05', hours: 42.1, users_permissions_user: { id: 1 }, project: { id: 9, name: 'P' } }];
            }
            if (uid === 'api::festive.festive') return [{ date: '2026-10-12', users_permissions_user: null }];
            if (uid === 'plugin::users-permissions.user') {
              return [{ id: 1, username: 'quim', hidden: false, daily_dedications: [PERIOD], permissions: [] }];
            }
            return [];
          },
        }),
      },
    };
    const { buildRealDedicationGantt } = require('../src/api/project/services/realDedicationGantt');
    const { cells } = await buildRealDedicationGantt({ projectStateIds: [], year: 2026, view: 'month' });
    expect(cells[1]['2026-10']).toMatchObject({ hours: '42.10', expected: 74 });
    delete global.strapi;
  });
});
