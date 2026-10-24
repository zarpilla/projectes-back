'use strict';

/**
 * Shared financial calculation engine for a single project.
 *
 * Goal: be the SINGLE place that translates a populated project entity
 * (with its phases, original phases, periodifications and pre-aggregated
 * activities) into a flat stream of rows. Both the pivot endpoint
 * (`findWithEconomicDetail`) and the form's `doProjectInfoCalculations`
 * must derive their numbers from these rows so they cannot drift apart.
 *
 * The recent project-240 bugs (Hores previstes pulled from
 * project_original_phases, periodifications incorrectly applied to the
 * "orig" dimension) were both caused by having two parallel implementations
 * of the same business rules. Centralizing the row construction here
 * makes that class of bug structurally impossible.
 */

const _ = require('lodash');
const moment = require('moment');
const { adaptQuery, toDbArgs } = require('../../../services/query-adapter');
const { fiscalYearOf, fiscalYearEnd } = require('../../../services/fiscal-year');
const { lineTotal } = require('../../../services/budget-line');
/* global strapi */ // strapi injected at runtime for the stored-totals refresh functions.

const noPhaseInfo = { phase: '-', subphase: '-' };

/**
 * Resolve a project's default year, used when a row has no date and we
 * still need to assign it to a year bucket for VAT/deductible lookups.
 */
const getProjectDefaultYear = (project) => {
  if (!project) {
    return String(moment().format('YYYY'));
  }

  const extractYear = (value) => {
    if (!value) return null;
    if (value instanceof Date && !isNaN(value.getTime())) {
      return String(value.getFullYear());
    }
    if (typeof value === 'string') {
      const yearMatch = value.match(/\d{4}/);
      return yearMatch ? yearMatch[0] : null;
    }
    if (value && typeof value === 'object' && typeof value.toISOString === 'function') {
      return String(value.toISOString().substring(0, 4));
    }
    return null;
  };

  return extractYear(project.date_start) || extractYear(project.date_end) || String(moment().format('YYYY'));
};

/**
 * Year bucket for lines with no usable date. Kept as a sortable 4-digit
 * string so it groups like a year; the form shows it as "Sense data"
 * (issues/015).
 */
const UNDATED_YEAR = '9999';

// Without this, an undated line was bucketed under moment's "Invalid date".
// Same result as parsing with moment(date, 'YYYY-MM-DD'), without moment
// (issues/309): dayNumber and dayInfo are defined further down.
const rowDay = (date) => {
  if (!date) return null;
  const n = dayNumber(date);
  return Number.isNaN(n) ? null : dayInfo(n);
};

const rowYear = (date) => {
  const d = rowDay(date);
  return d ? d.year : UNDATED_YEAR;
};

const rowMonth = (date) => {
  const d = rowDay(date);
  return d ? d.str.substring(5, 7) : '12';
};

/**
 * Current-plan income/expense lines with neither an estimated nor a
 * document date. They land in the UNDATED_YEAR bucket, so the form warns
 * about them. Zero-amount lines are included: they still leave an empty
 * undated row in the periodification table (issues/015).
 */
const findUndatedLines = (p) => {
  const out = [];
  for (const ph of (p && p.project_phases) || []) {
    for (const [type, lines] of [
      ['income', ph.incomes],
      ['expense', ph.expenses],
    ]) {
      for (const line of lines || []) {
        if (line.date_estimate_document || line.date) continue;
        out.push({
          id: line.id,
          type,
          phase: ph.name || '',
          concept: line.concept || '',
          total_amount: lineTotal(line),
        });
      }
    }
  }
  return out;
};

const getEstimateYear = (item, fallbackYear = UNDATED_YEAR) => {
  if (item && item.date_estimate_document) {
    return item.date_estimate_document.substring(0, 4);
  }
  if (item && item.date) {
    return item.date.substring(0, 4);
  }
  return fallbackYear;
};

const getRealYear = (item) => {
  if (item && item.emitted) {
    return item.emitted.substring(0, 4);
  }
  if (item && item.paid_date) {
    return item.paid_date.substring(0, 4);
  }
  if (item && item.date) {
    return item.date.substring(0, 4);
  }
  return UNDATED_YEAR;
};

/**
 * VAT % of a budget line: its own "IVA" (`vat_pct`, what the project form
 * shows), else its type's, else 21. A 0 % is 0, not "unset" (issues/033).
 * The line's own VAT wins since issues/143: the totals used the type's even
 * when the line had another one.
 */
const isSet = (v) => v !== null && v !== undefined && v !== '';
const lineVatPct = (line, type) => {
  if (isSet(line.vat_pct)) return Number(line.vat_pct);
  if (type && isSet(type.vat_pct)) return Number(type.vat_pct);
  return 21;
};
const expenseVatPct = (line) => lineVatPct(line, line.expense_type);

/**
 * Export-only fields of a budget line's rows in the economic detail
 * (issues/142, issues/143): its forecast dates ("Previsió fac." and
 * "Previsió pag." in the form) and the whole VAT of the row's amount. The
 * `*_vat` columns are not that: they hold only the non-deductible VAT, a
 * cost, which is 0 when VAT is 100 % deductible.
 */
const lineExportFields = (line, type, amount) => {
  const vat_pct = lineVatPct(line, type);
  return {
    forecast_invoice_date: line.date_estimate_document || null,
    forecast_payment_date: line.date || null,
    vat_pct,
    vat: (amount * vat_pct) / 100.0 || 0,
  };
};

/*
 * Calendar days as integers (days since 1970-01-01) for the per-day planned
 * hours (issues/309). The engine built and formatted several moment objects per
 * planned day of every project: most of the time of Informes › Ingressos/
 * Despeses. Same days and weekdays as moment(date, 'YYYY-MM-DD') + add(i, 'days').
 */
const DAY_MS = 86400000;
const pad2 = (n) => (n < 10 ? `0${n}` : String(n));

/**
 * Day number of the calendar day y-m-d (month 1–12), or NaN when it doesn't
 * exist. Date.UTC turns the years 0–99 into 1900–1999 (a «0026-05-01» typo
 * became 1926 while moment reads year 26); setUTCFullYear doesn't.
 */
const dayNumberOf = (y, m, d) => {
  const t = new Date(0);
  t.setUTCFullYear(y, m - 1, d);
  return t.getUTCFullYear() === y && t.getUTCMonth() === m - 1 && t.getUTCDate() === d
    ? t.getTime() / DAY_MS
    : NaN;
};

/** Day number of a 'YYYY-MM-DD' date (or Date); NaN when moment finds it invalid. */
const dayNumber = (value) => {
  if (value instanceof Date) {
    return dayNumberOf(value.getFullYear(), value.getMonth() + 1, value.getDate());
  }
  const m = typeof value === 'string' && /^(\d{4})-(\d{2})-(\d{2})/.exec(value);
  // 2026-02-30 is invalid for moment, not 2 March
  if (m) {
    const n = dayNumberOf(+m[1], +m[2], +m[3]);
    if (!Number.isNaN(n)) return n;
  }
  const mm = moment(value, 'YYYY-MM-DD');
  return mm.isValid() ? dayNumberOf(mm.year(), mm.month() + 1, mm.date()) : NaN;
};

const daysBetween = (from, to) => to - from;

