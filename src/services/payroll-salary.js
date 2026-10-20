'use strict';

/**
 * The salary of a month for the payrolls of Persones › «Crear bestretes»
 * (payrolls/create-all). The front's Bestretes and its «Crea» follow the same
 * rule in projectes-front src/domain/payrollSalary.js, with the same tests
 * (tests/payroll-salary.test.js here, tests/unit/payrollSalary.spec.js there):
 * keep both in step (issues/290).
 *
 * - A period pays the share of a full week (40 h) of its monthly salary: its
 *   weekly hours / 40 × monthly salary. Without a weekly distribution that is
 *   hours/dia × 5 / 40 = hours/8 × salary, master's rule; with one, the sum of
 *   the distribution (9,9,9,9,0,0,0 = 36 h = 90 %).
 * - A month where the period changes is split by its working days, each at its
 *   own period's figure (issues/264). A working day: inside a period, not a
 *   holiday for everyone (a personal festive, e.g. vacation, is paid), and a
 *   day of the distribution with hours (Monday to Friday without one).
 */
const moment = require('moment');

function periodHours(period, date) {
  if (!period) return 0;
  const day = moment(date, 'YYYY-MM-DD').day();
  if (period.hoursperday) {
    const value = parseFloat(String(period.hoursperday).split(',')[day === 0 ? 6 : day - 1]);
    return Number.isFinite(value) ? value : 0;
  }
  return day === 0 || day === 6 ? 0 : Number(period.hours) || 0;
}

function weeklyHours(period) {
  if (!period) return 0;
  if (period.hoursperday) {
    return String(period.hoursperday)
      .split(',')
      .slice(0, 7)
      .reduce((sum, value) => {
        const number = parseFloat(value);
        return sum + (Number.isFinite(number) ? number : 0);
      }, 0);
  }
  return (Number(period.hours) || 0) * 5;
}

function periodMonthlySalary(period) {
  return period ? ((Number(period.monthly_salary) || 0) * weeklyHours(period)) / 40 : 0;
}

const personalFestive = (festive) =>
  !!(
    festive &&
    festive.users_permissions_user &&
    (festive.users_permissions_user.id || typeof festive.users_permissions_user !== 'object')
  );

function isSalaryDay(period, date, festive) {
  if (!period || (festive && !personalFestive(festive))) return false;
  if (period.hoursperday) return periodHours(period, date) > 0;
  const day = moment(date, 'YYYY-MM-DD').day();
  return day !== 0 && day !== 6;
}

const salaryPeriodOn = (date, periods) =>
  (periods || []).find((p) => date >= p.from && date <= p.to) || null;

// the holiday for everyone before a personal day (front countedFestiveOn, issues/246)
function countedFestiveOn(date, festives) {
  const onDate = (festives || []).filter((f) => f.date === date);
  return onDate.find((f) => !f.users_permissions_user) || onDate[0] || null;
}

// `festives`: the holidays for everyone and the person's own ones
function monthSalary(year, month, periods, festives) {
  const day = moment(`${year}-${month}-01`, 'YYYY-M-DD');
  const end = day.clone().endOf('month');
  let sum = 0;
  let days = 0;
  for (; day.isSameOrBefore(end, 'day'); day.add(1, 'day')) {
    const date = day.format('YYYY-MM-DD');
    const period = salaryPeriodOn(date, periods);
    if (isSalaryDay(period, date, countedFestiveOn(date, festives))) {
      sum += periodMonthlySalary(period);
      days++;
    }
  }
  return days ? sum / days : 0;
}

module.exports = { weeklyHours, periodMonthlySalary, isSalaryDay, salaryPeriodOn, countedFestiveOn, monthSalary };
