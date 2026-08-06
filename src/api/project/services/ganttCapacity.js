'use strict';

const moment = require('moment');

// Shared capacity helpers for the dedication Gantt tables (previsió and real).
//
// Both buildDedicationGantt (dedicationGantt.js) and buildRealDedicationGantt
// (realDedicationGantt.js) need the same festive-aware expected-hours model,
// so the logic lives here once. Capacity semantics mirror /dedicaco-saldo
// (see DedicationSaldo.vue):
//   - each weekday contributes the user's daily-dedication hours for that day,
//   - weekends contribute 0,
//   - festive days (global ∪ user-specific) contribute 0 to `expected` and
//     their hours are accumulated into `festive` so the tooltip can surface
//     them as a single "Festius" line instead of inflating Total hores.

// daily-dedication hours resolution: first matching range wins, default 8
// (matches DedicationGanttChart.vue cellData handling).
function dailyHoursForFirstMatch(dailyDedications, dateStr) {
  if (dailyDedications) {
    for (let j = 0; j < dailyDedications.length; j++) {
      const dd = dailyDedications[j];
      if (dd.from <= dateStr && dd.to >= dateStr) {
        return dd.hours;
      }
    }
  }
  return 8;
}

// Expected hours for a month period, festive-aware (saldo-equivalent).
// Iterates every day from the first of `periodKey`'s month to its end,
// resolving dailyHours per-day so mid-month daily-dedication range changes
// are honored.
//
// `festivesSet` is a Set of "YYYY-MM-DD" strings applicable to the user
// (global festives ∪ user-specific festives), or null/undefined to skip
// festive handling (treats every weekday as working).
//
// Returns { expected, festive } where `festive` is the total
// daily-dedication hours the festive weekdays consumed (i.e. the capacity
// removed by holidays).
function capacityForMonth(periodKey, dailyDedications, festivesSet) {
  const start = moment(periodKey + '-01', 'YYYY-MM-DD');
  if (!start.isValid()) return { expected: 0, festive: 0 };
  // daysInMonth() is the exact number of calendar days in this month, so the
  // loop covers day 1 .. end-of-month with no off-by-one (the previous
  // endOf("month") + Math.round(duration) form leaked the 1st of next month).
  const totalDays = start.daysInMonth();

  let expected = 0;
  let festive = 0;
  for (let i = 0; i < totalDays; i++) {
    const day = start.clone().add(i, 'day');
    const dow = day.day();
    // Weekend -> 0 expected (matches saldo `day !== 0 && day !== 6` guard).
    if (dow === 0 || dow === 6) continue;
    const dateStr = day.format('YYYY-MM-DD');
    const dh = dailyHoursForFirstMatch(dailyDedications, dateStr);
    // Festive (global or user-specific) -> 0 expected, but its hours count
    // toward the festive total so the tooltip can show holiday capacity.
    if (festivesSet && festivesSet.has(dateStr)) {
      festive += dh;
      continue;
    }
    expected += dh;
  }
  return { expected, festive };
}

// Expected hours for an ISO-week period, festive-aware (saldo-equivalent).
// A week is taken as 5 working days (Mon-Fri); festive weekdays reduce the
// count just like in the month view. Returns { expected, festive } — see
// capacityForMonth for the festive semantics.
function capacityForWeek(periodKey, dailyDedications, festivesSet) {
  const parts = periodKey.split('-W');
  const year = parseInt(parts[0], 10);
  const week = parseInt(parts[1], 10);
  if (!year || !week) return { expected: 0, festive: 0 };

  // Monday of the ISO week.
  const monday = moment().isoWeekYear(year).isoWeek(week).isoWeekday(1);
  if (!monday.isValid()) return { expected: 0, festive: 0 };

  let expected = 0;
  let festive = 0;
  for (let d = 0; d < 7; d++) {
    const day = monday.clone().add(d, 'day');
    const dow = day.day();
    if (dow === 0 || dow === 6) continue;
    const dateStr = day.format('YYYY-MM-DD');
    const dh = dailyHoursForFirstMatch(dailyDedications, dateStr);
    if (festivesSet && festivesSet.has(dateStr)) {
      festive += dh;
      continue;
    }
    expected += dh;
  }
  return { expected, festive };
}

module.exports = {
  dailyHoursForFirstMatch,
  capacityForMonth,
  capacityForWeek,
};
