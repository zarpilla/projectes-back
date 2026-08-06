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

const getEstimateYear = (item, fallbackYear = '9999') => {
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
  return '9999';
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

  // Pre-create Maps for O(1) lookups instead of O(n) array.find()
  const festivesByDate = new Map();
  const festivesByUserAndDate = new Map();
  festives.forEach((f) => {
    const key = f.date;
    if (!festivesByDate.has(key)) {
      festivesByDate.set(key, []);
    }
    festivesByDate.get(key).push(f);

    if (f.users_permissions_user) {
      const userKey = `${f.users_permissions_user.id}_${f.date}`;
      festivesByUserAndDate.set(userKey, f);
    }
  });

  // Pre-create Map for daily dedications lookup
  const dedicationsByUser = new Map();
  dailyDedications.forEach((d) => {
    const userId = d.users_permissions_user ? d.users_permissions_user.id : null;
    if (!userId) return;
    if (!dedicationsByUser.has(userId)) {
      dedicationsByUser.set(userId, []);
    }
    dedicationsByUser.get(userId).push(d);
  });

  // Cache moment objects to avoid recreating them
  const momentCache = new Map();
  const getMoment = (dateStr) => {
    if (!momentCache.has(dateStr)) {
      momentCache.set(dateStr, moment(dateStr, 'YYYY-MM-DD'));
    }
    return momentCache.get(dateStr);
  };

  // Cache formatted dates to avoid repeated formatting
  const formatCache = new Map();
  const getFormattedDate = (momentObj, format) => {
    const key = `${momentObj.format('YYYY-MM-DD')}_${format}`;
    if (!formatCache.has(key)) {
      formatCache.set(key, momentObj.format(format));
    }
    return formatCache.get(key);
  };

  if (phases && phases.length) {
    const projectDefaultYear = getProjectDefaultYear(data);

    for (var i = 0; i < phases.length; i++) {
      const phase = phases[i];
      if (phase.incomes && phase.incomes.length) {
        for (var j = 0; j < phase.incomes.length; j++) {
          const subphase = phase.incomes[j];
          var subphase_estimated_hours = 0;

          subphase.total_amount =
            (subphase.quantity ? subphase.quantity : 0) * (subphase.amount ? subphase.amount : 0);
          total_incomes +=
            (subphase.quantity ? subphase.quantity : 0) * (subphase.amount ? subphase.amount : 0);

          const ey = getEstimateYear(subphase, projectDefaultYear);
          rowsByYear.push({ year: ey, total_incomes: subphase.total_amount });

          if (subphase.estimated_hours) {
            for (var k = 0; k < subphase.estimated_hours.length; k++) {
              const hours = subphase.estimated_hours[k];
              hours.total_amount = 0;
              if (hours.from && hours.to && hours.users_permissions_user && hours.users_permissions_user.id) {
                let mdiff = 1;
                const userId = hours.users_permissions_user.id;
                const userDedications = dedicationsByUser.get(userId) || [];

                if (hours.quantity_type && hours.quantity_type === 'month') {
                  const fromMoment = getMoment(hours.from);
                  const toMoment = getMoment(hours.to);
                  mdiff = Math.round(moment.duration(toMoment.diff(fromMoment)).asDays());

                  for (let i = 0; i < mdiff; i++) {
                    const day = fromMoment.clone().add(i, 'days');
                    const dayStr = getFormattedDate(day, 'YYYY-MM-DD');

                    const userFestiveKey = `${userId}_${dayStr}`;
                    const festive = festivesByUserAndDate.has(userFestiveKey)
                      ? festivesByUserAndDate.get(userFestiveKey)
                      : (festivesByDate.get(dayStr) || []).find((f) => !f.users_permissions_user);

                    if (![0, 6].includes(day.day()) && !festive) {
                      const q = hours.quantity / 5 / 4.3;
                      subphase_estimated_hours += q;
                      total_estimated_hours += q;

                      const dd = userDedications.find((d) => d.from <= dayStr && d.to >= dayStr);
                      const costByHour = dd && dd.costByHour ? dd.costByHour : 0;
                      hours.total_amount += q * costByHour;
                      total_estimated_hours_price += q * costByHour;

                      totalsByDay.push({
                        day,
                        q,
                        costByHour,
                        userId: userId,
                        project: data.id,
                        project_name: data.name,
                      });

                      const yearStr = getFormattedDate(day, 'YYYY');
                      rowsByYear.push({
                        year: yearStr,
                        total_estimated_hours: q,
                      });
                      rowsByYear.push({
                        year: yearStr,
                        total_estimated_hours_price: q * costByHour,
                      });
                    }
                  }
                } else if (hours.quantity_type && hours.quantity_type === 'week') {
                  const fromMoment = getMoment(hours.from);
                  const toMoment = getMoment(hours.to);
                  mdiff = Math.round(moment.duration(toMoment.diff(fromMoment)).asDays());

                  for (let i = 0; i < mdiff; i++) {
                    const day = fromMoment.clone().add(i, 'days');
                    const dayStr = getFormattedDate(day, 'YYYY-MM-DD');

                    const userFestiveKey = `${userId}_${dayStr}`;
                    const festive = festivesByUserAndDate.has(userFestiveKey)
                      ? festivesByUserAndDate.get(userFestiveKey)
                      : (festivesByDate.get(dayStr) || []).find((f) => !f.users_permissions_user);

                    if (![0, 6].includes(day.day()) && !festive) {
                      const q = hours.quantity / 5;
                      subphase_estimated_hours += q;
                      total_estimated_hours += q;

                      const dd = userDedications.find((d) => d.from <= dayStr && d.to >= dayStr);
                      const costByHour = dd && dd.costByHour ? dd.costByHour : 0;
                      hours.total_amount += q * costByHour;
                      total_estimated_hours_price += q * costByHour;

                      totalsByDay.push({
                        day,
                        q,
                        costByHour,
                        userId: userId,
                        project: data.id,
                        project_name: data.name,
                      });

                      const yearStr = getFormattedDate(day, 'YYYY');
                      rowsByYear.push({
                        year: yearStr,
                        total_estimated_hours: q,
                      });
                      rowsByYear.push({
                        year: yearStr,
                        total_estimated_hours_price: q * costByHour,
                      });
                    }
                  }
                } else {
                  subphase_estimated_hours += hours.quantity * mdiff;
                  total_estimated_hours += hours.quantity * mdiff;

                  const dd = userDedications.find((d) => d.from <= hours.from && d.to >= hours.from);
                  const costByHour = dd && dd.costByHour ? dd.costByHour : 0;

                  hours.total_amount = (hours.quantity ? hours.quantity : 0) * mdiff * costByHour;
                  total_estimated_hours_price += (hours.quantity ? hours.quantity : 0) * mdiff * costByHour;

                  const fromMoment = getMoment(hours.from);
                  const toMoment = getMoment(hours.to);
                  mdiff = Math.round(moment.duration(toMoment.diff(fromMoment)).asMonths());

                  for (let i = 0; i < mdiff; i++) {
                    const day = fromMoment.clone().add(i, 'month');

                    totalsByDay.push({
                      day: day,
                      q: hours.quantity / mdiff,
                      costByHour,
                      userId: userId,
                      project: data.id,
                      project_name: data.name,
                    });

                    const yearStr = getFormattedDate(day, 'YYYY');
                    rowsByYear.push({
                      year: yearStr,
                      total_estimated_hours: hours.quantity / mdiff,
                    });
                    rowsByYear.push({
                      year: yearStr,
                      total_estimated_hours_price: (hours.quantity / mdiff) * costByHour,
                    });
                  }
                }
              }
            }
            subphase.total_estimated_hours = subphase_estimated_hours;
          }
          if (subphase.paid) {
            total_real_incomes +=
              (subphase.quantity ? subphase.quantity : 0) * (subphase.amount ? subphase.amount : 0);
            if (real) {
              const realYear = getRealYear(
                subphase.income ? subphase.income : subphase.expense ? subphase.expense : subphase.invoice,
              );

              rowsByYear.push({
                year: realYear,
                total_real_incomes:
                  (subphase.quantity ? subphase.quantity : 0) * (subphase.amount ? subphase.amount : 0),
              });
            }
          }
        }
      }
      if (phase.expenses && phase.expenses.length) {
        for (let j = 0; j < phase.expenses.length; j++) {
          const expense = phase.expenses[j];

          expense.total_amount =
            (expense.quantity ? expense.quantity : 0) * (expense.amount ? expense.amount : 0);
          total_expenses += (expense.quantity ? expense.quantity : 0) * (expense.amount ? expense.amount : 0);

          expense.total_expenses_vat =
            (expense.total_amount *
              (expense.expense_type && expense.expense_type.vat_pct ? expense.expense_type.vat_pct : 21)) /
            100.0;

          total_expenses_vat += expense.total_expenses_vat;

          const ey = getEstimateYear(expense, projectDefaultYear);
          rowsByYear.push({
            year: ey,
            total_expenses: expense.total_amount,
            total_expenses_vat: expense.total_expenses_vat,
          });

          if (expense.paid) {
            total_real_expenses +=
              (expense.quantity ? expense.quantity : 0) * (expense.amount ? expense.amount : 0);

            if (real) {
              const realYear = getRealYear(expense.invoice ? expense.invoice : expense.expense);

              rowsByYear.push({
                year: realYear,
                total_real_expenses:
                  (expense.quantity ? expense.quantity : 0) * (expense.amount ? expense.amount : 0),
                total_real_expenses_vat: expense.invoice
                  ? expense.invoice.total_vat || 0
                  : expense.total_expenses_vat || 0,
              });
              total_real_expenses_vat += expense.invoice
                ? expense.invoice.total_vat || 0
                : expense.total_expenses_vat || 0;
            }
          }
        }
      }
    }
  }

  const totalsByYear = _(rowsByYear)
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
 * Build the deductible-ratio resolver for a project, using the
 * applicable `deductible_vat_pct` for the row's year (or the project
 * default year, or the global fallback).
 */