const dayInfoCache = new Map();
/** { str: 'YYYY-MM-DD', year: 'YYYY', dow: 0 (Sunday) – 6 } of a day number. */
const dayInfo = (n) => {
  let info = dayInfoCache.get(n);
  if (!info) {
    const d = new Date(n * DAY_MS);
    const year = String(d.getUTCFullYear()).padStart(4, '0');
    info = { str: `${year}-${pad2(d.getUTCMonth() + 1)}-${pad2(d.getUTCDate())}`, year, dow: d.getUTCDay() };
    dayInfoCache.set(n, info);
  }
  return info;
};

// Built once per festives / dedications list, not once per project and phase
// tree: a request hands the same lists to every project (issues/309).
const festiveLookups = new WeakMap();
const dedicationLookups = new WeakMap();

const calendarLookups = (festives, dailyDedications) => {
  let festive = festiveLookups.get(festives);
  if (!festive || festive.length !== festives.length) {
    const general = new Set();
    const personal = new Set();
    festives.forEach((f) => {
      if (f.users_permissions_user) personal.add(`${f.users_permissions_user.id}_${f.date}`);
      else general.add(f.date);
    });
    festive = { length: festives.length, on: (userId, day) => personal.has(`${userId}_${day}`) || general.has(day) };
    festiveLookups.set(festives, festive);
  }

  let dedications = dedicationLookups.get(dailyDedications);
  if (!dedications || dedications.length !== dailyDedications.length) {
    const byUser = new Map();
    dailyDedications.forEach((d) => {
      const userId = d.users_permissions_user ? d.users_permissions_user.id : null;
      if (!userId) return;
      if (!byUser.has(userId)) byUser.set(userId, []);
      byUser.get(userId).push(d);
    });
    dedications = { length: dailyDedications.length, byUser };
    dedicationLookups.set(dailyDedications, dedications);
  }

  return { festiveOn: festive.on, dedicationsByUser: dedications.byUser };
};

/**
 * Walk a project's phase tree (either current `project_phases` or the
 * locked `project_original_phases`) to compute daily/yearly totals.
 *
 * Used by:
 *   - `buildProjectRows` (twice, to derive the hours rows for the
 *     "Hores originals" and "Hores previstes" pivot columns).
 *   - `findEstimatedTotalsByDay` (the per-day breakdown endpoint).
 */
const calculateEstimatedTotals = async (
  data,
  phases,
  dailyDedications,
  festives,
  real, // or estimated
  // { lean: true } → `day` as 'YYYY-MM-DD' and no totalsByYear (issues/309)
  // { pure: true }  → the lines are not written to (total_amount,
  //   total_expenses_vat, total_estimated_hours): for data shared through the
  //   read cache, which is frozen (issues/307)
  opts,
) => {
  var total_estimated_hours = 0;
  var total_incomes = 0;
  var total_estimated_hours_price = 0;
  let total_expenses = 0;
  let total_expenses_vat = 0;

  let total_real_incomes = 0;
  let total_real_expenses = 0;
  let total_real_expenses_vat = 0;

  const totalsByDay = [];
  const rowsByYear = [];
  const lean = !!(opts && opts.lean);
  // the per-day row's `day`: a 'YYYY-MM-DD' string in lean mode, else a moment
  const dayValue = lean ? (d) => d.str : (d) => moment(d.str, 'YYYY-MM-DD');
  const pushYear = lean ? () => {} : (row) => rowsByYear.push(row);
  const keep = opts && opts.pure ? () => {} : (line, field, value) => { line[field] = value; };

  const { festiveOn, dedicationsByUser } = calendarLookups(festives, dailyDedications);

  if (phases && phases.length) {
    const projectDefaultYear = getProjectDefaultYear(data);

    for (var i = 0; i < phases.length; i++) {
      const phase = phases[i];
      if (phase.incomes && phase.incomes.length) {
        for (var j = 0; j < phase.incomes.length; j++) {
          const subphase = phase.incomes[j];
          var subphase_estimated_hours = 0;

          const subphaseAmount = lineTotal(subphase);
          keep(subphase, 'total_amount', subphaseAmount);
          total_incomes +=
            lineTotal(subphase);

          const ey = getEstimateYear(subphase, projectDefaultYear);
          pushYear({ year: ey, total_incomes: subphaseAmount });

          if (subphase.estimated_hours) {
            for (var k = 0; k < subphase.estimated_hours.length; k++) {
              const hours = subphase.estimated_hours[k];
              let hoursAmount = 0;
              if (hours.from && hours.to && hours.users_permissions_user && hours.users_permissions_user.id) {
                let mdiff = 1;
                const userId = hours.users_permissions_user.id;
                const userDedications = dedicationsByUser.get(userId) || [];
                const isWorkingDay = (d) => !(d.dow === 0 || d.dow === 6) && !festiveOn(userId, d.str);

                if (hours.quantity_type && (hours.quantity_type === 'month' || hours.quantity_type === 'week')) {
                  const from = dayNumber(hours.from);
                  mdiff = daysBetween(from, dayNumber(hours.to));
                  const q = hours.quantity_type === 'month' ? hours.quantity / 5 / 4.3 : hours.quantity / 5;

                  for (let i = 0; i < mdiff; i++) {
                    const day = dayInfo(from + i);
                    if (!isWorkingDay(day)) continue;

                    subphase_estimated_hours += q;
                    total_estimated_hours += q;

                    const dd = userDedications.find((d) => d.from <= day.str && d.to >= day.str);
                    const costByHour = dd && dd.costByHour ? dd.costByHour : 0;
                    hoursAmount += q * costByHour;
                    total_estimated_hours_price += q * costByHour;

                    totalsByDay.push({
                      day: dayValue(day),
                      q,
                      costByHour,
                      userId: userId,
                      project: data.id,
                      project_name: data.name,
                    });

                    pushYear({ year: day.year, total_estimated_hours: q });
                    pushYear({ year: day.year, total_estimated_hours_price: q * costByHour });
                  }
                } else {
                  subphase_estimated_hours += hours.quantity * mdiff;
                  total_estimated_hours += hours.quantity * mdiff;

                  const dd = userDedications.find((d) => d.from <= hours.from && d.to >= hours.from);
                  const costByHour = dd && dd.costByHour ? dd.costByHour : 0;

                  hoursAmount = (hours.quantity ? hours.quantity : 0) * mdiff * costByHour;
                  total_estimated_hours_price += (hours.quantity ? hours.quantity : 0) * mdiff * costByHour;

                  // issues/259: a «Total» amount is spread evenly over the
                  // working days of its range, from and to included, whatever
                  // its length (it used to be split by whole months, so a
                  // range under ~15 days produced no rows and its hours were
                  // lost from the stored totals). A range with no working day
                  // falls back to its calendar days, a reversed one to `from`.
                  const from = dayNumber(hours.from);
                  const span = Math.max(0, daysBetween(from, dayNumber(hours.to))) + 1;
                  const allDays = [];
                  const workingDays = [];
                  for (let i = 0; i < span; i++) {
                    const day = dayInfo(from + i);
                    allDays.push(day);
                    if (isWorkingDay(day)) workingDays.push(day);
                  }
                  const days = workingDays.length ? workingDays : allDays;
                  const q = (hours.quantity ? hours.quantity : 0) / days.length;

                  for (const day of days) {
                    totalsByDay.push({
                      day: dayValue(day),
                      q,
                      costByHour,
                      userId: userId,
                      project: data.id,
                      project_name: data.name,
                    });

                    pushYear({ year: day.year, total_estimated_hours: q });
                    pushYear({ year: day.year, total_estimated_hours_price: q * costByHour });
                  }
                }
              }
              keep(hours, 'total_amount', hoursAmount);
            }
            keep(subphase, 'total_estimated_hours', subphase_estimated_hours);
          }
          if (subphase.paid) {
            total_real_incomes +=
              lineTotal(subphase);
            if (real) {
              const realYear = getRealYear(
                subphase.income ? subphase.income : subphase.expense ? subphase.expense : subphase.invoice,
              );

              pushYear({
                year: realYear,
                total_real_incomes:
                  lineTotal(subphase),
              });
            }
          }
        }
      }
      if (phase.expenses && phase.expenses.length) {
        for (let j = 0; j < phase.expenses.length; j++) {
          const expense = phase.expenses[j];

          const expenseAmount = lineTotal(expense);
          keep(expense, 'total_amount', expenseAmount);
          total_expenses += lineTotal(expense);

          const expenseVat = (expenseAmount * expenseVatPct(expense)) / 100.0;
          keep(expense, 'total_expenses_vat', expenseVat);

          total_expenses_vat += expenseVat;

          const ey = getEstimateYear(expense, projectDefaultYear);
          pushYear({
            year: ey,
            total_expenses: expenseAmount,
            total_expenses_vat: expenseVat,
          });

          if (expense.paid) {
            total_real_expenses +=
              lineTotal(expense);

            if (real) {
              const realYear = getRealYear(expense.invoice ? expense.invoice : expense.expense);

              pushYear({
                year: realYear,
                total_real_expenses:
                  lineTotal(expense),
                total_real_expenses_vat: expense.invoice
                  ? expense.invoice.total_vat || 0
                  : expenseVat || 0,
              });
              total_real_expenses_vat += expense.invoice
                ? expense.invoice.total_vat || 0
                : expenseVat || 0;
            }
          }
        }
      }
    }
  }

  // not computed in lean mode (nothing reads it there)
  const totalsByYear = lean ? [] : _(rowsByYear)
    .groupBy('year')
    .map((rows, year) => ({
      year: year,
      total_expenses: _.sumBy(rows, 'total_expenses'),
      total_expenses_vat: _.sumBy(rows, 'total_expenses_vat'),
      total_incomes: _.sumBy(rows, 'total_incomes'),
      total_estimated_hours: _.sumBy(rows, 'total_estimated_hours'),
      total_estimated_hours_price: _.sumBy(rows, 'total_estimated_hours_price'),
      total_real_incomes: _.sumBy(rows, 'total_real_incomes'),
      total_real_expenses: _.sumBy(rows, 'total_real_expenses'),
      total_real_expenses_vat: _.sumBy(rows, (r) => r.total_real_expenses_vat || 0),
    }));

  return {
    data,
    total_expenses,
    total_incomes,
    total_estimated_hours,
    total_estimated_hours_price,
    total_real_incomes,
    total_real_expenses,
    total_expenses_vat,
    total_real_expenses_vat,
    totalsByDay,
    totalsByYear,
  };
};

