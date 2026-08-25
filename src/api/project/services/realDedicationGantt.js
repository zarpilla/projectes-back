'use strict';
/* global strapi */

const moment = require('moment');
const _ = require('lodash');
const { dailyHoursForFirstMatch, capacityForMonth, capacityForWeek } = require('./ganttCapacity');

// Catalan short month names so the period labels are independent of the
// process-wide moment locale (the frontend renders these with moment 'ca').
// Kept identical to dedicationGantt.js so the two pages share period labels.
const CA_MONTHS_SHORT = [
  'gen',
  'febr',
  'març',
  'abr',
  'maig',
  'juny',
  'jul',
  'ag',
  'set',
  'oct',
  'nov',
  'des',
];

// Mirrors DedicationGanttChart.vue periodKeyFromDate: calendar year + ISO week
// (week view) or zero-padded month (month view).
function periodKeyFromDate(dateStr, view) {
  if (!dateStr) return '';
  if (view === 'month') {
    return dateStr.length >= 7 ? dateStr.substring(0, 7) : dateStr;
  }
  const m = moment(dateStr, 'YYYY-MM-DD');
  const year = m.isoWeekYear();
  const week = m.isoWeek();
  return `${year}-W${String(week).padStart(2, '0')}`;
}

// Builds the real (done) dedication Gantt table from `activity` records,
// mirroring buildDedicationGantt but using logged hours instead of estimated
// hours. Returns the same { leaders, periods, cells, dedications } contract
// consumed by DedicationGanttChart.vue.
async function buildRealDedicationGantt({ projectStateIds, year, view = 'month' }) {
  const targetYear = year || parseInt(moment().format('YYYY'), 10);
  const safeView = view === 'week' ? 'week' : 'month';
  const stateIds = projectStateIds.map((s) => parseInt(s, 10)).filter((n) => !isNaN(n));

  // 1) Activities logged within the target year, on projects in the selected
  //    states. Extends the project-side knex pattern in dedicationGantt.js to
  //    the activity side: the activities table FK column to project is `project`
  //    and the projects table FK column to project_state is `project_state`
  //    (both confirmed by activity.settings.json / project.settings.json).
  const activitiesCollection = await strapi
    .query('activity')
    .model.query((qb) => {
      qb.whereBetween('date', [`${targetYear}-01-01`, `${targetYear}-12-31`]);
      if (stateIds.length) {
        qb.whereIn('project', function () {
          this.from('projects').select('id').whereIn('project_state', stateIds);
        });
      }
    })
    .fetchAll({
      withRelated: [
        'project',
        'project.project_type',
        'project.project_likelihood',
        'users_permissions_user',
      ],
    });

  const activities = activitiesCollection.map((entity) => entity);

  // 1b) Festives for the target year, with festive_type and user. Used to
  //     zero festive days out of each cell's expected capacity, mirroring
  //     /dedicacio-saldo (global festives apply to everyone, user-specific
  //     ones apply only to that user).
  const festives = await strapi
    .query('festive')
    .find({ date_gte: `${targetYear}-01-01`, date_lte: `${targetYear}-12-31`, _limit: -1 }, [
      'festive_type',
      'users_permissions_user',
    ]);

  // Global festive dates (users_permissions_user === null).
  const globalFestiveDates = new Set();
  // Per-user festive dates, keyed by user id.
  const festivesByUserId = Object.create(null);
  for (let i = 0; i < festives.length; i++) {
    const f = festives[i];
    if (!f.date) continue;
    const u = f.users_permissions_user;
    if (u === null || u === undefined) {
      globalFestiveDates.add(f.date);
    } else if (u.id != null) {
      if (!festivesByUserId[u.id]) festivesByUserId[u.id] = new Set();
      festivesByUserId[u.id].add(f.date);
    }
  }

  // 2) Users (leaders) with their daily dedications — needed both for the
  //    leaders payload and to compute each cell's expected hours.
  const users = await strapi.query('user', 'users-permissions').find({ _limit: -1 }, ['daily_dedications']);

  // Leaders payload (projected to the fields the client needs). Computed here
  // so the empty-activities early return below can reuse it.
  const leaders = users.map((u) => ({
    id: u.id,
    username: u.username,
    hidden: !!u.hidden,
    daily_dedications: (u.daily_dedications || []).map((dd) => ({
      from: dd.from,
      to: dd.to,
      hours: dd.hours,
    })),
  }));

  if (activities.length === 0) {
    return { leaders, periods: [], cells: {}, dedications: [] };
  }

  // 3) Aggregate per visible-leader x period (mirrors
  //    DedicationGanttChart.vue dedicationsByLeaderAndPeriod).
  const visibleLeaders = users.filter((u) => !u.hidden);

  const leaderById = Object.create(null);
  const bucket = Object.create(null);
  visibleLeaders.forEach((leader) => {
    leaderById[leader.id] = leader;
    bucket[leader.id] = {};
  });

  const dedications = [];
  const periodKeysSet = new Set();

  for (let i = 0; i < activities.length; i++) {
    const a = activities[i];
    if (!a.date || !a.hours) continue;

    const user = a.users_permissions_user;
    const userId = user && user.id ? user.id : null;
    const leader = userId ? leaderById[userId] : null;
    if (!leader) continue;

    const periodKey = periodKeyFromDate(a.date, safeView);
    if (!periodKey) continue;
    periodKeysSet.add(periodKey);

    const projectName = a.project && a.project.name ? a.project.name : '-';
    const typeName =
      a.project && a.project.project_type && a.project.project_type.name ? a.project.project_type.name : '-';
    const likelihoodName =
      a.project && a.project.project_likelihood && a.project.project_likelihood.name
        ? a.project.project_likelihood.name
        : '-';

    // Row for the Excel export (sparse shape consistent with dedicationGantt).
    dedications.push({
      project_name: projectName,
      username: user.username || '-',
      hours: a.hours,
      date: a.date,
      month: a.date ? a.date.substring(5, 7) : 0,
      year: a.date ? parseInt(a.date.substring(0, 4), 10) : 0,
    });

    const b = bucket[leader.id];
    let entry = b[periodKey];
    if (!entry) {
      entry = {
        periodKey,
        total: 0,
        projects: Object.create(null),
      };
      b[periodKey] = entry;
    }
    entry.total += a.hours;
    if (!entry.projects[projectName]) {
      entry.projects[projectName] = {
        hours: 0,
        type: typeName,
        likelihood: likelihoodName,
      };
    }
    entry.projects[projectName].hours += a.hours;
  }

  // 4) Periods: sorted union of activity period keys (matches the
  //    DedicationGanttChart.vue periods computed property). Periods are driven
  //    by where real hours were logged; festives reduce each cell's expected
  //    capacity but do not add periods on their own.
  const periods = Array.from(periodKeysSet)
    .sort()
    .map((key) => {
      if (safeView === 'month') {
        const parts = key.split('-');
        const yy = parseInt(parts[0], 10);
        const mm = parseInt(parts[1], 10);
        return {
          key,
          label: `${CA_MONTHS_SHORT[mm - 1]} ${yy}`,
          year: yy,
          month: parts[1],
        };
      }
      const parts = key.split('-W');
      const week = parseInt(parts[1], 10);
      return {
        key,
        label: `W${week}`,
        year: parseInt(parts[0], 10),
        week,
      };
    });

  // 5) Precompute every cell (hours / percentage / cssClass / tooltip) so the
  //    client only renders. Mirrors DedicationGanttChart.vue cellData.
  const cells = {};
  visibleLeaders.forEach((leader) => {
    cells[leader.id] = {};
    const b = bucket[leader.id];

    periods.forEach((period) => {
      const entry = b ? b[period.key] : null;

      let hours = '0.00';
      let percentage = '0';
      let cssClass = 'dedication-empty';
      let tooltip = 'Sense dedicació';

      if (entry) {
        hours = entry.total.toFixed(2);

        // Expected hours for this period, festive-aware (matches
        // /dedicacio-saldo): weekends and festive days contribute 0; each
        // other weekday contributes the user's daily-dedication hours.
        const userFestiveDates = festivesByUserId[leader.id];
        // Per-leader festive set = global festives ∪ this user's festives.
        // Built lazily once per leader and cached on the leader object.
        let festivesSet = leader._festivesSet;
        if (!festivesSet) {
          festivesSet = new Set(globalFestiveDates);
          if (userFestiveDates) {
            userFestiveDates.forEach((d) => festivesSet.add(d));
          }
          leader._festivesSet = festivesSet;
        }

        const capacity =
          safeView === 'month'
            ? capacityForMonth(period.key, leader.daily_dedications, festivesSet)
            : capacityForWeek(period.key, leader.daily_dedications, festivesSet);
        const expectedHours = capacity.expected;
        const festiveHours = capacity.festive;

        if (expectedHours > 0) {
          const pct = (entry.total / expectedHours) * 100;
          percentage = pct.toFixed(0);
          if (pct < 85) cssClass = 'dedication-low';
          else if (pct > 105) cssClass = 'dedication-high';
          else if (pct >= 95 && pct <= 105) cssClass = 'dedication-optimal';
          else cssClass = 'dedication-good';
        }

        // Per-project breakdown (hours + type + likelihood) so the client can
        // regroup the tooltip on the fly without refetching.
        const breakdown = [];
        const projectNames = Object.keys(entry.projects);
        for (let i = 0; i < projectNames.length; i++) {
          const name = projectNames[i];
          const info = entry.projects[name];
          breakdown.push({
            project: name,
            type: info.type,
            likelihood: info.likelihood,
            hours: info.hours,
          });
        }
        // Highest hours first — stable display order across groupings.
        breakdown.sort((a, b) => b.hours - a.hours);

        const diff = expectedHours - entry.total;

        const tooltipLines = [];
        for (let i = 0; i < breakdown.length; i++) {
          tooltipLines.push(`${breakdown[i].project}: ${breakdown[i].hours.toFixed(2)}h`);
        }
        tooltipLines.push('');
        tooltipLines.push(`Hores període: ${expectedHours.toFixed(2)}h`);
        if (diff > 0) tooltipLines.push(`Falten: ${diff.toFixed(2)}h`);
        else if (diff < 0) tooltipLines.push(`Sobren: ${Math.abs(diff).toFixed(2)}h`);
        tooltip = tooltipLines.join('\n');

        cells[leader.id][period.key] = {
          hours,
          percentage,
          cssClass,
          tooltip,
          breakdown,
          expected: expectedHours,
          festive: festiveHours,
          diff,
        };
        return;
      }

      cells[leader.id][period.key] = { hours, percentage, cssClass, tooltip };
    });
  });

  return {
    leaders,
    periods,
    cells,
    dedications: _.sortBy(dedications, ['year', 'month', 'project_name']),
  };
}

module.exports = { buildRealDedicationGantt };
