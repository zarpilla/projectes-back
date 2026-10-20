'use strict';

/**
 * issues/290 (2026-10-20, review 9): Persones › «Crear bestretes»
 * (POST payrolls/create-all) took the month-end period's hours / 8 × salary.
 * prova.hores with 01/01–15/06/2026 at 7,2 h and 9,9,9,9,0,0,0 (36 h a week,
 * 2.000 €) got 1.800 € by chance, but «8,8,8,0,0,6,0» gave 1.250 € instead of
 * 1.500 €, and June (a new period from 16/06) 2.400 € where Bestretes «Crea»
 * splits the month by days. It now takes services/payroll-salary.js, the rule
 * of the front's payrollSalary.js.
 */

const { monthSalary } = require('../src/services/payroll-salary');

const PERIODS = [
  { id: 1, from: '2026-01-01', to: '2026-06-15', hours: 5, hoursperday: '8,8,8,0,0,6,0', monthly_salary: 2000, quota: 300 },
  { id: 2, from: '2026-06-16', to: '2026-12-31', hours: 8, monthly_salary: 2400, pct_quota: 30, pct_irpf: 10 },
];
const FESTIVES = [
  { date: '2026-06-24', users_permissions_user: null },
  { date: '2026-06-25', users_permissions_user: { id: 99 } }, // somebody else's
  { date: '2026-06-26', users_permissions_user: { id: 5 } },
];

function setup() {
  const created = [];
  global.strapi = {
    db: {
      query: (uid) => ({
        findMany: async () => {
          if (uid === 'api::month.month') return Array.from({ length: 12 }, (_, i) => ({ id: i + 1, month: i + 1 }));
          if (uid === 'api::year.year') return [{ id: 7, year: 2026 }];
          if (uid === 'plugin::users-permissions.user') return [{ id: 5, username: 'prova.hores' }];
          if (uid === 'api::daily-dedication.daily-dedication') return PERIODS;
          if (uid === 'api::festive.festive') return FESTIVES;
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

describe('payrolls/create-all amounts (issues/290)', () => {
  beforeEach(() => jest.resetModules());

  it('gives Bestretes\' amounts: weekly hours / 40, the month split by days', async () => {
    const { controller, created } = setup();
    await controller.createAll({ query: { year: '2026' } });
    expect(created).toHaveLength(12);
    const march = created.find((p) => p.month === 3);
    expect(march.total_base).toBe(1500); // 30 h / 40 × 2.000
    expect(march.ss_base).toBe(300);
    const june = created.find((p) => p.month === 6);
    // to 15/06: 9 days (Mon–Wed and Saturdays) at 1.500; then 10 weekdays at 2.400
    // (24/06 is a holiday for everyone, 26/06 the person's own day is paid)
    const expected = Number(monthSalary(2026, 6, PERIODS, [FESTIVES[0], FESTIVES[2]]).toFixed(2));
    expect(expected).toBeCloseTo((9 * 1500 + 10 * 2400) / 19, 2);
    expect(june.total_base).toBe(expected);
    expect(june.ss_base).toBeCloseTo(expected * 0.3, 6);
    expect(june.irpf_base).toBeCloseTo(expected * 0.1, 6);
    expect(june.net_base).toBeCloseTo(expected * 0.9, 6);
    expect(created.find((p) => p.month === 9).total_base).toBe(2400);
  });
});