/**
 * The `deductible_vat_pct` of a year: the year's own (Taules auxiliars ›
 * Anys) when it exists, else the global fallback (Configuració), else 100.
 * Shared by the project totals and the treasury «IVA previst» (issues/221).
 */
const deductibleVatPctForYear = (deductibleVatPctByYear, fallback_deductible_vat_pct, year) => {
  const key = year == null ? null : String(year);
  return key !== null && deductibleVatPctByYear.has(key)
    ? deductibleVatPctByYear.get(key)
    : parseFloat(fallback_deductible_vat_pct || 100);
};

/**
 * Build the deductible-ratio resolver for a project, using the
 * applicable `deductible_vat_pct` for the row's year (or the project
 * default year, or the global fallback).
 */
const makeGetDeductibleRatioForDate =
  (deductibleVatPctByYear, fallback_deductible_vat_pct, projectDefaultYear) => (dateValue) => {
    const extractedYear = (dateValue && String(dateValue).substring(0, 4)) || null;
    const appliedYear = extractedYear || projectDefaultYear;
    const deductible_vat_pct = deductibleVatPctForYear(
      deductibleVatPctByYear,
      fallback_deductible_vat_pct,
      appliedYear,
    );
    return (100.0 - deductible_vat_pct) / 100.0;
  };

const buildProjectInfo = (p) => ({
  id: p.id,
  project_name: p.name,
  project_scope: p.project_scope && p.project_scope.id ? p.project_scope.name : '',
  project_state: p.project_state && p.project_state.id ? p.project_state.name : '',
  project_type: p.project_type && p.project_type.id ? p.project_type.name : '',
  project_likelihood: p.project_likelihood && p.project_likelihood.id ? p.project_likelihood.name : '',
  project_leader: p.leader && p.leader.id ? p.leader.username : '',
  mother: p.mother && p.mother.id ? p.mother.name : p.name,
  structural_expenses: p.structural_expenses,
  grantable: p.grantable ? 1 : 0,
});

const pushEstimatedIncomeRows = (out, p, projectInfo) => {
  for (let j = 0; j < (p.project_phases || []).length; j++) {
    const ph = p.project_phases[j];
    for (let k = 0; k < (ph.incomes || []).length; k++) {
      const sph = ph.incomes[k];
      if (!(sph.quantity && sph.amount)) continue;

      const phaseInfo = { phase: ph.name, subphase: sph.concept };
      const document = sph.income || sph.expense || sph.invoice;
      const estimate_date = sph.date_estimate_document || sph.date;

      // Estimated income (all lines, paid or unpaid)
      out.push({
        ...projectInfo,
        ...phaseInfo,
        type: 'income',
        paid: sph.paid,
        date: estimate_date,
        income_orig: 0,
        income_esti: lineTotal(sph),
        income_real: 0,
        ...lineExportFields(sph, sph.income_type, lineTotal(sph)),
        year: rowYear(estimate_date),
        month: rowMonth(estimate_date),
        row_type: sph.income_type && sph.income_type.name ? sph.income_type.name : '',
        document,
      });

      // Real income (only if paid)
      if (sph.paid && document && document.emitted) {
        const real_date = document.emitted;
        out.push({
          ...projectInfo,
          ...phaseInfo,
          type: 'income',
          paid: sph.paid,
          date: real_date,
          income_orig: 0,
          income_esti: 0,
          income_real: lineTotal(sph),
          ...lineExportFields(sph, sph.income_type, lineTotal(sph)),
          year: rowYear(real_date),
          month: rowMonth(real_date),
          row_type: sph.income_type && sph.income_type.name ? sph.income_type.name : '',
          document,
        });
      }
    }
  }
};

