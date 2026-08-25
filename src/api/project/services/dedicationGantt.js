'use strict';
/* global strapi */

const moment = require('moment');
const _ = require('lodash');
const { capacityForMonth, capacityForWeek } = require('./ganttCapacity');

// Catalan short month names so the period labels are independent of the
// process-wide moment locale (the frontend renders these with moment 'ca').
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

// Port of DedicationGantt.vue processEstimatedHours: expands an estimated-hours
// range into one row per day. Only the selected phaseType is populated on the
// project, so this reads p[phaseType] directly.
function expandEstimatedHours(p, h, targetYear, festivesMap, dedications) {
  if (!h || !h.from || !h.to) return;

  const fromMoment = moment(h.from, 'YYYY-MM-DD');
  const toMoment = moment(h.to, 'YYYY-MM-DD');
  const mdiff = Math.round(moment.duration(toMoment.diff(fromMoment)).asDays());

  let estimated_hours = h.quantity && mdiff > 0 ? h.quantity / mdiff : 0;
  if (h.quantity_type === 'month') estimated_hours = h.quantity / 30;
  if (h.quantity_type === 'week') estimated_hours = h.quantity / 5;

  const weekendCount = h.quantity_type === 'month' || h.quantity_type === 'week';
  const userId = h.users_permissions_user && h.users_permissions_user.id ? h.users_permissions_user.id : null;
  const username =
    h.users_permissions_user && h.users_permissions_user.username ? h.users_permissions_user.username : '-';

  // Most relations (phases/incomes/estimated_hours.user aside) are not
  // populated here, so the remaining hour/total columns resolve to 0.
  // project_type and project_likelihood are eagerly loaded on the project, so
  // they are populated here and surface in the Excel export. The legacy
  // placeholder columns (project_leader, project_state, project_scope,
  // project_scope_name, project_client) were removed since they were always "-".
  const projectBase = {
    project_name: p.name,
    project_type: p.project_type && p.project_type.name ? p.project_type.name : '-',
    project_likelihood: p.project_likelihood && p.project_likelihood.name ? p.project_likelihood.name : '-',
    total_estimated_hours: 0,
    total_real_hours: 0,
    count: 1,
    day: 0,
    date: '-',
    hours: 0,
    estimated_hours: estimated_hours,
    dedication_type: '-',
    username: username,
  };

  for (let i = 0; i < mdiff; i++) {
    const currentDay = fromMoment.clone().add(i, 'days');
    const dayFormat = currentDay.format('YYYY-MM-DD');

    const festiveKey = `${dayFormat}-${userId || 'all'}`;
    const festiveKeyAll = `${dayFormat}-all`;
    const festive = festivesMap.get(festiveKey) || festivesMap.get(festiveKeyAll);

    const dayOfWeek = currentDay.day();
    if ((![0, 6].includes(dayOfWeek) && !festive && weekendCount) || !weekendCount) {
      const yr = currentDay.isoWeekYear();
      if (yr >= targetYear) {
        dedications.push(
          Object.assign({}, projectBase, {
            from: dayFormat,
            to: currentDay.clone().add(1, 'day').format('YYYY-MM-DD'),
            week: currentDay.isoWeek(),
            month: currentDay.format('MM'),
            year: yr,
          }),
        );
      }
    }
  }
}

