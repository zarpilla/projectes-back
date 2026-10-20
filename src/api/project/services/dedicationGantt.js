'use strict';
/* global strapi */

const moment = require('moment');
const _ = require('lodash');
const { capacityForMonth, capacityForWeek, weekLabel } = require('./ganttCapacity');
const { calculateEstimatedTotals, dayNumber, dayInfo } = require('./projectFinancials');

const DAY_MS = 86400000;

// ISO week and its year of a day number, as moment's isoWeek() and
// isoWeekYear() (issues/309: they were computed with moment for every planned
// day): the week of the Thursday of the day's Monday–Sunday week.
const isoWeekCache = new Map();
function isoWeekOf(n) {
  let w = isoWeekCache.get(n);
  if (!w) {
    const dow = dayInfo(n).dow || 7;
    const thursday = n + 4 - dow;
    const year = new Date(thursday * DAY_MS).getUTCFullYear();
    const week = Math.floor((thursday - Date.UTC(year, 0, 1) / DAY_MS) / 7) + 1;
    w = { year, week };
    isoWeekCache.set(n, w);
  }
  return w;
}

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
  const n = dayNumber(dateStr);
  if (Number.isNaN(n)) return 'NaN-WNaN';
  const { year, week } = isoWeekOf(n);
  return `${year}-W${String(week).padStart(2, '0')}`;
}

// Every period of the calendar year `year`: its 12 months (month view) or the
// ISO weeks its days fall in (week view). The columns no longer depend on
// where planned hours happen to fall: a month without any was missing, and
// rows of the next years added columns (issues/237).
function periodKeysOfYear(year, view) {
  if (view === 'month') {
    return Array.from({ length: 12 }, (_v, i) => `${year}-${String(i + 1).padStart(2, '0')}`);
  }
  const keys = [];
  const day = moment(`${year}-01-01`, 'YYYY-MM-DD');
  while (day.year() === year) {
    const key = periodKeyFromDate(day.format('YYYY-MM-DD'), view);
    if (keys[keys.length - 1] !== key) keys.push(key);
    day.add(1, 'day');
  }
  return keys;
}

// The planned hours of one project, one row per person and day within the
// calendar year `targetYear` (the Excel payload). They come from
// calculateEstimatedTotals, the source of the project's stored
// `total_estimated_hours`, Prev./Real and Informes › Dedicació
// (buildPlannedHoursByMonth, issues/067), so «15 h/mes» is ~15 h a month on
// every screen. The old per-day formula here spread «h/mes» as quantity/30
// per weekday (~70 %) and kept every day from the target year onward
// (issues/237).
async function plannedHoursRows(p, phases, targetYear, dailyDedications, festives, usernameById, dedications) {
  if (!phases || !phases.length) return;
  const { totalsByDay } = await calculateEstimatedTotals(
    { id: p.id, name: p.name },
    phases,
    dailyDedications,
    festives,
    false,
    // days as 'YYYY-MM-DD', no moment per planned day (issues/309)
    { lean: true },
  );

  // Most relations are not populated here, so the remaining hour/total
  // columns resolve to 0. project_type and project_likelihood are eagerly
  // loaded on the project and surface in the Excel export.
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
    dedication_type: '-',
  };

  const yearStr = String(targetYear).padStart(4, '0');
  for (let i = 0; i < totalsByDay.length; i++) {
    const t = totalsByDay[i];
    if (!t.q || t.day.substring(0, 4) !== yearStr) continue;
    const n = dayNumber(t.day);
    dedications.push(
      Object.assign({}, projectBase, {
        estimated_hours: t.q,
        user_id: t.userId,
        username: usernameById[t.userId] || '-',
        from: t.day,
        to: dayInfo(n + 1).str,
        week: isoWeekOf(n).week,
        month: t.day.substring(5, 7),
        year: targetYear,
      }),
    );
  }
}