const pushEstimatedExpenseRows = (out, p, projectInfo, getDeductibleRatio) => {
  for (let j = 0; j < (p.project_phases || []).length; j++) {
    const ph = p.project_phases[j];
    for (let k = 0; k < (ph.expenses || []).length; k++) {
      const sph = ph.expenses[k];
      if (!(sph.quantity && sph.amount)) continue;

      const phaseInfo = { phase: ph.name, subphase: sph.concept };
      const document = sph.invoice || sph.expense;
      const estimate_date = sph.date_estimate_document || sph.date;
      const vat_pct = expenseVatPct(sph);
      const estimatedDeductibleRatio = getDeductibleRatio(estimate_date);

      // Estimated expense (all lines, paid or unpaid)
      out.push({
        ...projectInfo,
        ...phaseInfo,
        type: 'expense',
        paid: sph.paid,
        expense_orig: 0,
        expense_orig_vat: 0,
        expense_esti: -1 * lineTotal(sph),
        expense_esti_vat: (-1 * estimatedDeductibleRatio * lineTotal(sph) * vat_pct) / 100.0,
        expense_real: 0,
        expense_real_vat: 0,
        ...lineExportFields(sph, sph.expense_type, -1 * lineTotal(sph)),
        date: estimate_date,
        year: rowYear(estimate_date),
        month: rowMonth(estimate_date),
        row_type: sph.expense_type && sph.expense_type.name ? sph.expense_type.name : '',
        document,
      });

      // Real expense (only if paid)
      if (sph.paid && document && document.emitted) {
        const real_date = document.emitted;
        // Match VAT calculation logic from calculateEstimatedTotals:
        // use invoice.total_vat if available, otherwise the calculated VAT.
        const calculated_vat = (lineTotal(sph) * vat_pct) / 100.0;
        const expense_vat =
          sph.invoice && sph.invoice.total_vat !== undefined ? sph.invoice.total_vat : calculated_vat;
        const realDeductibleRatio = getDeductibleRatio(real_date);

        out.push({
          ...projectInfo,
          ...phaseInfo,
          type: 'expense',
          paid: sph.paid,
          expense_orig: 0,
          expense_orig_vat: 0,
          expense_esti: 0,
          expense_esti_vat: 0,
          expense_real: -1 * lineTotal(sph),
          expense_real_vat: -1 * expense_vat * realDeductibleRatio,
          ...lineExportFields(sph, sph.expense_type, -1 * lineTotal(sph)),
          date: real_date,
          year: rowYear(real_date),
          month: rowMonth(real_date),
          row_type: sph.expense_type && sph.expense_type.name ? sph.expense_type.name : '',
          document,
        });
      }
    }
  }
};

const pushOriginalIncomeAndExpenseRows = (out, p, projectInfo, getDeductibleRatio) => {
  for (let j = 0; j < (p.project_original_phases || []).length; j++) {
    const ph = p.project_original_phases[j];

    for (let k = 0; k < (ph.incomes || []).length; k++) {
      const sph = ph.incomes[k];
      if (!(sph.quantity && sph.amount)) continue;

      const phaseInfo = { phase: ph.name, subphase: sph.concept };
      const document = sph.income || sph.expense || sph.invoice;
      const date = sph.date_estimate_document || sph.date;
      out.push({
        ...projectInfo,
        ...phaseInfo,
        type: 'income',
        date,
        income_orig: lineTotal(sph),
        income_esti: 0,
        income_real: 0,
        ...lineExportFields(sph, sph.income_type, lineTotal(sph)),
        year: rowYear(date),
        month: rowMonth(date),
        row_type: sph.income_type && sph.income_type.name ? sph.income_type.name : '',
        document,
      });
    }

    for (let k = 0; k < (ph.expenses || []).length; k++) {
      const sph = ph.expenses[k];
      if (!(sph.quantity && sph.amount)) continue;

      const phaseInfo = { phase: ph.name, subphase: sph.concept };
      const document = sph.invoice || sph.expense;
      const date = sph.date_estimate_document || sph.date;
      const vat_pct = expenseVatPct(sph);
      const originalDeductibleRatio = getDeductibleRatio(date);

      out.push({
        ...projectInfo,
        ...phaseInfo,
        type: 'expense',
        expense_orig: -1 * Math.abs(lineTotal(sph)),
        expense_orig_vat:
          (-1 * originalDeductibleRatio * Math.abs(lineTotal(sph)) * vat_pct) / 100.0,
        expense_esti: 0,
        expense_esti_vat: 0,
        expense_real: 0,
        ...lineExportFields(sph, sph.expense_type, -1 * Math.abs(lineTotal(sph))),
        date,
        year: rowYear(date),
        month: rowMonth(date),
        row_type: sph.expense_type && sph.expense_type.name ? sph.expense_type.name : '',
        document,
      });
    }
  }
};

// A periodification row's year is a fiscal year: its amounts are dated on
// the year's last day (31/12 for calendar-year entities).
const periodificationDate = (pp, startMonth = 1) => {
  const date = fiscalYearEnd(pp.year, startMonth);
  return { date, year: pp.year.toString(), month: date.substring(5, 7) };
};

const pushPeriodificationRows = (out, p, projectInfo, startMonth = 1) => {
  if (!p.periodification || !p.periodification.length) return;
  for (let j = 0; j < p.periodification.length; j++) {
    const pp = p.periodification[j];

    // Periodification entries are manual yearly adjustments entered in the
    // form's "PERIODIFICACIÓ" card. Mapping to dimensions:
    //
    //   - "Ingressos previstos" / "Despeses previstes" (pp.incomes /
    //     pp.expenses) adjust the ESTIMATED (previsió) dimension only. They
    //     must NOT touch the ORIGINAL dimension: the original baseline comes
    //     exclusively from project_original_phases and is meant to be a
    //     locked snapshot from project creation.
    //
    //   - "Ingressos executats" / "Despeses executades"
    //     (pp.real_incomes / pp.real_expenses) adjust the REAL (executat)
    //     dimension only.
    //
    //   - The ORIGINAL dimension is therefore never affected by manual
    //     periodification, so original_incomes_expenses always reflects the
    //     pure original baseline.
    //
    // Sign convention: phase expense rows store amounts as NEGATIVE
    // (already sign-flipped at row construction). The DB stores
    // periodification expense amounts as positive numbers (matching the
    // form's "positive totals" convention). To keep ONE sign convention
    // in the row stream, periodification expenses are negated here so
    // they accumulate correctly when the pivot frontend (and the form
    // aggregator) sum the column directly.
    out.push({
      ...projectInfo,
      ...noPhaseInfo,
      type: 'income',
      income_orig: 0,
      income_esti: pp.incomes || 0,
      income_real: pp.real_incomes || 0,
      ...periodificationDate(pp, startMonth),
      row_type: 'Periodificació',
    });

    out.push({
      ...projectInfo,
      ...noPhaseInfo,
      type: 'expense',
      expense_orig: 0,
      expense_orig_vat: 0,
      expense_esti: -1 * (pp.expenses || 0),
      expense_esti_vat: 0,
      expense_real: -1 * (pp.real_expenses || 0),
      expense_real_vat: 0,
      ...periodificationDate(pp, startMonth),
      row_type: 'Periodificació',
    });
  }
};

const pushRealActivityRows = (out, projectInfo, projectActivities) => {
  for (let j = 0; j < projectActivities.length; j++) {
    const pa = projectActivities[j];
    out.push({
      ...projectInfo,
      ...noPhaseInfo,
      type: 'real_hours',
      date: pa.year.toString() + '-' + pa.month.toString().padStart(2, '0') + '-01',
      total_original_hours_price: 0,
      total_estimated_hours_price: 0,
      total_real_hours_price: -1 * (pa.cost || 0),
      total_real_hours: pa.hours || 0,
      year: pa.year.toString().padStart(4, '0'),
      month: pa.month.toString().padStart(2, '0'),
      row_type: 'Hores reals',
    });
  }
};

const groupTotalsByYearMonth = (rows) =>
  _(
    rows.map((a) => ({
      ...a,
      ym: `${moment(a.day, 'YYYY-MM-DD').year()}.${moment(a.day, 'YYYY-MM-DD').month()}`,
    })),
  )
    .groupBy('ym')
    .map((groupRows, id) => ({
      year: parseInt(id.split('.')[0]),
      month: parseInt(id.split('.')[1]) + 1,
      cost: _.sumBy(groupRows, (r) => r.q * r.costByHour),
      q: _.sumBy(groupRows, (r) => r.q),
    }))
    .value();

