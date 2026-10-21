'use strict';

/**
 * Persones › «Crear bestretes» (POST payrolls/create-all) created advances for
 * people hidden from Persones (Ocult) or blocked, and for months whose period
 * has 0 h («sense jornada activa»). Only people with hours get them now.
 */

const USERS = [
  { id: 1, username: 'activa' },
  { id: 2, username: 'oculta', hidden: true },
  { id: 3, username: 'bloquejada', blocked: true },
  { id: 4, username: 'zero' },
  { id: 5, username: 'parcial' },
];
const PERIODS = {
  1: [{ id: 11, from: '2026-01-01', to: '2026-12-31', hours: 8, monthly_salary: 2000 }],
  2: [{ id: 21, from: '2026-01-01', to: '2026-12-31', hours: 8, monthly_salary: 2000 }],
  3: [{ id: 31, from: '2026-01-01', to: '2026-12-31', hours: 8, monthly_salary: 2000 }],
  4: [{ id: 41, from: '2026-01-01', to: '2026-12-31', hours: 0, monthly_salary: 2000 }],
  // working until June, then a 0 h period
  5: [
    { id: 51, from: '2026-01-01', to: '2026-06-30', hours: '6', monthly_salary: 2000 },
    { id: 52, from: '2026-07-01', to: '2026-12-31', hours: '0', monthly_salary: 2000 },
  ],
};

function setup() {
  const created = [];
  global.strapi = {
    db: {
      query: (uid) => ({
        findMany: async (args) => {
          if (uid === 'api::month.month') return Array.from({ length: 12 }, (_, i) => ({ id: i + 1, month: i + 1 }));
          if (uid === 'api::year.year') return [{ id: 7, year: 2026 }];
          if (uid === 'plugin::users-permissions.user') return USERS;
          if (uid === 'api::daily-dedication.daily-dedication') return PERIODS[args.where.users_permissions_user] || [];
          return [];
        },
        findOne: async () => null,
        create: async ({ data }) => {
          created.push(data);
          return { id: created.length, ...data, year: { id: data.year }, month: { id: data.month } };
        },
      }),
    },
  };
  jest.doMock('@strapi/strapi', () => ({
    factories: { createCoreController: (uid, fn) => fn({ strapi: global.strapi }) },
  }));
  const controller = require('../src/api/payroll/controllers/payroll');
  return { controller, created };
}

describe('payrolls/create-all only for people with hours', () => {
  beforeEach(() => jest.resetModules());

  it('skips hidden and blocked people and 0 h periods', async () => {
    const { controller, created } = setup();
    const { userPayrollsInfo } = await controller.createAll({ query: { year: '2026' } });
    const byUser = (id) => created.filter((p) => p.users_permissions_user === id);
    expect(byUser(1)).toHaveLength(12);
    expect(byUser(2)).toHaveLength(0);
    expect(byUser(3)).toHaveLength(0);
    expect(byUser(4)).toHaveLength(0);
    expect(byUser(5).map((p) => p.month)).toEqual([1, 2, 3, 4, 5, 6]);
    // the summary lists who is in Persones, not the hidden or blocked
    expect(userPayrollsInfo.map((u) => u.username)).toEqual(['activa', 'zero', 'parcial']);
  });
});
