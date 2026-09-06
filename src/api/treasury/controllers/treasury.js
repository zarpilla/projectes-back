'use strict';
/* global strapi */

const moment = require('moment');
const _ = require('lodash');
const { buildEstimatedForecastByYear } = require('../../project/services/projectFinancials');
const zeroPad = (num, places) => String(num).padStart(places, '0');

/**
 * treasury controller (v5). Ported from v3 api/treasury/controllers/treasury.js (1,212 LOC).
 * The forecast endpoint is ~90% pure JS computation; only the data-fetching layer
 * (11 strapi.query calls) was converted to strapi.db.query. All computation preserved verbatim.
 */
const { createCoreController } = require('@strapi/strapi').factories;
const { adaptCtxQuery } = require('../../../services/query-adapter');
const { getMe } = require('../../../services/me-settings');
const { FILTER_RELATIONS, filterProjects, parseIdList } = require('../services/project-filter');

const getDeductiblePct = (years, emitted) => {
  const year = years.find(
    (y) => y.year.toString() === moment(emitted, 'YYYY-MM-DD').format('YYYY').toString(),
  );
  return year ? year.deductible_vat_pct / 100.0 : 1.0;
};

const getBankAccountName = (bankAccount, defaultBankAccount) => {
  if (bankAccount && bankAccount.name) {
    return bankAccount.name;
  }
  if (defaultBankAccount && defaultBankAccount.name) {
    return defaultBankAccount.name;
  }
  return null;
};

// Helper to generate validation key
const getValidationKey = (entityType, entityId, subType = null) => {
  if (subType) {
    return `${entityType}:${entityId}:${subType}`;
  }
  return `${entityType}:${entityId}`;
};

// Compute the effect of a single treasury row on the running balance.
const applyRowToBalance = (row, currentAccountBalance) => {
  if (row.is_real_balance_adjustment) {
    const desiredBalance = row.desired_balance;
    const adjustment = desiredBalance - currentAccountBalance;
    row.total_amount = adjustment;
    return { accountBalance: desiredBalance, delta: adjustment };
  }
  if (row.is_balance_annotation && row.account_balance !== undefined) {
    const adjustment = row.account_balance - currentAccountBalance;
    return { accountBalance: row.account_balance, delta: adjustment };
  }
  return { accountBalance: currentAccountBalance + row.total_amount, delta: row.total_amount };
};