/**
 * groupTotalsByYearMonth for lean per-day rows (`day` as 'YYYY-MM-DD'):
 * same groups in the same order, same sums added in the same order, without
 * parsing every day twice with moment (issues/309).
 */
const groupLeanTotalsByYearMonth = (rows) => {
  const groups = new Map();
  for (const r of rows) {
    const key = r.day.substring(0, 7);
    let g = groups.get(key);
    if (!g) {
      g = { year: parseInt(r.day.substring(0, 4), 10), month: parseInt(r.day.substring(5, 7), 10), cost: undefined, q: undefined };
      groups.set(key, g);
    }
    const cost = r.q * r.costByHour;
    g.cost = g.cost === undefined ? cost : g.cost + cost;
    g.q = g.q === undefined ? r.q : g.q + r.q;
  }
  return [...groups.values()];
};

/**
 * Planned hours of one project by person and month, for the "Prev./Real"
 * pivot (issues/067). Built from the same per-day rows as the project's stored
 * `total_estimated_hours` (working days, festives, only lines with a person),
 * so the pivot's total for a project matches the projects panel.
 *   estimated_hours           current plan (project_phases)
 *   original_estimated_hours  locked baseline (project_original_phases)
 *   estimated_hours_today     current plan up to and including `today`
 */
const buildPlannedHoursByMonth = async (p, dailyDedications, festives, today = moment()) => {
  const todayStr = moment(today).format('YYYY-MM-DD');
  const byKey = new Map();

  const add = async (phases, field, real) => {
    if (!phases || !phases.length) return;
    const { totalsByDay } = await calculateEstimatedTotals(
      { id: p.id, name: p.name },
      phases,
      dailyDedications,
      festives,
      real,
      // the project may come frozen from the read cache (issues/307)
      { lean: true, pure: true },
    );
    for (const t of totalsByDay) {
      const year = t.day.substring(0, 4);
      const month = t.day.substring(5, 7);
      const key = `${year}.${month}.${t.userId}`;
      if (!byKey.has(key)) {
        byKey.set(key, {
          year,
          month,
          user: t.userId,
          estimated_hours: 0,
          original_estimated_hours: 0,
          estimated_hours_today: 0,
        });
      }
      const row = byKey.get(key);
      row[field] += t.q;
      if (field === 'estimated_hours' && t.day <= todayStr) {
        row.estimated_hours_today += t.q;
      }
    }
  };

  // Same arguments as pushHoursRows, which feeds the stored totals.
  await add(p.project_phases, 'estimated_hours', true);
  await add(p.project_original_phases, 'original_estimated_hours', false);

  return _.sortBy([...byKey.values()], ['year', 'month', 'user']);
};

const pushHoursRows = async (out, p, projectInfo, ctx) => {
  // Hores originals come from project_original_phases (locked baseline).
  const { totalsByDay: originalTotalsByDay } = await calculateEstimatedTotals(
    { id: projectInfo.id, name: projectInfo.project_name },
    p.project_original_phases,
    ctx.dailyDedications,
    ctx.festives,
    undefined,
    { lean: true },
  );

  // Hores previstes come from the current plan (project_phases) — same
  // source as the form's `total_estimated_hours`.
  const { totalsByDay: estimatedTotalsByDay } = await calculateEstimatedTotals(
    { id: projectInfo.id, name: projectInfo.project_name },
    p.project_phases,
    ctx.dailyDedications,
    ctx.festives,
    true,
    { lean: true },
  );

  const groupedOriginalHours = groupLeanTotalsByYearMonth(originalTotalsByDay);
  const groupedEstimatedHours = groupLeanTotalsByYearMonth(estimatedTotalsByDay);

  for (let j = 0; j < groupedOriginalHours.length; j++) {
    const g = groupedOriginalHours[j];
    out.push({
      ...projectInfo,
      ...noPhaseInfo,
      type: 'original_hours',
      date: g.year.toString() + '-' + g.month.toString().padStart(2, '0') + '-01',
      total_original_hours_price: -1 * (g.cost || 0),
      total_original_hours: g.q || 0,
      total_estimated_hours_price: 0,
      total_real_hours_price: 0,
      year: g.year.toString(),
      month: g.month.toString().padStart(2, '0'),
      row_type: 'Hores originals',
    });
  }

  for (let j = 0; j < groupedEstimatedHours.length; j++) {
    const g = groupedEstimatedHours[j];
    out.push({
      ...projectInfo,
      ...noPhaseInfo,
      type: 'estimated_hours',
      date: g.year.toString() + '-' + g.month.toString().padStart(2, '0') + '-01',
      total_original_hours_price: 0,
      total_original_hours: 0,
      total_estimated_hours_price: -1 * (g.cost || 0),
      total_estimated_hours: g.q || 0,
      total_real_hours_price: 0,
      year: g.year.toString(),
      month: g.month.toString().padStart(2, '0'),
      row_type: 'Hores previstes',
    });
  }
};

/**
 * Rows are built with the calendar year of their date (the deductible VAT %
 * is looked up by it). For an entity whose fiscal year doesn't start in
 * January, `year` becomes the fiscal year so the form's years, the pivot and
 * its `year_eq` filter all follow it; `month` stays the calendar month.
 * Undated rows keep the UNDATED_YEAR bucket.
 */
const toFiscalYears = (rows, startMonth = 1) => {
  if (!startMonth || startMonth <= 1) return rows;
  for (const row of rows) {
    if (row.year === UNDATED_YEAR) continue;
    const year = fiscalYearOf(row.date, startMonth);
    if (year) row.year = year;
  }
  return rows;
};

/**
 * Build the flat row stream for a single project.
 *
 * @param {object} p - populated project entity (with project_phases,
 *   project_original_phases (each with incomes/expenses + nested
 *   document refs), periodification).
 * @param {object} ctx - precomputed context shared across projects:
 *   {
 *     dailyDedications: Array,
 *     festives: Array,
 *     deductibleVatPctByYear: Map<string, number>,
 *     fallback_deductible_vat_pct: number,
 *     activitiesByProject: Map<number, [{year,month,cost,hours}]>,
 *     fiscalYearStartMonth: number (1–12, optional; 1 = calendar year),
 *   }
 * @returns {Promise<Array>} row stream
 */
const buildProjectRows = async (p, ctx) => {
  const projectDefaultYear = getProjectDefaultYear(p);
  const projectInfo = buildProjectInfo(p);
  const getDeductibleRatio = makeGetDeductibleRatioForDate(
    ctx.deductibleVatPctByYear,
    ctx.fallback_deductible_vat_pct,
    projectDefaultYear,
  );

  const rows = [];

  pushEstimatedIncomeRows(rows, p, projectInfo);
  pushEstimatedExpenseRows(rows, p, projectInfo, getDeductibleRatio);
  pushOriginalIncomeAndExpenseRows(rows, p, projectInfo, getDeductibleRatio);
  pushPeriodificationRows(rows, p, projectInfo, ctx.fiscalYearStartMonth);

  const projectActivities = ctx.activitiesByProject.get(projectInfo.id) || [];
  pushRealActivityRows(rows, projectInfo, projectActivities);

  await pushHoursRows(rows, p, projectInfo, ctx);

  return toFiscalYears(rows, ctx.fiscalYearStartMonth);
};