const makeGetDeductibleRatioForDate =
  (deductibleVatPctByYear, fallback_deductible_vat_pct, projectDefaultYear) => (dateValue) => {
    const extractedYear = (dateValue && String(dateValue).substring(0, 4)) || null;
    const appliedYear = extractedYear || projectDefaultYear;
    const deductible_vat_pct = deductibleVatPctByYear.has(appliedYear)
      ? deductibleVatPctByYear.get(appliedYear)
      : parseFloat(fallback_deductible_vat_pct || 100);
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
        income_esti: sph.quantity * sph.amount,
        income_real: 0,
        year: moment(estimate_date, 'YYYY-MM-DD').format('YYYY'),
        month: moment(estimate_date, 'YYYY-MM-DD').format('MM'),
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
          income_real: sph.quantity * sph.amount,
          year: moment(real_date, 'YYYY-MM-DD').format('YYYY'),
          month: moment(real_date, 'YYYY-MM-DD').format('MM'),
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
      const vat_pct = sph.expense_type && sph.expense_type.vat_pct ? sph.expense_type.vat_pct : 21;
      const estimatedDeductibleRatio = getDeductibleRatio(estimate_date);

      // Estimated expense (all lines, paid or unpaid)
      out.push({
        ...projectInfo,
        ...phaseInfo,
        type: 'expense',
        paid: sph.paid,
        expense_orig: 0,
        expense_orig_vat: 0,
        expense_esti: -1 * sph.quantity * sph.amount,
        expense_esti_vat: (-1 * estimatedDeductibleRatio * sph.quantity * sph.amount * vat_pct) / 100.0,
        expense_real: 0,
        expense_real_vat: 0,
        date: estimate_date,
        year: moment(estimate_date, 'YYYY-MM-DD').format('YYYY'),
        month: moment(estimate_date, 'YYYY-MM-DD').format('MM'),
        row_type: sph.expense_type && sph.expense_type.name ? sph.expense_type.name : '',
        document,
      });

      // Real expense (only if paid)
      if (sph.paid && document && document.emitted) {
        const real_date = document.emitted;
        // Match VAT calculation logic from calculateEstimatedTotals:
        // use invoice.total_vat if available, otherwise the calculated VAT.
        const calculated_vat = (sph.quantity * sph.amount * vat_pct) / 100.0;
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
          expense_real: -1 * sph.quantity * sph.amount,
          expense_real_vat: -1 * expense_vat * realDeductibleRatio,
          date: real_date,
          year: moment(real_date, 'YYYY-MM-DD').format('YYYY'),
          month: moment(real_date, 'YYYY-MM-DD').format('MM'),
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
        income_orig: sph.quantity * sph.amount,
        income_esti: 0,
        income_real: 0,
        year: moment(date, 'YYYY-MM-DD').format('YYYY'),
        month: moment(date, 'YYYY-MM-DD').format('MM'),
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
      const vat_pct = sph.expense_type && sph.expense_type.vat_pct ? sph.expense_type.vat_pct : 21;
      const originalDeductibleRatio = getDeductibleRatio(date);

      out.push({
        ...projectInfo,
        ...phaseInfo,
        type: 'expense',
        expense_orig: -1 * Math.abs(sph.quantity * sph.amount),
        expense_orig_vat:
          (-1 * originalDeductibleRatio * Math.abs(sph.quantity * sph.amount) * vat_pct) / 100.0,
        expense_esti: 0,
        expense_esti_vat: 0,
        expense_real: 0,
        date,
        year: moment(date, 'YYYY-MM-DD').format('YYYY'),
        month: moment(date, 'YYYY-MM-DD').format('MM'),
        row_type: sph.expense_type && sph.expense_type.name ? sph.expense_type.name : '',
        document,
      });
    }
  }
};