// Builds the fully aggregated dedication Gantt table server-side, replacing
// the per-day expansion + re-aggregation previously done in
// DedicationGantt.vue / DedicationGanttChart.vue.
async function buildDedicationGantt({ projectStateIds, hoursType = 'previstes', year, view = 'month' }) {
  const targetYear = year || parseInt(moment().format('YYYY'), 10);
  const phaseType = hoursType === 'previstes' ? 'project_phases' : 'project_original_phases';

  // 1) Projects with the selected phase type populated (same shape & query as
  //    findWithPhases so the source data is identical to the old flow).
  const withRelated = [
    phaseType,
    `${phaseType}.incomes`,
    `${phaseType}.incomes.estimated_hours`,
    `${phaseType}.incomes.estimated_hours.users_permissions_user`,
    'project_type',
    'project_likelihood',
  ];

  const projectsCollection = await strapi
    .query('project')
    .model.query((qb) => {
      // Include project_type / project_likelihood FK columns so the nested
      // withRelated relations below can populate (Bookshelf eager-loading
      // needs the FK value present on the loaded model).
      qb.select('id', 'name', 'published_at', 'project_type', 'project_likelihood').where(
        'project_state',
        'in',
        projectStateIds.map((s) => parseInt(s, 10)),
      );
    })
    .fetchAll({ withRelated });

  const projectList = projectsCollection
    .map((entity) => entity)
    .filter((p) => p.published_at !== '' && p.published_at !== null);

  // 2) Users (leaders) with their daily dedications.
  const users = await strapi.query('user', 'users-permissions').find({ _limit: -1 }, ['daily_dedications']);

  // 3) Festives for the target year onward, with festive_type and user.
  const festives = await strapi
    .query('festive')
    .find({ date_gte: `${targetYear}-01-01`, _limit: -1 }, ['festive_type', 'users_permissions_user']);

  // Festives map keyed by `${date}-${userId|'all'}` for the day-expansion loop
  // (identical to the festivesMap built in DedicationGantt.vue).
  const festivesMap = new Map();
  festives.forEach((f) => {
    if (!f.date) return;
    const uid = f.users_permissions_user && f.users_permissions_user.id ? f.users_permissions_user.id : 'all';
    festivesMap.set(`${f.date}-${uid}`, f);
  });

  // 4) Expand estimated-hours ranges into per-day rows (the Excel payload).
  const dedications = [];
  for (let pi = 0; pi < projectList.length; pi++) {
    const p = projectList[pi];
    const phases = p[phaseType] || [];
    for (let i = 0; i < phases.length; i++) {
      const ph = phases[i];
      const incomes = (ph && ph.incomes) || [];
      for (let j = 0; j < incomes.length; j++) {
        const sph = incomes[j];
        const estimatedHours = (sph && sph.estimated_hours) || [];
        for (let k = 0; k < estimatedHours.length; k++) {
          expandEstimatedHours(p, estimatedHours[k], targetYear, festivesMap, dedications);
        }
      }
    }
  }

  // 5) Aggregate per visible-leader x period (mirrors
  //    DedicationGanttChart.vue dedicationsByLeaderAndPeriod).
  const visibleLeaders = users.filter((u) => !u.hidden);

  // Leaders payload (projected to the fields the client needs). Computed here
  // so the empty-dedications early return below can reuse it.
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

  // Match DedicationGanttChart.vue: when there are no dedication rows the
  // periods list is empty, so the whole table renders empty.
  if (dedications.length === 0) {
    return { leaders, periods: [], cells: {}, dedications: [] };
  }

  const leaderByUsername = Object.create(null);
  const bucket = Object.create(null);
  visibleLeaders.forEach((leader) => {
    leaderByUsername[leader.username] = leader;
    bucket[leader.id] = {};
  });

  // Project metadata by name so each tooltip row can carry its type /
  // likelihood without re-resolving it per row. Festive-type names (used as a
  // synthetic project name in 5b) fall back to the defaults below.
  const projectMeta = Object.create(null);
  for (let pi = 0; pi < projectList.length; pi++) {
    const p = projectList[pi];
    projectMeta[p.name] = {
      type: p.project_type && p.project_type.name ? p.project_type.name : '-',
      likelihood: p.project_likelihood && p.project_likelihood.name ? p.project_likelihood.name : '-',
    };
  }
  const EMPTY_META = { type: '-', likelihood: '-' };

  // Helper: add hours to a project entry, promoting it to object form on first
  // touch so it carries type/likelihood for the tooltip breakdown.
  function addProjectHours(entry, name, hrs) {
    if (!entry.projects[name]) {
      const meta = projectMeta[name] || EMPTY_META;
      entry.projects[name] = { hours: 0, type: meta.type, likelihood: meta.likelihood };
    }
    entry.projects[name].hours += hrs;
  }

  // 5a) Dedications.
  for (let i = 0; i < dedications.length; i++) {
    const d = dedications[i];
    if (!d.estimated_hours) continue;
    const leader = leaderByUsername[d.username];
    if (!leader) continue;
    const periodKey = periodKeyFromDate(d.from, view);
    const b = bucket[leader.id];
    let entry = b[periodKey];
    if (!entry) {
      entry = {
        periodKey,
        total: 0,
        projects: Object.create(null),
        dedications: [],
      };
      b[periodKey] = entry;
    }
    entry.total += d.estimated_hours;
    entry.dedications.push(d);
    addProjectHours(entry, d.project_name, d.estimated_hours);
  }

  // 5b) Festive date sets per leader (global ∪ user-specific).
  //
  // Festives are NOT added to `total` / the project breakdown anymore: counting
  // holiday hours as booked dedication double-counts them, since they also
  // reduce the period's expected capacity (see step 7 / capacityForMonth). The
  // holiday hours are instead surfaced via cell.festive, which the tooltip
  // renders as a dedicated "Festius" footer line — matching
  // buildRealDedicationGantt and /dedicaco-saldo.
  const globalFestiveDates = new Set();
  const festivesByUserId = Object.create(null);
  festives.forEach((f) => {
    if (!f.date) return;
    const u = f.users_permissions_user;
    if (u === null || u === undefined) {
      globalFestiveDates.add(f.date);
    } else if (u.id != null) {
      if (!festivesByUserId[u.id]) festivesByUserId[u.id] = new Set();
      festivesByUserId[u.id].add(f.date);
    }
  });

  // 6) Periods: driven by where estimated dedication hours fall (matches the
  //    DedicationGanttChart.vue periods computed property). Festives reduce
  //    each cell's expected capacity but do not add periods on their own — a
  //    month with only holidays and no dedication has nothing to show.
  const periodKeysSet = new Set();
  for (let i = 0; i < dedications.length; i++) {
    const d = dedications[i];
    if (d.from && d.estimated_hours) {
      periodKeysSet.add(periodKeyFromDate(d.from, view));
    }
  }

  const periods = Array.from(periodKeysSet)
    .sort()
    .map((key) => {
      if (view === 'month') {
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

  // 7) Precompute every cell (hours / percentage / cssClass / tooltip) so the
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
        // /dedicaco-saldo and buildRealDedicationGantt): weekends and festive
        // days contribute 0; each other weekday contributes the user's
        // daily-dedication hours. Computed from the period key (first of month
        // / Monday of week) so a late first dedication no longer truncates the
        // month.
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
          view === 'month'
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

  // 8) Leaders payload already projected in step 5.
  return {
    leaders,
    periods,
    cells,
    dedications: _.sortBy(dedications, ['year', 'month', 'project_name']),
  };
}

module.exports = { buildDedicationGantt };