/**
 * Group activities of a single project by year+month, summing hours and
 * cost. Mirrors the per-project pre-processing the pivot endpoint does
 * across all projects — exposed here so `doProjectInfoCalculations` can
 * build the `activitiesByProject` Map for one project without
 * duplicating logic.
 * Undated activities go to the UNDATED_YEAR bucket, like undated lines; they
 * were grouped under a NaN year (issues/205).
 */
const buildSingleProjectActivitiesMap = (projectId, activities) => {
  const grouped = _(
    (activities || []).map((a) => ({
      ...a,
      ym: `${rowYear(a.date)}.${rowMonth(a.date)}`,
    })),
  )
    .groupBy('ym')
    .map((rows, id) => ({
      projectId,
      year: parseInt(id.split('.')[0]),
      month: parseInt(id.split('.')[1]),
      cost: _.sumBy(rows, (r) => (r.hours || 0) * (r.cost_by_hour || 0)),
      hours: _.sumBy(rows, 'hours'),
    }))
    .value();
  return new Map([[projectId, grouped]]);
};

/**
 * Aggregate the flat row stream produced by `buildProjectRows` into the
 * year-grouped totals the form's RESUM FINANCER consumes.
 *
 * The row stream uses pivot sign convention:
 *   - incomes are positive
 *   - expenses, VAT and hours_price are negative (already sign-flipped)
 *   - hours counts are positive
 *
 * The form's `allByYear` schema uses POSITIVE values for expenses, VAT
 * and hours_price (the balance equation subtracts them). This function
 * performs the sign flip during aggregation so callers get form-style
 * totals without any extra bookkeeping.
 */
const aggregateRowsByYear = (rows) => {
  const grouped = _(rows)
    .groupBy('year')
    .map((groupRows, year) => {
      const sum = (field) =>
        _.sumBy(groupRows, (r) => (r[field] !== undefined && r[field] !== null ? parseFloat(r[field]) : 0));

      const total_original_incomes = sum('income_orig');
      const total_original_expenses = -sum('expense_orig');
      const total_original_expenses_vat = -sum('expense_orig_vat');
      const total_original_hours = sum('total_original_hours');
      const total_original_hours_price = -sum('total_original_hours_price');

      const total_estimated_incomes = sum('income_esti');
      const total_estimated_expenses = -sum('expense_esti');
      const total_estimated_expenses_vat = -sum('expense_esti_vat');
      const total_estimated_hours = sum('total_estimated_hours');
      const total_estimated_hours_price = -sum('total_estimated_hours_price');

      const total_real_incomes = sum('income_real');
      const total_real_expenses = -sum('expense_real');
      const total_real_expenses_vat = -sum('expense_real_vat');
      const total_real_hours = sum('total_real_hours');
      const total_real_hours_price = -sum('total_real_hours_price');

      return {
        year: String(year),

        // Original dimension
        total_original_incomes,
        total_original_expenses,
        total_original_expenses_vat,
        total_original_hours,
        total_original_hours_price,
        original_incomes_expenses:
          total_original_incomes -
          total_original_expenses -
          total_original_hours_price -
          total_original_expenses_vat,

        // Estimated dimension
        total_estimated_incomes,
        total_estimated_expenses,
        total_estimated_expenses_vat,
        total_estimated_hours,
        total_estimated_hours_price,
        estimated_incomes_expenses:
          total_estimated_incomes -
          total_estimated_expenses -
          total_estimated_hours_price -
          total_estimated_expenses_vat,

        // Real dimension
        total_real_incomes,
        total_real_expenses,
        total_real_expenses_vat,
        total_real_hours,
        total_real_hours_price,
        total_real_incomes_expenses:
          total_real_incomes - total_real_expenses - total_real_hours_price - total_real_expenses_vat,

        // Backwards compatibility (default = estimated dimension)
        total_incomes: total_estimated_incomes,
        total_expenses: total_estimated_expenses,
        total_expenses_vat: total_estimated_expenses_vat,
        incomes_expenses:
          total_estimated_incomes -
          total_estimated_expenses -
          total_estimated_hours_price -
          total_estimated_expenses_vat,
      };
    })
    .value();

  // Drop empty undated buckets (rows with no resolvable date). Every total
  // counts, the original ones too (issues/195: an undated original line was
  // dropped from the Original totals).
  return grouped.filter(
    (y) => y.year !== UNDATED_YEAR || Object.entries(y).some(([k, v]) => k !== 'year' && v !== 0),
  );
};

// ---------------------------------------------------------------------------
// Stored totals: read-only computation + targeted persistence.
//
// These functions exist so cross-entity writes (activity, diet, ticket,
// invoices, grants, expenses) can keep the project's persisted total_* columns
// in sync WITHOUT going through the project's beforeUpdate hook by writing a
// full graph back. They are intentionally not wired anywhere yet — they are
// the building blocks for the migration away from the dirty-queue.
// ---------------------------------------------------------------------------

// Scalar columns declared on the `project` content type that hold derived
// totals. Kept in sync manually with api/project/models/project.settings.json.
const STORED_TOTAL_FIELDS = [
  // Estimated dimension (also the backwards-compat defaults)
  'total_estimated_hours',
  'total_estimated_hours_price',
  'total_estimated_incomes',
  'total_estimated_expenses',
  'total_estimated_expenses_vat',
  'estimated_incomes_expenses',
  'estimated_balance',
  // Original dimension
  'total_original_incomes',
  'total_original_expenses',
  'total_original_hours',
  'total_original_hours_price',
  'total_original_expenses_vat',
  'original_incomes_expenses',
  // Real dimension
  'total_real_hours',
  'total_real_hours_price',
  'total_real_incomes',
  'total_real_expenses',
  'total_real_expenses_vat',
  'total_real_incomes_expenses',
  // Backwards-compat (default = estimated dimension)
  'total_incomes',
  'total_expenses',
  // NOTE: `total_expenses_hours` is intentionally NOT listed here. It's a
  // legacy mirror of `total_estimated_hours`, unused by the front-end, and
  // historic rows have it stored as 0. Treating it as canonical would make
  // verifyStoredTotals flag every project for a cosmetic diff. The column
  // is still written by doProjectInfoCalculations for backwards compat.
  'incomes_expenses',
  'balance',
];

// Relation populate path used everywhere we recompute totals. Kept in one
// place so beforeUpdate, calculateProject2, updateDirtyProjects and the new
// refresh path can't drift.
const PROJECT_GRAPH_FOR_TOTALS = [
  'activities',
  'activities.activity_type',
  'project_phases',
  'project_phases.incomes',
  'project_phases.incomes.estimated_hours',
  'project_phases.incomes.income_type',
  'project_phases.incomes.estimated_hours.users_permissions_user',
  'project_phases.incomes.invoice',
  'project_phases.incomes.income',
  'project_phases.expenses',
  'project_phases.expenses.expense_type',
  'project_phases.expenses.invoice',
  'project_phases.expenses.expense',
  'project_original_phases',
  'project_original_phases.incomes',
  'project_original_phases.incomes.estimated_hours',
  'project_original_phases.incomes.income_type',
  'project_original_phases.incomes.estimated_hours.users_permissions_user',
  'project_original_phases.incomes.invoice',
  'project_original_phases.incomes.income',
  'project_original_phases.expenses',
  'project_original_phases.expenses.expense_type',
  'project_original_phases.expenses.invoice',
  'project_original_phases.expenses.expense',
];