// Builds the fully aggregated dedication Gantt table server-side, replacing
// the per-day expansion + re-aggregation previously done in
// DedicationGantt.vue / DedicationGanttChart.vue.
// `rows: false` leaves out the per-day rows (`dedications`), only needed by
// the Excel export: 12 of the 12.2 MB of the response on resilience
// (issues/309). The screen asks for them when «Exporta» is clicked.
async function buildDedicationGantt({ projectStateIds, hoursType = 'previstes', year, view = 'month', rows = true }) {
  const targetYear = year || parseInt(moment().format('YYYY'), 10);
  const phaseType = hoursType === 'previstes' ? 'project_phases' : 'project_original_phases';

  // 1) Projects with the selected phase type populated (same shape & query as
  //    findWithPhases so the source data is identical to the old flow).
  // v5: Bookshelf fetchAll replaced by db.query findMany with nested populate
  // (same shape & filters as findWithPhases so the source data is identical).
  const projectsCollection = await strapi.db.query('api::project.project').findMany({
    // `select` takes SCALAR columns only. project_type / project_likelihood were
    // FK columns in v3 but are relations in v5, living in link tables — naming
    // them here makes the query select `t0.project_type`, which does not exist
    // ("Unknown column 't0.project_type' in 'field list'"). They come back via
    // `populate` below.
    select: ['id', 'name', 'trashed'],
    where: { project_state: { $in: projectStateIds.map((s) => parseInt(s, 10)) } },
    populate: {
      [phaseType]: {
        populate: {
          incomes: {
            populate: {
              estimated_hours: { populate: { users_permissions_user: true } },
            },
          },
        },
      },
      project_type: true,
      project_likelihood: true,
    },
  });

  const projectList = projectsCollection.filter((p) => p.trashed !== true);

  // 2) Users (leaders) with their daily dedications.
  const users = await strapi.db
    .query('plugin::users-permissions.user')
    .findMany({ populate: { daily_dedications: true, permissions: true } });

  // 3) Festives, with festive_type and user. All of them, as phases-both
  //    does: a «Total» line is spread over the working days of its whole
  //    range (issues/259), so a line crossing the year end needs the other
  //    year's festives too, or they count as working days and the chosen
  //    year gets fewer hours than every other screen (issues/289). The
  //    capacity only looks at the chosen year's days (issues/265).
  const festives = await strapi.db.query('api::festive.festive').findMany({
    populate: { festive_type: true, users_permissions_user: true },
  });

  // 4) Planned hours per person and day of the target year (the Excel
  //    payload), from the same source as the other screens (issues/237).
  const dailyDedications = [];
  const usernameById = Object.create(null);
  users.forEach((u) => {
    usernameById[u.id] = u.username;
    (u.daily_dedications || []).forEach((dd) =>
      dailyDedications.push(Object.assign({}, dd, { users_permissions_user: { id: u.id } })),
    );
  });
  const dedications = [];
  for (let pi = 0; pi < projectList.length; pi++) {
    const p = projectList[pi];
    await plannedHoursRows(p, p[phaseType], targetYear, dailyDedications, festives, usernameById, dedications);
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
    // can log hours: logistics members (orders only) are users too, and were
    // listed as «persones sense hores» (issues/109)
    works: (u.permissions || []).some((pm) => ['projects', 'hours'].includes(pm && pm.permission)),
    daily_dedications: (u.daily_dedications || []).map((dd) => ({
      from: dd.from,
      to: dd.to,
      hours: dd.hours,
    })),
  }));

  const bucket = Object.create(null);
  visibleLeaders.forEach((leader) => {
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
    const b = bucket[d.user_id];
    if (!b) continue;
    const periodKey = periodKeyFromDate(d.from, view);
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

  // 6) Periods: every month (or week) of the target calendar year, with or
  //    without planned hours (issues/237).
  const periods = periodKeysOfYear(targetYear, view).map((key) => {
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
        label: weekLabel(key),
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
            : capacityForWeek(period.key, leader.daily_dedications, festivesSet, targetYear);
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
          // hours but no working day defined to compare with: the percentage
          // is not 0 % (issues/077)
          noSchedule: !(expectedHours > 0),
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
    dedications: rows ? _.sortBy(dedications, ['year', 'month', 'project_name']) : [],
  };
}

module.exports = { buildDedicationGantt, periodKeyFromDate, isoWeekOf };