const pushPeriodificationRows = (out, p, projectInfo) => {
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
      date: `${pp.year}-12-31`,
      year: pp.year.toString(),
      month: '12',
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
      date: `${pp.year}-12-31`,
      year: pp.year.toString(),
      month: '12',
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

const pushHoursRows = async (out, p, projectInfo, ctx) => {
  // Hores originals come from project_original_phases (locked baseline).
  const { totalsByDay: originalTotalsByDay } = await calculateEstimatedTotals(
    { id: projectInfo.id, name: projectInfo.project_name },
    p.project_original_phases,
    ctx.dailyDedications,
    ctx.festives,
  );

  // Hores previstes come from the current plan (project_phases) — same
  // source as the form's `total_estimated_hours`.
  const { totalsByDay: estimatedTotalsByDay } = await calculateEstimatedTotals(
    { id: projectInfo.id, name: projectInfo.project_name },
    p.project_phases,
    ctx.dailyDedications,
    ctx.festives,
    true,
  );

  const groupedOriginalHours = JSON.parse(JSON.stringify(groupTotalsByYearMonth(originalTotalsByDay)));
  const groupedEstimatedHours = JSON.parse(JSON.stringify(groupTotalsByYearMonth(estimatedTotalsByDay)));

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
  pushPeriodificationRows(rows, p, projectInfo);

  const projectActivities = ctx.activitiesByProject.get(projectInfo.id) || [];
  pushRealActivityRows(rows, projectInfo, projectActivities);

  await pushHoursRows(rows, p, projectInfo, ctx);

  return rows;
};

/**
 * Group activities of a single project by year+month, summing hours and
 * cost. Mirrors the per-project pre-processing the pivot endpoint does
 * across all projects — exposed here so `doProjectInfoCalculations` can
 * build the `activitiesByProject` Map for one project without
 * duplicating logic.
 */
const buildSingleProjectActivitiesMap = (projectId, activities) => {
  const grouped = _(
    (activities || []).map((a) => ({
      ...a,
      ym: `${moment(a.date, 'YYYY-MM-DD').year()}.${moment(a.date, 'YYYY-MM-DD').month()}`,
    })),
  )
    .groupBy('ym')
    .map((rows, id) => ({
      projectId,
      year: parseInt(id.split('.')[0]),
      month: parseInt(id.split('.')[1]) + 1,
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

  // Drop empty "9999" buckets (rows with no resolvable date).
  return grouped.filter((y) => {
    if (y.year !== '9999') return true;
    return (
      y.total_incomes !== 0 ||
      y.total_expenses !== 0 ||
      y.total_expenses_vat !== 0 ||
      y.total_real_incomes !== 0 ||
      y.total_real_expenses !== 0 ||
      y.total_real_expenses_vat !== 0 ||
      y.total_estimated_hours !== 0 ||
      y.total_estimated_hours_price !== 0 ||
      y.total_real_hours !== 0 ||
      y.total_real_hours_price !== 0 ||
      y.total_real_incomes_expenses !== 0 ||
      y.incomes_expenses !== 0
    );
  });
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

  // v5: no strapi.controllers; call the project service's calculateProject.
  const calculated = await strapi.service('api::project.project').calculateProject(data, numericId);
  return { id: numericId, picked: pickStoredTotals(calculated), calculated };
};

// Recomputes and persists ONLY the stored total_* columns for a single
// project. Bypasses Strapi lifecycles by going through raw knex so we don't
// trigger beforeUpdate/afterUpdate (which would defeat the point of this
// targeted refresh).
const refreshStoredTotals = async (id) => {
  const result = await computeStoredTotalsForProject(id);
  if (!result) return null;

  // v5: knex via strapi.db.connection (lifecycle bypass — intentional for stored-totals refresh).
  await strapi.db
    .connection('projects')
    .where({ id: result.id })
    .update({ ...result.picked, dirty: false });

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

  const findArgs = { _limit: -1, _sort: 'id:asc' };
  if (onlyPublished) findArgs.published_at_null = false;
  if (limit && limit > 0) {
    delete findArgs._limit;
    findArgs._limit = limit;
  }

  const projects = await strapi.db
    .query('api::project.project')
    .findMany({ where: findArgs, limit: limit || -1 });
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
const buildEstimatedForecastByYear = (
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

module.exports = {
  buildProjectRows,
  aggregateRowsByYear,
  buildEstimatedForecastByYear,
  buildSingleProjectActivitiesMap,
  calculateEstimatedTotals,
  getProjectDefaultYear,
  getEstimateYear,
  getRealYear,
  // Exposed for tests / future reuse:
  noPhaseInfo,
  makeGetDeductibleRatioForDate,
  groupTotalsByYearMonth,
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