// v5 populate object equivalent (db.query uses nested objects, not dot-path arrays).
const PHASE_POPULATE = {
  incomes: {
    populate: {
      estimated_hours: { populate: { users_permissions_user: true } },
      income_type: true,
      invoice: true,
      income: true,
    },
  },
  expenses: { populate: { expense_type: true, invoice: true, expense: true } },
};
const PROJECT_GRAPH_FOR_TOTALS_POPULATE = {
  activities: { populate: { activity_type: true } },
  project_phases: { populate: PHASE_POPULATE },
  project_original_phases: { populate: PHASE_POPULATE },
};

const pickStoredTotals = (calculated) => {
  const picked = {};
  STORED_TOTAL_FIELDS.forEach((f) => {
    const v = calculated && calculated[f];
    // Normalise to plain numbers; null becomes 0 to match the column default.
    picked[f] = v === undefined || v === null ? 0 : parseFloat(v);
  });
  return picked;
};

// Recomputes the persisted totals for a single project WITHOUT writing.
// Returns { id, picked, calculated } or null if the project does not exist.
const computeStoredTotalsForProject = async (id) => {
  const numericId = parseInt(id, 10);
  if (!(numericId > 0)) return null;

  const data = await strapi.db
    .query('api::project.project')
    .findOne({ where: { id: numericId }, populate: PROJECT_GRAPH_FOR_TOTALS_POPULATE });
  if (!data) return null;

  // calculateProject lives on the project controller (the service is the bare
  // core one): calling it on the service failed every drain (issues/012).
  const calculated = await strapi.controller('api::project.project').calculateProject(data, numericId);
  return { id: numericId, picked: pickStoredTotals(calculated), calculated };
};

// Recomputes and persists ONLY the stored totals of a single project, in
// project_totals (issues/328): no lifecycle runs and `projects` isn't written.
const refreshStoredTotals = async (id) => {
  const result = await computeStoredTotalsForProject(id);
  if (!result) return null;

  // required here: project-totals reads STORED_TOTAL_FIELDS from this module
  const { writeTotals } = require('./project-totals');
  await writeTotals(result.id, result.picked, { dirty: false });

  return result.picked;
};

// Bulk refresher used for one-shot healing of stored totals across the whole
// project table. Sequential on purpose: each project loads a moderately large
// relation graph, parallelising would hammer the DB. Reports progress via
// strapi.log every `progressEvery` projects (default 25).
//
// Returns { processed, failed, errors: [{ id, error }] }.
const refreshAllStoredTotals = async (opts = {}) => {
  const { onlyPublished = true, progressEvery = 25, limit } = opts;

  // These are v3 query params, not columns. Passing them straight to db.query
  // as `where` made MySQL look for columns named `_limit`, `_sort` and
  // `published_at_null`. Run them through the adapter, which also knows that
  // v3's published_at_null maps onto v5's `trashed` flag.
  const v3Args = { _limit: limit && limit > 0 ? limit : -1, _sort: 'id:asc' };
  if (onlyPublished) v3Args.published_at_null = false;

  const projects = await strapi.db
    .query('api::project.project')
    .findMany(toDbArgs(adaptQuery(v3Args)));
  const ids = projects.map((p) => p.id);

  let processed = 0;
  let failed = 0;
  const errors = [];

  for (const id of ids) {
    try {
      await refreshStoredTotals(id);
      processed++;
    } catch (e) {
      failed++;
      errors.push({ id, error: e && e.message });
      strapi.log.error(`[refreshAllStoredTotals] project=${id}: ${e && e.message}`);
    }
    if (progressEvery > 0 && (processed + failed) % progressEvery === 0) {
      strapi.log.info(`[refreshAllStoredTotals] ${processed + failed}/${ids.length} (${failed} failed)`);
    }
  }

  return { total: ids.length, processed, failed, errors };
};

// Compares each project's currently stored totals against what
// computeStoredTotalsForProject would produce. Used as a one-shot
// verification before wiring refreshStoredTotals into lifecycle hooks.
//
// `ids` is an array of project ids; `epsilon` is the max absolute diff
// tolerated per field (default 0.01 cents).
const verifyStoredTotals = async (ids, epsilon = 0.01) => {
  const report = [];

  for (const rawId of ids) {
    const id = parseInt(rawId, 10);
    if (!(id > 0)) continue;

    const stored = await strapi.db.query('api::project.project').findOne({ where: { id } });
    if (!stored) {
      report.push({ id, error: 'not found' });
      continue;
    }

    const computed = await computeStoredTotalsForProject(id);
    if (!computed) {
      report.push({ id, error: 'compute failed' });
      continue;
    }

    const diffs = {};
    STORED_TOTAL_FIELDS.forEach((f) => {
      const a = stored[f] === undefined || stored[f] === null ? 0 : parseFloat(stored[f]);
      const b = computed.picked[f];
      if (Math.abs(a - b) > epsilon) {
        diffs[f] = { stored: a, computed: b, diff: b - a };
      }
    });

    report.push({
      id,
      name: stored.name,
      ok: Object.keys(diffs).length === 0,
      diffs,
    });
  }

  return {
    epsilon,
    total: report.length,
    okCount: report.filter((r) => r.ok).length,
    diffCount: report.filter((r) => !r.ok && !r.error).length,
    errorCount: report.filter((r) => r.error).length,
    report,
  };
};

/**
 * Build the "prevista" (forecast) income/expense totals per year for a set of
 * projects, the way ProjectForm's RESUM FINANCER computes them.
 *
 * Reuses the same row-construction functions as `buildProjectRows`, but skips
 * the hours and real-activity rows (irrelevant for the economic forecast):
 *   - estimated incomes  (all `project_phases.incomes` lines, paid or unpaid)
 *   - estimated expenses (base "factures" + VAT prorrata)
 *   - periodification    (selected via the `periodification` arg, see below)
 *
 * Periodification is driven by the `periodification` argument, mirroring the
 * view's "Periodificació" dropdown:
 *   - "no"       => no periodification rows
 *   - "prevista" => pp.incomes / pp.expenses  (the ESTIMATED/prevista dimension)
 *   - "real"     => pp.real_incomes / pp.real_expenses (the REAL/executat one)
 * The chosen values are written into the `income_esti` / `expense_esti` slots
 * so the existing aggregator picks them up; sign conventions match
 * `pushPeriodificationRows` (incomes positive, expenses negated). For any
 * other/unset value, periodification is treated as "no".
 *
 * The rows are dated by `date_estimate_document || date` (the previsió date)
 * inside the push* helpers, so `aggregateRowsByYear` buckets them per
 * previsió year automatically. Periodification rows are always dated
 * `${pp.year}-12-31`.
 *
 * `aggregateRowsByYear` sign-flips expenses/VAT to POSITIVE form values, so
 * the returned map exposes positive numbers for every field. Callers that
 * need expenses as negative (e.g. the treasury forecast table) negate them
 * themselves.
 *
 * Returns a plain object keyed by year (string) with:
 *   { forecast_incomes, forecast_expenses, forecast_expenses_vat }
 */
