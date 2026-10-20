'use strict';

// issues/290: with a weekly distribution Bestretes paid each worked day's
// hours / 8 of the salary (9,9,9,9,0,0,0 = 36 h a week paid 112,5 % instead of
// 90 %), and Persones › «Crear bestretes» (backend) took the month-end period's
// hours / 8, without the weekly distribution nor the split of 264. Both follow
// one rule now: weekly hours / 40 × monthly salary, a month where the period
// changes split by working days. The SAME CASES are in projectes-front
// tests/unit/payrollSalary.spec.js: keep both files in step.
const { monthSalary, periodMonthlySalary, weeklyHours } = require('../src/services/payroll-salary');

const period = (from, to, extra) => ({ from, to, hours: 8, monthly_salary: 2000, ...extra })
const YEAR = [period('2026-01-01', '2026-12-31')]
const DIST = [period('2026-01-01', '2026-06-15', { hours: 7.2, hoursperday: '9,9,9,9,0,0,0' }),
  period('2026-06-16', '2026-12-31', { hours: 8, monthly_salary: 2400 })]
const PARDO = [period('2024-01-01', '2024-10-21', { hours: 6, monthly_salary: 1988.05 }),
  period('2024-10-22', '2024-12-31', { hours: 6, monthly_salary: 3200 })]
const holiday = date => ({ date, users_permissions_user: null })
const vacation = date => ({ date, users_permissions_user: { id: 5 } })

describe('payroll salary of a month (issues/290)', () => {
  it('pays the share of a full 40-h week', () => {
    expect(weeklyHours({ hours: 7.5 })).toBe(37.5)
    expect(weeklyHours({ hours: 7.2, hoursperday: '9,9,9,9,0,0,0' })).toBe(36)
    expect(weeklyHours({ hours: 5, hoursperday: '8,8,8,0,0,6,0' })).toBe(30)
    expect(periodMonthlySalary({ hours: 8, monthly_salary: 2000 })).toBe(2000)
    // without a distribution: hours/8 × salary, master's rule
    expect(periodMonthlySalary({ hours: 6, monthly_salary: 3200 })).toBe(2400)
    expect(periodMonthlySalary({ hours: 7.2, hoursperday: '9,9,9,9,0,0,0', monthly_salary: 2000 })).toBeCloseTo(1800, 9)
    expect(periodMonthlySalary({ hours: 5, hoursperday: '8,8,8,0,0,6,0', monthly_salary: 2000 })).toBeCloseTo(1500, 9)
    expect(periodMonthlySalary(null)).toBe(0)
  })

  it('gives one period\'s figure to a whole month', () => {
    expect(monthSalary(2026, 1, YEAR, [])).toBeCloseTo(2000, 9)
    expect(monthSalary(2026, 3, DIST, [])).toBeCloseTo(1800, 9)
    expect(monthSalary(2026, 3, [period('2026-01-01', '2026-12-31', { hours: 5, hoursperday: '8,8,8,0,0,6,0' })], []))
      .toBeCloseTo(1500, 9)
    // holidays don't change it
    expect(monthSalary(2026, 1, YEAR, [holiday('2026-01-01'), holiday('2026-01-06')])).toBeCloseTo(2000, 9)
  })

  it('splits a month where the period changes by working days (issues/264)', () => {
    // Ana Pardo, October 2024: 15 days at 1.988,05 × 6/8, 8 at 3.200 × 6/8
    const pardo = (15 * 1988.05 * 0.75 + 8 * 2400) / 23
    expect(monthSalary(2024, 10, PARDO, [])).toBeCloseTo(pardo, 9)
    expect(Math.round(pardo)).toBe(1807)
    // June 2026: 9 days Mon–Thu at 1.800 (to 15/06), 11 weekdays at 2.400
    expect(monthSalary(2026, 6, DIST, [])).toBeCloseTo((9 * 1800 + 11 * 2400) / 20, 9)
    expect(monthSalary(2026, 6, DIST, [])).toBeCloseTo(2130, 9)
  })

  it('leaves out the holidays for everyone, not the personal days', () => {
    expect(monthSalary(2026, 6, DIST, [holiday('2026-06-24')])).toBeCloseTo((9 * 1800 + 10 * 2400) / 19, 9)
    expect(monthSalary(2026, 6, DIST, [vacation('2026-06-24')])).toBeCloseTo(2130, 9)
    // the holiday wins over a personal day on the same date (issues/246)
    expect(monthSalary(2026, 6, DIST, [vacation('2026-06-24'), holiday('2026-06-24')]))
      .toBeCloseTo((9 * 1800 + 10 * 2400) / 19, 9)
  })

  it('is 0 without a period', () => {
    expect(monthSalary(2025, 6, DIST, [])).toBe(0)
  })
})