module.exports = createCoreController('api::treasury.treasury', ({ strapi }) => ({
  // v3 query-param compatibility (P9): translate _limit/_start/_sort/_q/_where
  // and flat field operators to native v5 params before core handling.
  // v5-native queries pass through untouched.
  async find(ctx) {
    adaptCtxQuery(ctx);
    return super.find(ctx);
  },

  async forecast(ctx) {
    const year = ctx.query.year;
    const bankAccountFilterIds = ctx.query.bank_account_id;
    const periodification = ctx.query.periodification; // "no", "real", or "prevista"

    const treasury = [];
    // const treasuryData = [];
    const projectExpenses = [];
    const projectIncomes = [];

    // Fetch all validations
    const validations = await strapi.db
      .query('api::treasury-validation.treasury-validation')
      .findMany({});

    // Create a map for quick lookup: validationKey -> true
    const validationMap = {};
    validations.forEach((v) => {
      const key = getValidationKey(v.entity_type, v.entity_id, v.sub_type);
      validationMap[key] = true;
    });

    const treasuries = await strapi.db
      .query('api::treasury.treasury')
      .findMany({ populate: { bank_account: true, project: true } });

    const emitted = await strapi.db.query('api::emitted-invoice.emitted-invoice').findMany({
      populate: { bank_account: true, project: true, projects: true, contact: true },
    });

    const received = await strapi.db.query('api::received-invoice.received-invoice').findMany({
      populate: { bank_account: true, project: true, projects: true, contact: true },
    });

    const receivedIncomes = await strapi.db.query('api::received-income.received-income').findMany({
      populate: { bank_account: true, project: true, projects: true, contact: true, document_type: true },
    });

    const receivedExpenses = await strapi.db.query('api::received-expense.received-expense').findMany({
      populate: { bank_account: true, project: true, projects: true, contact: true, document_type: true },
    });

    const payrolls = await strapi.db.query('api::payroll.payroll').findMany({
      populate: { bank_account: true, year: true, month: true, users_permissions_user: true },
    });

    // Fetch ALL projects (we'll filter in JavaScript)
    const allProjectsRaw = await strapi.db.query('api::project.project').findMany({
      populate: {
        project_phases: {
          populate: {
            expenses: {
              populate: {
                provider: true,
                expense_type: true,
                invoice: true,
                grant: true,
                ticket: true,
                diet: true,
                expense: true,
                bank_account: true,
              },
            },
            incomes: {
              populate: { client: true, income_type: true, invoice: true, income: true, bank_account: true },
            },
          },
        },
        periodification: true,
        // v3 exposed these as FK columns on the row; v5 omits an unpopulated
        // relation entirely, so the state/type/likelihood filters below would
        // see `undefined` for every project and match nothing.
        ...Object.fromEntries(FILTER_RELATIONS.map((r) => [r, true])),
      },
    });

    // Filter out mother projects (is_mother === true) for unpaid items processing
    // This ensures we only process real projects, not container/mother projects
    const allProjects = allProjectsRaw.filter((p) => p.is_mother !== true);

    // Filter projects by state, type and likelihood — see services/project-filter.js
    // for the parameter grammar and the v3/v5 relation-shape difference.
    let selectedStates = parseIdList(ctx.query.project_states);
    // Legacy filter shortcuts (only honored when project_states is not sent)
    if (selectedStates === null && ctx.query.filter) {
      if (ctx.query.filter === 'approved') {
        selectedStates = [1, 2];
      } else if (ctx.query.filter === 'requested') {
        selectedStates = [3];
      }
    }

    const projects = filterProjects(allProjects, {
      states: selectedStates,
      types: parseIdList(ctx.query.project_types),
      likelihoods: parseIdList(ctx.query.project_likelihoods),
    });

    // Set of project ids that pass the filter, used to also scope the realized
    // rows (emitted/received invoices & incomes/expenses, treasury operations).
    // A realized document is kept only if at least one of its linked projects
    // (single `.project` or many `.projects`) is in this set. Documents with no
    // project link are kept (they are not project-scoped data).
    const allowedProjectIds = new Set(projects.map((p) => p.id));
    const projectInFilter = (doc) => {
      const ids = [];
      if (doc.project && doc.project.id) ids.push(doc.project.id);
      if (Array.isArray(doc.projects)) {
        for (const pr of doc.projects) {
          if (pr && pr.id) ids.push(pr.id);
        }
      }
      if (ids.length === 0) return true; // not project-scoped -> keep
      return ids.some((id) => allowedProjectIds.has(id));
    };

    const years = await strapi.db.query('api::year.year').findMany({});

    const bankAccounts = await strapi.db.query('api::bank-account.bank-account').findMany({});

    const me = await getMe();

    // Economic forecast ("prevista") per year, derived from the project PLAN
    // (project_phases + prevista periodification) — exactly the way
    // ProjectForm's RESUM FINANCER computes it. Reuses the shared
    // projectFinancials engine so this can't drift from the form.
    const fallback_deductible_vat_pct =
      me.options && me.options.deductible_vat_pct ? me.options.deductible_vat_pct : 100.0;
    const deductibleVatPctByYear = new Map(
      (years || [])
        .filter((y) => y && y.year)
        .map((y) => [String(y.year), parseFloat(y.deductible_vat_pct || 100)]),
    );
    const forecast_by_year = buildEstimatedForecastByYear(
      projects,
      deductibleVatPctByYear,
      fallback_deductible_vat_pct,
      periodification,
    );

    // Full payroll cost per year (net + IRPF + SS + other), paid or not.
    // Accumulated in the payrolls loop below.
    const forecast_payrolls_by_year = {};

    // vat
    const vat = {
      paid: 0,
      received: 0,
      deductible_vat_pct: 0,
      deductible_vat_pct_sum: 0,
      deductible_vat_pct_n: 0,
      deductible_vat: 0,
      documents: [],
    };
    const vat_expected = { paid: 0, received: 0, documents: [] };
    const vat_expected_by_quarter = {};

    // Process filtered projects to find unpaid incomes and expenses
    for (let p of projects) {
      for (let ph of p.project_phases || []) {
        for (let e of ph.expenses || []) {
          if (!e.paid) {
            // Calculate total with VAT if vat_pct is available
            let totalWithVat = e.total_amount ? e.total_amount : 0;
            if (e.vat_pct && e.total_amount) {
              const vatAmount = (e.total_amount * e.vat_pct) / 100;
              totalWithVat = e.total_amount + vatAmount;
            }

            const expense = {
              expenseId: e.id,
              project_name: p.name,
              project_id: p.id,
              type: 'Despesa esperada',
              concept: e.concept,
              total_amount: -1 * totalWithVat,
              date: moment(e.date, 'YYYY-MM-DD') || moment(),
              date_error: e.date === null,
              paid: false,
              contact: e.provider && e.provider.name ? e.provider.name : '-',
              bank_account: getBankAccountName(e.bank_account, me.bank_account_default),
            };
            treasury.push(expense);

            const date_est = e.date_estimate_document || e.date;
            if (date_est && e.expense_type && e.expense_type.vat_pct) {
              const vatAmount = (e.total_amount * e.expense_type.vat_pct) / 100;
              vat_expected.paid += vatAmount;

              // Add document to the list
              vat_expected.documents.push({
                id: e.id,
                project_id: p.id,
                project_name: p.name,
                concept: e.concept || '-',
                type: 'phase-expense',
                total: e.total_amount,
                total_vat: vatAmount,
                vat_pct: e.expense_type.vat_pct,
                date: date_est,
                expense_type: e.expense_type.name,
                provider: e.provider && e.provider.name ? e.provider.name : '-',
              });

              // Group by quarter
              const dateEstMoment = moment(date_est, 'YYYY-MM-DD');
              const quarter = dateEstMoment.quarter();
              const year = dateEstMoment.year();
              const key = `${year}-Q${quarter}`;

              if (!vat_expected_by_quarter[key]) {
                vat_expected_by_quarter[key] = {
                  year,
                  quarter,
                  paid: 0,
                  received: 0,
                };
              }

              vat_expected_by_quarter[key].paid += vatAmount;
            }
          }
          if (e.invoice && e.invoice.id) {
            projectExpenses.push({
              type: 'invoice',
              id: e.invoice.id,
              code: e.invoice.code,
              concept: e.concept,
            });
          }
          if (e.grant && e.grant.id) {
            projectExpenses.push({
              type: 'grant',
              id: e.grant.id,
              code: e.grant.code,
              concept: e.concept,
            });
          }
          if (e.ticket && e.ticket.id) {
            projectExpenses.push({
              type: 'ticket',
              id: e.ticket.id,
              code: e.ticket.code,
              concept: e.concept,
            });
          }
          if (e.diet && e.diet.id) {
            projectExpenses.push({
              type: 'diet',
              id: e.diet.id,
              code: e.diet.code,
              concept: e.concept,
            });
          }
          if (e.expense && e.expense.id) {
            projectExpenses.push({
              type: 'expense',
              id: e.expense.id,
              code: e.expense.code,
              concept: e.concept,
            });
          }
        }
        for (let i of ph.incomes || []) {
          if (!i.paid) {
            // Calculate total with VAT if vat_pct is available
            let totalWithVat = i.total_amount ? i.total_amount : 0;
            if (i.vat_pct && i.total_amount) {
              const vatAmount = (i.total_amount * i.vat_pct) / 100;
              totalWithVat = i.total_amount + vatAmount;
            }

            const income = {
              incomeId: i.id,
              project_name: p.name,
              project_id: p.id,
              type: 'Ingrés esperat',
              concept: i.concept,
              total_amount: totalWithVat,
              date: moment(i.date, 'YYYY-MM-DD') || moment(),
              date_error: i.date === null,
              paid: false,
              contact: i.client && i.client.name ? i.client.name : '-',
              bank_account: getBankAccountName(i.bank_account, me.bank_account_default),
            };
            treasury.push(income);

            const date_est = i.date_estimate_document || i.date;

            if (date_est && i.income_type && i.income_type.vat_pct) {
              const vatAmount = (i.total_amount * i.income_type.vat_pct) / 100;
              vat_expected.received += vatAmount;

              // Add document to the list
              vat_expected.documents.push({
                id: i.id,
                project_id: p.id,
                project_name: p.name,
                concept: i.concept || '-',
                type: 'phase-income',
                total: i.total_amount,
                total_vat: vatAmount,
                vat_pct: i.income_type.vat_pct,
                date: date_est,
                income_type: i.income_type.name,
                client: i.client && i.client.name ? i.client.name : '-',
              });

              // Group by quarter
              const dateEstMoment = moment(date_est, 'YYYY-MM-DD');
              const quarter = dateEstMoment.quarter();
              const year = dateEstMoment.year();
              const key = `${year}-Q${quarter}`;

              if (!vat_expected_by_quarter[key]) {
                vat_expected_by_quarter[key] = {
                  year,
                  quarter,
                  paid: 0,
                  received: 0,
                };
              }

              vat_expected_by_quarter[key].received += vatAmount;
            }
          }
          if (i.invoice && i.invoice.id) {
            projectIncomes.push({
              type: 'invoice',
              id: i.invoice.id,
              code: i.invoice.code,
              concept: i.concept,
            });
          }
          if (i.grant && i.grant.id) {
            projectIncomes.push({
              type: 'grant',
              id: i.grant.id,
              code: i.grant.code,
              concept: i.concept,
            });
          }
          if (i.income && i.income.id) {
            projectIncomes.push({
              type: 'income',
              id: i.income.id,
              code: i.income.code,
              concept: i.concept,
            });
          }
        }
      }
    }

    treasuries.forEach((e) => {
      if (!projectInFilter(e)) return;
      let expense;
      const validationKey = getValidationKey('treasuries', e.id);

      // New: Handle is_real_balance entries (user sets exact balance for a specific date)
      if (e.is_real_balance) {
        expense = {
          project_name: e.project?.name,
          project_id: e.project?.id,
          treasury_id: e.id,
          type: 'Saldo real ajustat',
          concept: e.comment || 'Ajust per saldo real',
          total_amount: 0, // Will be calculated during subtotal processing
          desired_balance: e.total, // The exact balance that should exist at this date
          date: moment(e.date, 'YYYY-MM-DD') || moment(),
          date_error: e.date === null,
          paid: true,
          contact: '-',
          bank_account: getBankAccountName(e.bank_account, me.bank_account_default),
          is_real_balance_adjustment: true,
          validation_key: validationKey,
          is_validated: validationMap[validationKey] || false,
        };
      }
      // Special case: treasury with total=0 but balance>0 indicates real money in account for that day
      else if (e.total === 0 && e.balance && parseFloat(e.balance) > 0) {
        expense = {
          project_name: e.project?.name,
          project_id: e.project?.id,
          treasury_id: e.id,
          type: 'Saldo bancari',
          concept: e.comment || 'Saldo real del compte',
          total_amount: 0,
          account_balance: parseFloat(e.balance),
          date: moment(e.date, 'YYYY-MM-DD') || moment(),
          date_error: e.date === null,
          paid: true,
          contact: '-',
          bank_account: getBankAccountName(e.bank_account, me.bank_account_default),
          is_balance_annotation: true,
          validation_key: validationKey,
          is_validated: validationMap[validationKey] || false,
        };
      } else {
        expense = {
          project_name: e.project?.name,
          project_id: e.project?.id,
          treasury_id: e.id,
          type: e.comment === 'IVA Saldat' ? e.comment : 'Operació de tresoreria',
          concept: e.comment,
          total_amount: e.total,
          date: moment(e.date, 'YYYY-MM-DD') || moment(),
          date_error: e.date === null,
          paid: true,
          contact: '-',
          bank_account: getBankAccountName(e.bank_account, me.bank_account_default),
          validation_key: validationKey,
          is_validated: validationMap[validationKey] || false,
        };
      }

      treasury.push(expense);
    });

    // Create "Today" entries for each bank account
    bankAccounts.forEach((bankAccount) => {
      const today = {
        project_name: '-',
        project_id: 0,
        type: 'Avui',
        concept: `-`,
        total_amount: 0,
        date: moment(),
        date_error: false,
        paid: null,
        contact: '-',
        bank_account: bankAccount.name,
      };
      treasury.push(today);
    });

    // Create "Start of Year" entries for each bank account
    bankAccounts.forEach((bankAccount) => {
      const startOfYear = {
        project_name: '-',
        project_id: 0,
        type: 'Inici Any',
        concept: `-`,
        total_amount: 0,
        date: moment(year, 'YYYY').startOf('year'),
        date_error: false,
        paid: null,
        contact: '-',
        bank_account: bankAccount.name,
      };
      treasury.push(startOfYear);
    });

    // emitted
    for (let i of emitted) {
      if (!projectInFilter(i)) continue;
      const date = i.paid_date
        ? moment(i.paid_date, 'YYYY-MM-DD')
        : i.estimated_payment
          ? moment(i.estimated_payment, 'YYYY-MM-DD')
          : i.paybefore
            ? moment(i.paybefore, 'YYYY-MM-DD')
            : moment(i.emitted, 'YYYY-MM-DD');

      // Find the original project income concept by looking up this invoice in projectIncomes
      const projectIncome = projectIncomes.find((pi) => pi.type === 'invoice' && pi.id === i.id);
      const conceptProject = projectIncome ? projectIncome.concept : '';

      const validationKey = getValidationKey('emitted-invoices', i.id);
      const income = {
        project_name:
          i.project && i.project.name
            ? i.project.name
            : i.projects && i.projects.length && i.projects[0] && i.projects[0].name
              ? i.projects[0].name
              : '',
        project_id: i.project
          ? i.project.id
          : i.projects && i.projects.length && i.projects[0] && i.projects[0].id
            ? i.projects[0].id
            : 0,
        type: i.paid ? 'Factura cobrada' : 'Factura emesa',
        concept: i.code,
        total_amount: i.total ? i.total : 0,
        date: date,
        date_error: (i.paid_date || i.estimated_payment || i.paybefore || i.emitted) === null,
        real: true,
        pdf: i.pdf,
        paid: i.paid,
        contact: i.contact && i.contact.name ? i.contact.name : '?',
        to: `/document/${i.id}/emitted-invoices`,
        bank_account: getBankAccountName(i.bank_account, me.bank_account_default),
        conceptProject,
        // Signed VAT (positive for income documents) so the forecast totals can
        // strip the VAT portion from the gross total_amount on the client.
        signed_vat: i.total_vat ? i.total_vat : 0,
        validation_key: validationKey,
        is_validated: validationMap[validationKey] || false,
      };

      treasury.push(income);
      if (i.total_vat) {
        if (!i.vat_paid_date) {
          vat.received += i.total_vat;
          vat.deductible_vat += -1 * i.total_vat;
          const theoreticalPct = getDeductiblePct(years, i.emitted) * 100;
          vat.documents.push({
            id: i.id,
            code: i.code,
            type: 'emitted-invoices',
            total_vat: i.total_vat,
            total: i.total,
            date: i.emitted,
            deductible_vat_pct: i.deductible_vat_pct || null,
            theoretical_deductible_vat_pct: theoreticalPct,
          });
        }
      }
    }
    for (let i of receivedIncomes) {
      if (!projectInFilter(i)) continue;
      const date = i.paid_date
        ? moment(i.paid_date, 'YYYY-MM-DD')
        : i.estimated_payment
          ? moment(i.estimated_payment, 'YYYY-MM-DD')
          : i.paybefore
            ? moment(i.paybefore, 'YYYY-MM-DD')
            : moment(i.emitted, 'YYYY-MM-DD');

      // Find the original project income concept by looking up this income in projectIncomes
      const projectIncome = projectIncomes.find((pi) => pi.type === 'income' && pi.id === i.id);
      const conceptProject = projectIncome ? projectIncome.concept : '';

      const validationKey = getValidationKey('received-incomes', i.id);
      const income = {
        project_name:
          i.project && i.project.name
            ? i.project.name
            : i.projects && i.projects.length && i.projects[0] && i.projects[0].name
              ? i.projects[0].name
              : '',
        project_id: i.project
          ? i.project.id
          : i.projects && i.projects.length && i.projects[0] && i.projects[0].id
            ? i.projects[0].id
            : 0,
        type: `${i.paid ? 'Ingrés cobrat' : 'Ingrés emès'} (${i.document_type.name})`,
        concept: i.code,
        total_amount: i.total ? i.total : 0,
        date: date,
        date_error: (i.paid_date || i.estimated_payment || i.paybefore || i.emitted) === null,
        real: true,
        pdf: i.pdf,
        paid: i.paid,
        contact: i.contact && i.contact.name ? i.contact.name : '?',
        to: `/document/${i.id}/received-incomes`,
        bank_account: getBankAccountName(i.bank_account, me.bank_account_default),
        conceptProject,
        // Signed VAT (positive for income documents) so the forecast totals can
        // strip the VAT portion from the gross total_amount on the client.
        signed_vat: i.total_vat ? i.total_vat : 0,
        validation_key: validationKey,
        is_validated: validationMap[validationKey] || false,
      };
      treasury.push(income);
      if (i.total_vat) {
        if (!i.vat_paid_date) {
          vat.received += i.total_vat;
          vat.deductible_vat += -1 * i.total_vat;
          const theoreticalPct = getDeductiblePct(years, i.emitted) * 100;
          vat.documents.push({
            id: i.id,
            code: i.code,
            type: 'received-incomes',
            total_vat: i.total_vat,
            total: i.total,
            date: i.emitted,
            deductible_vat_pct: i.deductible_vat_pct || null,
            theoretical_deductible_vat_pct: theoreticalPct,
          });
        }
      }
    }
    // received
    for (let e of received) {
      if (!projectInFilter(e)) continue;
      const date = e.paid_date
        ? moment(e.paid_date, 'YYYY-MM-DD')
        : e.paybefore
          ? moment(e.paybefore, 'YYYY-MM-DD')
          : moment(e.emitted, 'YYYY-MM-DD');

      // Find the original project expense concept by looking up this invoice in projectExpenses
      const projectExpense = projectExpenses.find((pe) => pe.type === 'invoice' && pe.id === e.id);
      const conceptProject = projectExpense ? projectExpense.concept : '';

      const validationKey = getValidationKey('received-invoices', e.id);
      const expense = {
        project_name:
          e.project && e.project.name
            ? e.project.name
            : e.projects && e.projects.length && e.projects[0] && e.projects[0].name
              ? e.projects[0].name
              : '',
        project_id: e.project
          ? e.project.id
          : e.projects && e.projects.length && e.projects[0] && e.projects[0].id
            ? e.projects[0].id
            : 0,
        type: e.paid ? 'Factura pagada' : 'Factura rebuda',
        concept: e.code,
        total_amount: e.total ? -1 * e.total : 0,
        date: date,
        date_error: false,
        paid: e.paid,
        real: true,
        pdf: e.pdf,
        contact: e.contact && e.contact.name ? e.contact.name : '-',
        to: `/document/${e.id}/received-invoices`,
        bank_account: getBankAccountName(e.bank_account, me.bank_account_default),
        conceptProject,
        // Signed VAT (negative for expense documents) so the forecast totals can
        // strip the VAT portion from the gross total_amount on the client.
        signed_vat: e.total_vat ? -1 * e.total_vat : 0,
        validation_key: validationKey,
        is_validated: validationMap[validationKey] || false,
      };
      treasury.push(expense);
      if (e.total_irpf) {
        const irpfValidationKey = getValidationKey('received-invoices', e.id, 'irpf');
        const expense2 = {
          project_name:
            e.project && e.project.name
              ? e.project.name
              : e.projects && e.projects.length && e.projects[0] && e.projects[0].name
                ? e.projects[0].name
                : '',
          project_id: e.project
            ? e.project.id
            : e.projects && e.projects.length && e.projects[0] && e.projects[0].id
              ? e.projects[0].id
              : 0,
          type: 'IRPF Factura',
          concept: e.code,
          total_amount: -1 * e.total_irpf,
          date: moment(e.emitted, 'YYYY-MM-DD').endOf('quarter').add(20, 'day'),
          date_error: e.emitted === null,
          paid:
            moment(e.emitted, 'YYYY-MM-DD').endOf('quarter').add(20, 'day').format('YYYY-MM-DD') <
            moment().format('YYYY-MM-DD'),
          contact: e.contact && e.contact.name ? e.contact.name : '-',
          to: `/document/${e.id}/received-invoices`,
          bank_account: me.bank_account_irpf && me.bank_account_irpf.name ? me.bank_account_irpf.name : null,
          validation_key: irpfValidationKey,
          is_validated: validationMap[irpfValidationKey] || false,
        };
        treasury.push(expense2);
      }
      if (e.total_vat) {
        if (!e.vat_paid_date) {
          vat.paid += e.total_vat;
          vat.deductible_vat += getDeductiblePct(years, e.emitted) * e.total_vat;
          vat.deductible_vat_pct_sum += getDeductiblePct(years, e.emitted);
          vat.deductible_vat_pct_n++;
          const theoreticalPct = getDeductiblePct(years, e.emitted) * 100;
          vat.documents.push({
            id: e.id,
            code: e.code,
            type: 'received-invoices',
            total_vat: e.total_vat,
            total: e.total,
            date: e.emitted,
            deductible_vat_pct: e.deductible_vat_pct || null,
            theoretical_deductible_vat_pct: theoreticalPct,
          });
        }
      }
    }
    for (let e of receivedExpenses) {
      if (!projectInFilter(e)) continue;
      const date = e.paid_date
        ? moment(e.paid_date, 'YYYY-MM-DD')
        : e.paybefore
          ? moment(e.paybefore, 'YYYY-MM-DD')
          : moment(e.emitted, 'YYYY-MM-DD');

      // Find the original project expense concept by looking up this expense in projectExpenses
      const projectExpense = projectExpenses.find((pe) => pe.type === 'expense' && pe.id === e.id);
      const conceptProject = projectExpense ? projectExpense.concept : '';

      const validationKey = getValidationKey('received-expenses', e.id);
      const expense = {
        project_name:
          e.project && e.project.name
            ? e.project.name
            : e.projects && e.projects.length && e.projects[0] && e.projects[0].name
              ? e.projects[0].name
              : '',
        project_id: e.project
          ? e.project.id
          : e.projects && e.projects.length && e.projects[0] && e.projects[0].id
            ? e.projects[0].id
            : 0,
        type: `${e.paid ? 'Despesa pagada' : 'Despesa rebuda'} (${e.document_type.name})`,
        concept: e.code,
        total_amount: e.total ? -1 * e.total : 0,
        date: date,
        date_error: false,
        paid: e.paid,
        real: true,
        pdf: e.pdf,
        contact: e.contact && e.contact.name ? e.contact.name : '-',
        to: `/document/${e.id}/received-expenses`,
        bank_account: getBankAccountName(e.bank_account, me.bank_account_default),
        conceptProject,
        // Signed VAT (negative for expense documents) so the forecast totals can
        // strip the VAT portion from the gross total_amount on the client.
        signed_vat: e.total_vat ? -1 * e.total_vat : 0,
        validation_key: validationKey,
        is_validated: validationMap[validationKey] || false,
      };
      treasury.push(expense);
      if (e.total_irpf) {
        const irpfValidationKey = getValidationKey('received-expenses', e.id, 'irpf');
        const expense2 = {
          project_name:
            e.project && e.project.name
              ? e.project.name
              : e.projects && e.projects.length && e.projects[0] && e.projects[0].name
                ? e.projects[0].name
                : '',
          project_id: e.project
            ? e.project.id
            : e.projects && e.projects.length && e.projects[0] && e.projects[0].id
              ? e.projects[0].id
              : 0,
          type: 'IRPF Factura',
          concept: e.code,
          total_amount: -1 * e.total_irpf,
          date: moment(e.emitted, 'YYYY-MM-DD').endOf('quarter').add(20, 'day'),
          date_error: e.emitted === null,
          paid: false,
          contact: e.contact && e.contact.name ? e.contact.name : '-',
          to: `/document/${e.id}/received-expenses`,
          bank_account: me.bank_account_irpf && me.bank_account_irpf.name ? me.bank_account_irpf.name : null,
          validation_key: irpfValidationKey,
          is_validated: validationMap[irpfValidationKey] || false,
        };
        treasury.push(expense2);
      }
      if (e.total_vat) {
        // treasury.push(vat);
        if (!e.vat_paid_date) {
          vat.received += e.total_vat;
          vat.deductible_vat += getDeductiblePct(years, e.emitted) * e.total_vat;
          vat.deductible_vat_pct_sum += getDeductiblePct(years, e.emitted);
          vat.deductible_vat_pct_n++;
          const theoreticalPct = getDeductiblePct(years, e.emitted) * 100;
          vat.documents.push({
            id: e.id,
            code: e.id,
            type: 'received-expenses',
            total_vat: e.total_vat,
            total: e.total,
            date: e.emitted,
            deductible_vat_pct: e.deductible_vat_pct || null,
            theoretical_deductible_vat_pct: theoreticalPct,
          });
        }
      }
    }

    // NOTE: periodification no longer feeds the treasury (cashflow) rows in
    // this forecast endpoint. It is applied only to the economic forecast
    // ("prevista") totals via buildEstimatedForecastByYear above, gated by the
    // `periodification` ("no"/"prevista"/"real") parameter. The treasury rows
    // therefore reflect real/expected cash movements only.

    for (let e of payrolls) {
      const date = e.paid_date
        ? moment(e.paid_date, 'YYYY-MM-DD')
        : moment.max([e.emitted ? moment(e.emitted, 'YYYY-MM-DD') : moment(), moment()]);

      // Accumulate the full payroll cost (net + IRPF + SS + other) into the
      // economic forecast for the payroll's year. Paid or unpaid, both count
      // — these are the "Nómines totals de l'any".
      if (e.year && e.year.year) {
        const payrollYear = String(e.year.year);
        forecast_payrolls_by_year[payrollYear] =
          (forecast_payrolls_by_year[payrollYear] || 0) +
          (e.net_base || 0) +
          (e.irpf_base || 0) +
          (e.ss_base || 0) +
          (e.other_base || 0);
      }

      const validationKey = getValidationKey('payrolls', e.id);
      const expense = {
        project_name: '',
        project_id: 0,
        type: e.paid ? 'Nòmina pagada' : 'Nòmina esperada',
        concept: `Nòmina ${e.year.year}-${zeroPad(e.month.month, 2)}-${e.users_permissions_user.username}`,
        total_amount: e.net_base ? -1 * e.net_base : 0,
        date: moment(e.net_date, 'YYYY-MM-DD'),
        date_error: (e.paid_date || e.emitted) === null,
        paid: e.paid,
        contact:
          e.users_permissions_user && e.users_permissions_user.username
            ? e.users_permissions_user.username
            : '',
        to: `/document/${e.id}/payrolls`,
        bank_account: getBankAccountName(e.bank_account, me.bank_account_default),
        validation_key: validationKey,
        is_validated: validationMap[validationKey] || false,
      };
      treasury.push(expense);

      if (e.irpf_base) {
        const irpfValidationKey = getValidationKey('payrolls', e.id, 'irpf');
        const expense2 = {
          project_name: '',
          project_id: 0,
          type: 'IRPF Nòmina',
          concept: `Nòmina ${e.year.year}-${zeroPad(e.month.month, 2)}-${e.users_permissions_user.username}`,
          total_amount: e.irpf_base ? -1 * e.irpf_base : 0,
          date: moment(e.irpf_date, 'YYYY-MM-DD'),
          date_error: e.irpf_date === null,
          paid: e.paid,
          contact:
            e.users_permissions_user && e.users_permissions_user.username
              ? e.users_permissions_user.username
              : '',
          to: `/document/${e.id}/payrolls`,
          bank_account: me.bank_account_irpf && me.bank_account_irpf.name ? me.bank_account_irpf.name : null,
          validation_key: irpfValidationKey,
          is_validated: validationMap[irpfValidationKey] || false,
        };
        treasury.push(expense2);
      }

      if (e.other_base) {
        const otherValidationKey = getValidationKey('payrolls', e.id, 'other');
        const expense4 = {
          project_name: '',
          project_id: 0,
          type: 'Altres Nòmina',
          concept: `Nòmina ${e.year.year}-${zeroPad(e.month.month, 2)}-${e.users_permissions_user.username}`,
          total_amount: e.other_base ? -1 * e.other_base : 0,
          date: moment(e.other_date, 'YYYY-MM-DD'),
          date_error: e.other_date === null,
          paid: e.paid,
          contact:
            e.users_permissions_user && e.users_permissions_user.username
              ? e.users_permissions_user.username
              : '',
          to: `/document/${e.id}/payrolls`,
          bank_account:
            me.bank_account_payroll && me.bank_account_payroll.name ? me.bank_account_payroll.name : null,
          validation_key: otherValidationKey,
          is_validated: validationMap[otherValidationKey] || false,
        };
        treasury.push(expense4);
      }

      if (e.ss_base) {
        const ssValidationKey = getValidationKey('payrolls', e.id, 'ss');
        const expense3 = {
          project_name: '',
          project_id: 0,
          type: e.paid ? 'SS pagat' : 'SS esperat',
          concept: `Nòmina ${e.year.year}-${zeroPad(e.month.month, 2)}-${e.users_permissions_user.username}`,
          total_amount: e.ss_base ? -1 * e.ss_base : 0,
          date: moment(e.ss_date, 'YYYY-MM-DD'),
          date_error: e.ss_date === null,
          paid: e.paid,
          contact:
            e.users_permissions_user && e.users_permissions_user.username
              ? e.users_permissions_user.username
              : '',
          to: `/document/${e.id}/payrolls`,
          bank_account: me.bank_account_ss && me.bank_account_ss.name ? me.bank_account_ss.name : null,
          validation_key: ssValidationKey,
          is_validated: validationMap[ssValidationKey] || false,
        };
        treasury.push(expense3);
      }
    }

    // Group VAT documents by quarter for executed VAT
    const vatByQuarter = {};

    for (let doc of vat.documents) {
      const docDate = moment(doc.date, 'YYYY-MM-DD');
      const quarter = docDate.quarter();
      const year = docDate.year();
      const key = `${year}-Q${quarter}`;

      if (!vatByQuarter[key]) {
        vatByQuarter[key] = {
          year,
          quarter,
          paid: 0,
          received: 0,
          deductible_vat: 0,
          deductible_vat_pct_sum: 0,
          deductible_vat_pct_n: 0,
          documents: [],
        };
      }

      if (doc.type === 'received-invoices' || doc.type === 'received-expenses') {
        const deductiblePct = getDeductiblePct(years, doc.date);
        vatByQuarter[key].paid += doc.total_vat;
        vatByQuarter[key].deductible_vat += deductiblePct * doc.total_vat;
        vatByQuarter[key].deductible_vat_pct_sum += deductiblePct;
        vatByQuarter[key].deductible_vat_pct_n++;
      } else if (doc.type === 'emitted-invoices' || doc.type === 'received-incomes') {
        vatByQuarter[key].received += doc.total_vat;
        vatByQuarter[key].deductible_vat += -1 * doc.total_vat;
      }

      vatByQuarter[key].documents.push(doc);
    }

    // Add executed VAT entries to treasury with cumulative balance
    // Sort quarters chronologically
    const sortedVatQuarters = Object.keys(vatByQuarter)
      .map((key) => ({ key, ...vatByQuarter[key] }))
      .sort((a, b) => {
        if (a.year !== b.year) return a.year - b.year;
        return a.quarter - b.quarter;
      });

    let cumulativeVatBalance = 0;

    for (let qData of sortedVatQuarters) {
      const quarterBalance = qData.deductible_vat;
      cumulativeVatBalance += quarterBalance;

      // Only create treasury entry if cumulative balance is negative (payment required)
      if (cumulativeVatBalance < 0) {
        // Calculate the payment date: 30th of the month after quarter end
        // Exception: Q4 (Oct-Dec) is paid on January 20th instead of 30th
        let paymentDate = moment(`${qData.year}`, 'YYYY')
          .quarter(qData.quarter)
          .endOf('quarter')
          .add(1, 'month');

        if (qData.quarter === 4) {
          // Q4: January 20th
          paymentDate.date(20);
        } else {
          // Q1, Q2, Q3: 30th of the month
          paymentDate.date(30);
        }

        // Determine if it's paid (before today) or expected (today or future)
        const isPaid = paymentDate.isBefore(moment(), 'day');

        treasury.push({
          project_name: '',
          project_id: 0,
          type: 'IVA executat pendent de saldar',
          concept: `IVA executat ${qData.year} T${qData.quarter} (acumulat)`,
          total_amount: cumulativeVatBalance,
          date: paymentDate,
          date_error: false,
          paid: isPaid,
          contact: '',
          to: null,
          bank_account: me.bank_account_vat && me.bank_account_vat.name ? me.bank_account_vat.name : null,
        });

        // Reset cumulative balance after payment
        cumulativeVatBalance = 0;
      }
      // If positive, balance carries forward to next quarter (no entry created)
    }

    // Add expected VAT entries to treasury with cumulative balance
    // Sort quarters chronologically
    const sortedExpectedVatQuarters = Object.keys(vat_expected_by_quarter)
      .map((key) => ({ key, ...vat_expected_by_quarter[key] }))
      .sort((a, b) => {
        if (a.year !== b.year) return a.year - b.year;
        return a.quarter - b.quarter;
      });

    let cumulativeExpectedVatBalance = 0;

    for (let qData of sortedExpectedVatQuarters) {
      // `me.options` is an optional component — the same value is already
      // resolved with a 100% fallback above; use it rather than dereferencing.
      const quarterBalance =
        qData.received - (qData.paid * fallback_deductible_vat_pct) / 100;
      cumulativeExpectedVatBalance += quarterBalance;

      // Only create treasury entry if cumulative balance is positive (payment required)
      if (cumulativeExpectedVatBalance > 0) {
        // Calculate the payment date: 30th of the month after quarter end
        // Exception: Q4 (Oct-Dec) is paid on January 20th instead of 30th
        let paymentDate = moment(`${qData.year}`, 'YYYY')
          .quarter(qData.quarter)
          .endOf('quarter')
          .add(1, 'month');

        if (qData.quarter === 4) {
          // Q4: January 20th
          paymentDate.date(20);
        } else {
          // Q1, Q2, Q3: 30th of the month
          paymentDate.date(30);
        }

        treasury.push({
          project_name: '',
          project_id: 0,
          type: 'IVA previst pendent de saldar',
          concept: `IVA previst ${qData.year} T${qData.quarter} (acumulat)`,
          total_amount: -1 * cumulativeExpectedVatBalance,
          date: paymentDate,
          date_error: false,
          paid: false,
          contact: '',
          to: null,
          bank_account: me.bank_account_vat && me.bank_account_vat.name ? me.bank_account_vat.name : null,
        });

        // Reset cumulative balance after payment
        cumulativeExpectedVatBalance = 0;
      }
      // If positive, balance carries forward to next quarter (no entry created)
    }

    // sort and show
    const treasury2 = treasury.map((t) => {
      return { ...t, datef: t.date.format('YYYYMMDD') };
    });

    const treasuryData = _.sortBy(treasury2, 'datef');
    const treasuryDataX = [];

    // Track balance per bank account
    const balanceByAccount = {};
    let subtotal = 0;

    for (let i = 0; i < treasuryData.length; i++) {
      const t = treasuryData[i];
      const account = t.bank_account || 'default';

      // Initialize account balance if needed
      if (balanceByAccount[account] === undefined) {
        balanceByAccount[account] = 0;
      }

      const { accountBalance, delta } = applyRowToBalance(t, balanceByAccount[account]);
      balanceByAccount[account] = accountBalance;
      subtotal += delta;

      treasuryDataX.push({
        ...t,
        datex: moment(treasuryData[i].datef, 'YYYYMMDD').format('DD-MM-YYYY'),
        subtotal,
        account_subtotal: accountBalance, // per-account balance
      });
    }

    vat.deductible_vat_pct = (vat.deductible_vat_pct_sum / vat.deductible_vat_pct_n) * 100;
    vat.deductible_vat_pct = parseFloat(vat.deductible_vat_pct.toFixed(2));

    vat.documents = vat.documents.sort((a, b) => {
      if (a.date < b.date) return -1;
      if (a.date > b.date) return 1;
      return 0;
    });

    // Apply bank account filter if specified
    let filteredTreasuryDataX = treasuryDataX;
    if (bankAccountFilterIds && bankAccountFilterIds.trim() !== '') {
      // Parse bank account IDs (can be comma-separated for multiple selection)
      const bankAccountIdArray = bankAccountFilterIds
        .split(',')
        .map((id) => id.trim())
        .filter((id) => id !== '');

      if (bankAccountIdArray.length > 0) {
        // Find the bank account names by IDs for filtering
        const selectedBankAccountNames = bankAccounts
          .filter((ba) => bankAccountIdArray.includes(ba.id.toString()))
          .map((ba) => ba.name);

        if (selectedBankAccountNames.length > 0) {
          // Filter entries: include if bank_account matches OR if bank_account is null/undefined
          filteredTreasuryDataX = treasuryDataX.filter(
            (t) =>
              selectedBankAccountNames.includes(t.bank_account) || !t.bank_account || t.bank_account === null,
          );

          // Recalculate subtotals for the filtered account-specific data,
          // reusing the same per-row logic as the global walk so that
          // is_real_balance_adjustment and is_balance_annotation rows snap the
          // running balance correctly, and account_subtotal stays in sync.
          let accountSubtotal = 0;
          filteredTreasuryDataX = filteredTreasuryDataX.map((t) => {
            const { accountBalance, delta } = applyRowToBalance(t, accountSubtotal);
            accountSubtotal = accountBalance;
            return {
              ...t,
              subtotal: accountSubtotal,
              account_subtotal: accountSubtotal,
            };
          });
        }
      }
    }

    return {
      treasury: filteredTreasuryDataX,
      projects,
      vat,
      vat_expected,
      vat_expected_by_quarter,
      vat_by_quarter: vatByQuarter,
      forecast_by_year,
      forecast_payrolls_by_year,
    };
  },
}));