const buildEstimatedForecastByYearFromRows = (
  projects,
  deductibleVatPctByYear,
  fallback_deductible_vat_pct,
  periodification = 'no',
) => {
  const rows = [];
  const usePeriodification = periodification === 'prevista' || periodification === 'real';
  for (let i = 0; i < (projects || []).length; i++) {
    const p = projects[i];
    const projectDefaultYear = getProjectDefaultYear(p);
    const projectInfo = buildProjectInfo(p);
    const getDeductibleRatio = makeGetDeductibleRatioForDate(
      deductibleVatPctByYear,
      fallback_deductible_vat_pct,
      projectDefaultYear,
    );
    pushEstimatedIncomeRows(rows, p, projectInfo);
    pushEstimatedExpenseRows(rows, p, projectInfo, getDeductibleRatio);

    // Layer the selected periodification into the estimated slots.
    if (usePeriodification && p.periodification && p.periodification.length) {
      for (let j = 0; j < p.periodification.length; j++) {
        const pp = p.periodification[j];
        const inc = periodification === 'prevista' ? pp.incomes || 0 : pp.real_incomes || 0;
        const exp = periodification === 'prevista' ? pp.expenses || 0 : pp.real_expenses || 0;
        rows.push({
          ...projectInfo,
          ...noPhaseInfo,
          type: 'income',
          income_esti: inc,
          date: `${pp.year}-12-31`,
          year: pp.year.toString(),
          month: '12',
          row_type: 'Periodificació',
        });
        rows.push({
          ...projectInfo,
          ...noPhaseInfo,
          type: 'expense',
          // Negate to match the row-stream expense convention.
          expense_esti: -1 * exp,
          date: `${pp.year}-12-31`,
          year: pp.year.toString(),
          month: '12',
          row_type: 'Periodificació',
        });
      }
    }
  }

  const byYear = aggregateRowsByYear(rows);
  const map = {};
  for (let i = 0; i < byYear.length; i++) {
    const y = byYear[i];
    map[y.year] = {
      forecast_incomes: y.total_estimated_incomes,
      forecast_expenses: y.total_estimated_expenses,
      forecast_expenses_vat: y.total_estimated_expenses_vat,
    };
  }
  return map;
};

/**
 * The «prevista» forecast per year of Previsió econòmica (treasuries/forecast):
 * { year: { forecast_incomes, forecast_expenses, forecast_expenses_vat } }.
 *
 * Same result, bit for bit, as building the plan's economic-detail rows and
 * aggregating them with aggregateRowsByYear (buildEstimatedForecastByYearFromRows,
 * kept as the reference of the tests), without creating those rows: the same
 * values are added per year in the same order (issues/309: thousands of rows
 * with every project field were built on every call only to add three sums).
 * The undated year is dropped when everything in it, real amounts included, is 0.
 */
const buildEstimatedForecastByYear = (
  projects,
  deductibleVatPctByYear,
  fallback_deductible_vat_pct,
  periodification = 'no',
) => {
  const usePeriodification = periodification === 'prevista' || periodification === 'real';
  const byYear = new Map();
  // lodash sumBy: the first value, then + each next one
  const plus = (a, v) => (a === undefined ? v : a + v);
  const add = (year, v) => {
    let y = byYear.get(year);
    if (!y) {
      y = {};
      byYear.set(year, y);
    }
    // as aggregateRowsByYear reads a row's field: absent → 0, else parseFloat
    for (const k of ['inc', 'exp', 'vat', 'realInc', 'realExp', 'realVat']) {
      y[k] = plus(y[k], v[k] !== undefined && v[k] !== null ? parseFloat(v[k]) : 0);
    }
  };

  for (let i = 0; i < (projects || []).length; i++) {
    const p = projects[i];
    const getDeductibleRatio = makeGetDeductibleRatioForDate(
      deductibleVatPctByYear,
      fallback_deductible_vat_pct,
      getProjectDefaultYear(p),
    );
    const phases = p.project_phases || [];

    // pushEstimatedIncomeRows
    for (const ph of phases) {
      for (const sph of ph.incomes || []) {
        if (!(sph.quantity && sph.amount)) continue;
        const document = sph.income || sph.expense || sph.invoice;
        add(rowYear(sph.date_estimate_document || sph.date), { inc: lineTotal(sph) });
        if (sph.paid && document && document.emitted) {
          add(rowYear(document.emitted), { realInc: lineTotal(sph) });
        }
      }
    }

    // pushEstimatedExpenseRows
    for (const ph of phases) {
      for (const sph of ph.expenses || []) {
        if (!(sph.quantity && sph.amount)) continue;
        const document = sph.invoice || sph.expense;
        const estimate_date = sph.date_estimate_document || sph.date;
        const vat_pct = expenseVatPct(sph);
        const estimatedDeductibleRatio = getDeductibleRatio(estimate_date);
        add(rowYear(estimate_date), {
          exp: -1 * lineTotal(sph),
          vat: (-1 * estimatedDeductibleRatio * lineTotal(sph) * vat_pct) / 100.0,
        });
        if (sph.paid && document && document.emitted) {
          const real_date = document.emitted;
          const calculated_vat = (lineTotal(sph) * vat_pct) / 100.0;
          const expense_vat =
            sph.invoice && sph.invoice.total_vat !== undefined ? sph.invoice.total_vat : calculated_vat;
          add(rowYear(real_date), {
            realExp: -1 * lineTotal(sph),
            realVat: -1 * expense_vat * getDeductibleRatio(real_date),
          });
        }
      }
    }

    if (usePeriodification && p.periodification && p.periodification.length) {
      for (const pp of p.periodification) {
        const inc = periodification === 'prevista' ? pp.incomes || 0 : pp.real_incomes || 0;
        const exp = periodification === 'prevista' ? pp.expenses || 0 : pp.real_expenses || 0;
        add(pp.year.toString(), { inc });
        add(pp.year.toString(), { exp: -1 * exp });
      }
    }
  }

  // the group order of aggregateRowsByYear: lodash groupBy's object keys
  const order = Object.keys(Object.fromEntries([...byYear.keys()].map((y) => [y, true])));
  const map = {};
  for (const year of order) {
    const y = byYear.get(year);
    const totals = [y.inc, -y.exp, -y.vat, y.realInc, -y.realExp, -y.realVat];
    if (year === UNDATED_YEAR && totals.every((v) => v === 0)) continue;
    map[year] = {
      forecast_incomes: y.inc,
      forecast_expenses: -y.exp,
      forecast_expenses_vat: -y.vat,
    };
  }
  return map;
};


module.exports = {
  buildProjectRows,
  lineVatPct,
  aggregateRowsByYear,
  buildEstimatedForecastByYear,
  buildEstimatedForecastByYearFromRows,
  buildSingleProjectActivitiesMap,
  calculateEstimatedTotals,
  getProjectDefaultYear,
  getEstimateYear,
  getRealYear,
  UNDATED_YEAR,
  rowYear,
  toFiscalYears,
  findUndatedLines,
  // Exposed for tests / future reuse:
  noPhaseInfo,
  makeGetDeductibleRatioForDate,
  deductibleVatPctForYear,
  groupTotalsByYearMonth,
  groupLeanTotalsByYearMonth,
  dayNumber,
  dayNumberOf,
  dayInfo,
  buildPlannedHoursByMonth,
  // Stored-totals migration (step 1 — not yet wired into lifecycles):
  STORED_TOTAL_FIELDS,
  PROJECT_GRAPH_FOR_TOTALS,
  PROJECT_GRAPH_FOR_TOTALS_POPULATE,
  pickStoredTotals,
  computeStoredTotalsForProject,
  refreshStoredTotals,
  refreshAllStoredTotals,
  verifyStoredTotals,
};
