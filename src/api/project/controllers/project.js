'use strict';
/* global strapi */
const { createCoreController } = require('@strapi/strapi').factories;
const _ = require('lodash');
const moment = require('moment');
const {
  adaptQuery,
  adaptCtxQuery,
  expandPopulate,
  toDbArgs,
  v3FindArgs,
} = require('../../../services/query-adapter');
const { numericId } = require('../../../middlewares/v3-compat');
const { getDailyDedications, getFestives } = require('../services/projectCache');
const { getMe } = require('../../../services/me-settings');
const {
  buildProjectRows,
  aggregateRowsByYear,
  buildSingleProjectActivitiesMap,
  calculateEstimatedTotals,
  getProjectDefaultYear,
} = require('../services/projectFinancials');

/**
 * Read the documentation (https://strapi.io/documentation/v3.x/concepts/controllers.html#core-controllers)
 * to customize this controller
 */

/** Removes the client-side `dirty` markers from a nested phase payload. */
const stripDirty = (value, depth = 0) => {
  if (depth > 6 || value === null || typeof value !== 'object') return value;
  if (Array.isArray(value)) {
    value.forEach((entry) => stripDirty(entry, depth + 1));
    return value;
  }
  delete value.dirty;
  Object.values(value).forEach((entry) => stripDirty(entry, depth + 1));
  return value;
};

const doProjectInfoCalculations = async (data, id) => {
  if (!id || !data) {
    return;
  }

  const dailyDedications = await getDailyDedications();
  const festives = await getFestives();

  const me = await getMe();
  const fallback_deductible_vat_pct =
    me.options && me.options.deductible_vat_pct ? me.options.deductible_vat_pct : 100.0;
  const yearEntities = await strapi.db.query('api::year.year').findMany({});
  const deductibleVatPctByYear = new Map(
    (yearEntities || [])
      .filter((y) => y && y.year)
      .map((y) => [String(y.year), parseFloat(y.deductible_vat_pct || 100)]),
  );

  if (!data.activities) {
    data.activities = await strapi.db
      .query('api::activity.activity')
      .findMany({ where: { project: id } });
  }

  // Build the same shared engine context the pivot uses, scoped to a
  // single project. This is the cornerstone of the refactor: the form's
  // RESUM FINANCER and the pivot endpoint now derive their numbers from
  // the exact same row stream, so they cannot drift apart again.
  const activitiesByProject = buildSingleProjectActivitiesMap(data.id, data.activities);
  const financialsCtx = {
    dailyDedications,
    festives,
    deductibleVatPctByYear,
    fallback_deductible_vat_pct,
    activitiesByProject,
  };

  const rows = await buildProjectRows(data, financialsCtx);

  data.allByYear = aggregateRowsByYear(rows);

  // Sum project-level totals from the year buckets so the totals always
  // match what the user sees per year.
  data.total_original_incomes = _.sumBy(data.allByYear, 'total_original_incomes') || 0;
  data.total_original_expenses = _.sumBy(data.allByYear, 'total_original_expenses') || 0;
  data.total_original_hours = _.sumBy(data.allByYear, 'total_original_hours') || 0;
  data.total_original_hours_price = _.sumBy(data.allByYear, 'total_original_hours_price') || 0;
  data.total_original_expenses_vat = _.sumBy(data.allByYear, 'total_original_expenses_vat') || 0;

  data.total_estimated_incomes = _.sumBy(data.allByYear, 'total_estimated_incomes') || 0;
  data.total_estimated_expenses = _.sumBy(data.allByYear, 'total_estimated_expenses') || 0;
  data.total_estimated_hours = _.sumBy(data.allByYear, 'total_estimated_hours') || 0;
  data.total_estimated_hours_price = _.sumBy(data.allByYear, 'total_estimated_hours_price') || 0;
  data.total_estimated_expenses_vat = _.sumBy(data.allByYear, 'total_estimated_expenses_vat') || 0;

  data.total_real_incomes = _.sumBy(data.allByYear, 'total_real_incomes') || 0;
  data.total_real_expenses = _.sumBy(data.allByYear, 'total_real_expenses') || 0;
  data.total_real_hours = _.sumBy(data.allByYear, 'total_real_hours') || 0;
  data.total_real_hours_price = _.sumBy(data.allByYear, 'total_real_hours_price') || 0;
  data.total_real_expenses_vat = _.sumBy(data.allByYear, 'total_real_expenses_vat') || 0;

  // Three-dimensional balances
  data.original_incomes_expenses =
    data.total_original_incomes -
    data.total_original_expenses -
    data.total_original_hours_price -
    data.total_original_expenses_vat;

  data.estimated_incomes_expenses =
    data.total_estimated_incomes -
    data.total_estimated_expenses -
    data.total_estimated_hours_price -
    data.total_estimated_expenses_vat;

  data.total_real_incomes_expenses =
    data.total_real_incomes -
    data.total_real_expenses -
    data.total_real_hours_price -
    data.total_real_expenses_vat;

  // Backwards compatibility (estimated dimension is the default)
  data.total_incomes = data.total_estimated_incomes;
  data.total_expenses = data.total_estimated_expenses;
  data.total_expenses_vat = data.total_estimated_expenses_vat;
  data.total_expenses_hours = data.total_estimated_hours;

  // Handle structural expenses if applicable
  if (data.structural_expenses === true) {
    const indirects = await strapi.db.query('api::project.project').findMany({
      where: { structural_expenses_pct: { $gt: 0 }, trashed: false },
    });

    const indirectIncomesOriginal = _.sumBy(
      indirects.map((i) => ({
        indirect: (i.structural_expenses_pct / 100) * (i.total_original_incomes || i.total_incomes || 0),
      })),
      'indirect',
    );

    const indirectIncomesEstimated = _.sumBy(
      indirects.map((i) => ({
        indirect: (i.structural_expenses_pct / 100) * (i.total_estimated_incomes || i.total_incomes || 0),
      })),
      'indirect',
    );

    const indirectIncomesReal = _.sumBy(
      indirects.map((i) => ({
        indirect: (i.structural_expenses_pct / 100) * (i.total_real_incomes || 0),
      })),
      'indirect',
    );

    data.total_original_incomes += indirectIncomesOriginal;
    data.original_incomes_expenses += indirectIncomesOriginal;

    data.total_estimated_incomes += indirectIncomesEstimated;
    data.estimated_incomes_expenses += indirectIncomesEstimated;

    data.total_real_incomes += indirectIncomesReal;
    data.total_real_incomes_expenses += indirectIncomesReal;

    // Update backwards compatibility fields
    data.total_incomes += indirectIncomesEstimated;
  }

  // Backwards compatibility fields
  data.balance =
    data.total_estimated_incomes - data.total_estimated_expenses - data.total_estimated_hours_price;
  data.estimated_balance =
    data.total_estimated_incomes - data.total_estimated_expenses - data.total_estimated_hours_price;
  data.incomes_expenses =
    data.total_estimated_incomes -
    data.total_estimated_expenses -
    data.total_estimated_hours_price -
    data.total_estimated_expenses_vat;

  if (!data.leader || !data.leader.id) {
    delete data.leader;
  }

  // Calculate is_mother: true if there are any projects with this project as their mother
  const childProjects = await strapi.db.query('api::project.project').count({ where: { mother: id } });
  data.is_mother = childProjects > 0;

  return data;
};

let projectsQueue = [];

// v3 plural entity names used by the phase helpers -> v5 UIDs
// ('project-phases' / 'project-original-phases').
const PHASE_ENTITY_UIDS = {
  'project-phases': 'api::project-phase.project-phase',
  'project-original-phases': 'api::project-original-phase.project-original-phase',
};

module.exports = createCoreController('api::project.project', ({ strapi }) => ({
  /**
   * find override — ports the v3 afterFind hook (removed in v5): aggregates
   * child totals onto mother projects in list responses.
   */
  async find(ctx) {
    adaptCtxQuery(ctx);
    const response = await super.find(ctx);
    const rows = response?.data;
    if (Array.isArray(rows)) {
      for (const entry of rows) {
        const attrs = entry?.attributes || entry;
        if (attrs && attrs.is_mother) {
          await calculateMotherProjectTotals(attrs);
        }
      }
    }
    return response;
  },

  async calculateProject(data, id) {
    return await doProjectInfoCalculations(data, id);
  },
  async calculateProject2(ctx) {
    const id = ctx.params.id;

    const dataPhases = await strapi.db
      .query('api::project.project')
      .findOne({
        where: { id },
        populate: expandPopulate([
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
        // v3 returned components without being asked; v5 omits them as soon as
        // an explicit populate is given, and ProjectForm.getAuxiliarData() reads
        // `form.periodification.length` unguarded — so the whole auxiliary-data
        // setup threw on every load.
        'periodification',
        'grantable_years',
        'grantable_contacts',
        ]),
      });

    const moreData = await doProjectInfoCalculations(dataPhases, id);

    // Return both yearly breakdown and project-level totals
    // This ensures frontend displays exactly what backend calculated
    return {
      allByYear: moreData.allByYear,
      totals: {
        // Original dimension
        total_original_incomes: moreData.total_original_incomes,
        total_original_expenses: moreData.total_original_expenses,
        total_original_hours: moreData.total_original_hours,
        total_original_hours_price: moreData.total_original_hours_price,
        total_original_expenses_vat: moreData.total_original_expenses_vat,
        original_incomes_expenses: moreData.original_incomes_expenses,

        // Estimated dimension
        total_estimated_incomes: moreData.total_estimated_incomes,
        total_estimated_expenses: moreData.total_estimated_expenses,
        total_estimated_hours: moreData.total_estimated_hours,
        total_estimated_hours_price: moreData.total_estimated_hours_price,
        total_estimated_expenses_vat: moreData.total_estimated_expenses_vat,
        estimated_incomes_expenses: moreData.estimated_incomes_expenses,

        // Real dimension
        total_real_incomes: moreData.total_real_incomes,
        total_real_expenses: moreData.total_real_expenses,
        total_real_hours: moreData.total_real_hours,
        total_real_hours_price: moreData.total_real_hours_price,
        total_real_expenses_vat: moreData.total_real_expenses_vat,
        total_real_incomes_expenses: moreData.total_real_incomes_expenses,
      },
    };
  },
  async reset() {
    // await strapi.db.query('api::project.project').delete({ _limit: -1 });
    // await strapi.db.query('api::activity.activity').delete({ _limit: -1 });
    // await strapi.db.query('api::activity-type.activity-type').delete({ _limit: -1 });
    // await strapi.db.query('api::daily-dedication.daily-dedication').delete({ _limit: -1 });
    // await strapi.db.query('api::contact.contact').delete({ _limit: -1 });
    // await strapi.db.query('api::emitted-invoice.emitted-invoice').delete({ _limit: -1 });
    // await strapi.db.query('api::festive.festive').delete({ _limit: -1, users_permissions_user_ne: null});
    // await strapi.db.query('api::kanban-view.kanban-view').delete({ _limit: -1 });
    // await strapi.db.query('api::payroll.payroll').delete({ _limit: -1 });
    // await strapi.db.query('api::quote.quote').delete({ _limit: -1 });
    // await strapi.db.query('api::received-expense.received-expense').delete({ _limit: -1 });
    // await strapi.db.query('api::received-income.received-income').delete({ _limit: -1 });
    // await strapi.db.query('api::received-invoice.received-invoice').delete({ _limit: -1 });
    // await strapi.db.query('api::project-scope.project-scope').delete({ _limit: -1 });
    // await strapi.db.query('api::serie.serie').delete({ _limit: -1 });
    // await strapi.db.query('api::task.task').delete({ _limit: -1 });
    // await strapi.db.query('api::time-counter.time-counter').delete({ _limit: -1 });
    // await strapi.db.query('api::treasury.treasury').delete({ _limit: -1 });
    // //// await strapi.db.query('api::year.year').delete({ _limit: -1 });

    // comment activity beforeDelete
    // delete users-permissions_user manually
    // to fill: year, festive

    return [];
  },
  // async updateDirtyProject(id) {
  //   const project = await strapi.db.query('api::project.project').findOne({ where: { id: id } });

  //   const data = await doProjectInfoCalculations(project, id);

  //   // data._internal = true;
  //   data.dirty = false;

  //   return data;
  // },
  async findWithBasicInfo(ctx) {
    // Calling the default core action
    let projects;

    // only published
    ctx.query.published_at_null = false;
    if (ctx.query._q) {
      projects = await strapi.db
        .query('api::project.project')
        .findMany(
          v3FindArgs(ctx.query, [
          'leader',
          'project_scope',
          'project_likelihood',
          'project_state',
          'project_type',
          'clients',
          'activity_types',
          'global_activity_types',
          // v3 kept relations as FK columns, so `mother` was on every row even
          // unpopulated; v5 omits an unpopulated relation entirely. Views read
          // `p.mother === null` (JornadaDiaria, ModalBoxMoveProject,
          // TreasuryAnnotationInput — all of which threw on undefined) and
          // `p.mother.name` (Home, the pivots), so it has to be a real object.
          'mother',
          ]),
        );
    } else {
      projects = await strapi.db
        .query('api::project.project')
        .findMany(
          v3FindArgs(ctx.query, [
          'leader',
          'project_scope',
          'project_likelihood',
          'project_state',
          'project_type',
          'clients',
          'activity_types',
          'global_activity_types',
          // v3 kept relations as FK columns, so `mother` was on every row even
          // unpopulated; v5 omits an unpopulated relation entirely. Views read
          // `p.mother === null` (JornadaDiaria, ModalBoxMoveProject,
          // TreasuryAnnotationInput — all of which threw on undefined) and
          // `p.mother.name` (Home, the pivots), so it has to be a real object.
          'mother',
          ]),
        );
    }

    // Removing some info
    const newArray = projects
      .map(
        ({
          phases,
          activities,
          emitted_invoices,
          received_invoices,
          tickets,
          diets,
          emitted_grants,
          received_grants,
          quotes,
          original_phases,
          incomes,
          expenses,
          strategies,
          estimated_hours,
          intercooperations,
          received_expenses,
          received_incomes,
          treasury_annotations,
          linked_emitted_invoices,
          linked_received_expenses,
          linked_received_incomes,
          linked_received_invoices,
          ...item
        }) => item,
      )
      .map((p) => {
        return {
          ...p,
          clients: p.clients
            ? p.clients.map((c) => {
                return { id: c.id, name: c.name };
              })
            : null,
        };
      });

    return newArray.map((entity) => entity);
  },

  async findNames(ctx) {
    // Calling the default core action
    let projects;

    // only published
    projects = await strapi.db.query('api::project.project').findMany(
      toDbArgs(adaptQuery({ ...ctx.query, published_at_null: false }, { searchFields: ['name'] }))
    );

    // Removing some info
    const newArray = projects.map((p) => {
      return {
        id: p.id,
        name: p.name,
      };
    });

    return newArray.map((entity) => entity);
  },

  async findWithPhases(ctx) {
    // Calling the default core action
    let projects;
    const { published_at_null, _limit, activities, hoursType, ...where } = ctx.query;

    // project_state_in is optional: when omitted, no state filter is applied
    // and all published projects are returned. Accept either
    // _where[project_state_in]=1,2,3 or project_state_in=1,2,3 (same shape the
    // dedications endpoints use).
    const project_state_in = (where._where && where._where.project_state_in) || where.project_state_in;

    // Determine which phase type to use based on hoursType parameter
    const phaseType = hoursType === 'previstes' ? 'project_phases' : 'project_original_phases';

    // v5: Bookshelf withRelated replaced by nested db.query populate.
    const phasePopulate = {
      populate: {
        incomes: {
          populate: {
            estimated_hours: {
              populate: { users_permissions_user: true },
            },
          },
        },
      },
    };
    const populate = { [phaseType]: phasePopulate };

    if (activities) {
      populate.activities = true;
    }

    if (ctx.query._q) {
      // v3 parity: the _q branch ignored the search term, applied no state
      // filter and only populated the phase collection one level.
      projects = await strapi.db
        .query('api::project.project')
        .findMany({ populate: { [phaseType]: true } });
    } else {
      // Normalize the (optional) state filter into an array of integer ids.
      const stateIds = project_state_in
        ? String(project_state_in)
            .split(',')
            .map((s) => parseInt(s.trim(), 10))
            .filter((n) => !isNaN(n))
        : [];

      projects = await strapi.db.query('api::project.project').findMany({
        select: ['id', 'name', 'trashed'],
        ...(stateIds.length ? { where: { project_state: { $in: stateIds } } } : {}),
        populate,
      });
    }

    return projects.filter((p) => p.trashed !== true);
  },

  // Variant of findWithPhases used by the "Previsió/Execució dedicació" pivot
  // (DedicationEstPivot.vue), which shows "Hores previstes" (planned, from
  // project_phases) and "Hores originals" (from project_original_phases) side
  // by side. Unlike findWithPhases, it eagerly loads BOTH phase collections
  // (with the full incomes -> estimated_hours -> users_permissions_user
  // nesting) so both measures can be computed from a single request.
  //   _where[project_state_in]=1,2,3   (optional, comma-separated)
  //   activities=true                  (optional, also load activities)
  async findWithPhasesBoth(ctx) {
    let projects;
    const { published_at_null, _limit, activities, hoursType, ...where } = ctx.query;

    const project_state_in = (where._where && where._where.project_state_in) || where.project_state_in;

    // v5: Bookshelf withRelated replaced by nested db.query populate (both
    // phase collections with the full incomes -> estimated_hours -> user nest).
    const phasePopulate = {
      populate: {
        incomes: {
          populate: {
            estimated_hours: {
              populate: { users_permissions_user: true },
            },
          },
        },
      },
    };
    const populate = {
      project_phases: phasePopulate,
      project_original_phases: phasePopulate,
    };

    if (activities) {
      populate.activities = true;
    }

    if (ctx.query._q) {
      // v3 parity: the _q branch ignored the search term and only populated
      // the phase collections one level.
      projects = await strapi.db.query('api::project.project').findMany({
        populate: { project_phases: true, project_original_phases: true },
      });
    } else {
      const stateIds = project_state_in
        ? String(project_state_in)
            .split(',')
            .map((s) => parseInt(s.trim(), 10))
            .filter((n) => !isNaN(n))
        : [];

      projects = await strapi.db.query('api::project.project').findMany({
        select: ['id', 'name', 'trashed'],
        ...(stateIds.length ? { where: { project_state: { $in: stateIds } } } : {}),
        populate,
      });
    }

    return projects.filter((p) => p.trashed !== true);
  },

  // precomputed cells) plus the per-day dedications rows used by the Excel
  // export. Moves the expensive per-day expansion + re-aggregation previously
  // done client-side (DedicationGantt.vue / DedicationGanttChart.vue) to the
  // server. Query params mirror /projects/phases:
  //   _where[project_state_in]=1,2,3   (required, comma-separated)
  //   hoursType=previstes|original      (default previstes)
  //   year=2026                         (default current year)
  //   view=month|week                   (default month)
  async findDedications(ctx) {
    const { buildDedicationGantt } = require('../services/dedicationGantt');

    const hoursType = ctx.query.hoursType || 'previstes';
    const view = ctx.query.view === 'week' ? 'week' : 'month';
    const year = ctx.query.year ? parseInt(ctx.query.year, 10) : null;

    let projectStateIds = [];
    const raw = (ctx.query._where && ctx.query._where.project_state_in) || ctx.query.project_state_in;
    if (raw) {
      projectStateIds = String(raw)
        .split(',')
        .map((s) => parseInt(s.trim(), 10))
        .filter((n) => !isNaN(n));
    }

    if (!projectStateIds.length) {
      return ctx.badRequest('project_state_in is required');
    }

    return await buildDedicationGantt({
      projectStateIds,
      hoursType,
      year,
      view,
    });
  },

  // Real (done) counterpart of findDedications: aggregates logged `activity`
  // hours instead of estimated hours. Same { leaders, periods, cells,
  // dedications } contract so the client reuses DedicationGanttChart.vue.
  //   _where[project_state_in]=1,2,3   (required, comma-separated)
  //   year=2026                         (default current year)
  //   view=month|week                   (default month)
  async findRealDedications(ctx) {
    const { buildRealDedicationGantt } = require('../services/realDedicationGantt');

    const view = ctx.query.view === 'week' ? 'week' : 'month';
    const year = ctx.query.year ? parseInt(ctx.query.year, 10) : null;

    let projectStateIds = [];
    const raw = (ctx.query._where && ctx.query._where.project_state_in) || ctx.query.project_state_in;
    if (raw) {
      projectStateIds = String(raw)
        .split(',')
        .map((s) => parseInt(s.trim(), 10))
        .filter((n) => !isNaN(n));
    }

    if (!projectStateIds.length) {
      return ctx.badRequest('project_state_in is required');
    }

    return await buildRealDedicationGantt({
      projectStateIds,
      year,
      view,
    });
  },

  async findWithEconomicDetail(ctx) {
    // Calling the default core action

    // only published
    // ctx.query.published_at_null = false;

    const start = +new Date();

    const { query, paid, document } = ctx.query;
    // ctx.query = { _limit: -1 }

    const promises = [];

    //console.log('query', query, year)
    const year = ctx.query && ctx.query._where && ctx.query._where.year_eq ? ctx.query._where.year_eq : null;

    // `_where` on this endpoint carries its own control params — `year_eq`
    // selects the reporting year and `project_state_in`/`_eq` the state filter.
    // Neither is a column on `projects`, so the whole ctx.query must never be
    // handed to adaptQuery: `year` reached the projects table as a field filter
    // and answered "Unknown column 't0.year' in 'where clause'". Build the
    // project query explicitly instead, on both branches.
    const projectQuery = { _limit: -1, published_at_null: false };

    // Handle project_state filtering
    if (ctx.query && ctx.query._where) {
      if (ctx.query._where.project_state_eq) {
        projectQuery.project_state = ctx.query._where.project_state_eq;
      } else if (ctx.query._where.project_state_in) {
        // Convert comma-separated string to array of integers for Strapi _in filter
        const stateIds =
          typeof ctx.query._where.project_state_in === 'string'
            ? ctx.query._where.project_state_in.split(',').map((s) => parseInt(s))
            : ctx.query._where.project_state_in;
        projectQuery.project_state_in = stateIds;
      }
    }

    if (ctx.query._q) {
      promises.push(
        strapi.db
          .query('api::project.project')
          .findMany(
            toDbArgs(
              adaptQuery({ ...projectQuery, _q: ctx.query._q }, { searchFields: ['name'] })
            )
          )
      );
    } else {

      // TODO check why this filter removes some projects that have activities in the given year
      // if (year) {
      //   projectQuery.activities = { date: { gte: `${year}-01-01`, lte: `${year}-12-31` } };
      // }

      promises.push(
        strapi.db
          .query('api::project.project')
          .findMany(toDbArgs(adaptQuery(projectQuery), {
            project_state: true,
            activities: true,
            project_scope: true,
            project_likelihood: true,
            project_type: true,
            leader: true,
            project_phases: {
              populate: {
                incomes: {
                  populate: {
                    estimated_hours: { populate: { users_permissions_user: true } },
                    income_type: true,
                    invoice: true,
                    income: true,
                  },
                },
                expenses: {
                  populate: { expense_type: true, invoice: true, expense: true },
                },
              },
            },
            project_original_phases: {
              populate: {
                incomes: {
                  populate: {
                    estimated_hours: { populate: { users_permissions_user: true } },
                    income_type: true,
                    invoice: true,
                    income: true,
                  },
                },
                expenses: {
                  populate: { expense_type: true, invoice: true, expense: true },
                },
              },
            },
          })),
      );
    }

    promises.push(strapi.db.query('api::daily-dedication.daily-dedication').findMany({}));

    promises.push(strapi.db.query('api::festive.festive').findMany({}));

    const results = await Promise.all(promises);

    let projects = results[0];
    //const activities = results[1];
    const dailyDedications = results[1];
    const festives = results[2];

    //projects = projects.filter((p) => p.published_at !== null);

    // Filter out mother projects to avoid double-counting (children are already included)
    projects = projects.filter((p) => !p.is_mother);

    // console.log('projects', projects[0].activities ? projects[0].activities[0] : 0)
    const activities = _.flatten(
      projects.map((p) => {
        return p.activities ? p.activities : [];
      }),
    );

    // projects.forEach((p) => {
    //   p.activities.forEach((a) => {
    //     if (!year || (a.date && a.date.substring(0, 4) === year.toString())) {
    //       activities.push(a);
    //     }
    //   });
    // });

    let response;

    const activitiesPYM = activities
      .filter((a) => a.date && a.project)
      .map((a) => {
        return {
          ...a,
          pym: `${a.project}.${moment(a.date, 'YYYY-MM-DD').year()}.${moment(a.date, 'YYYY-MM-DD').month()}`,
        };
      });
    const groupedActivities = _(activitiesPYM)
      .groupBy('pym')
      .map((rows, id) => {
        return {
          projectId: parseInt(id.split('.')[0]),
          year: parseInt(id.split('.')[1]),
          month: parseInt(id.split('.')[2]) + 1,
          cost: _.sumBy(rows, (r) => r.hours * r.cost_by_hour),
          hours: _.sumBy(rows, 'hours'),
        };
      });

    const groupedActivitiesObj = JSON.parse(JSON.stringify(groupedActivities));

    // Create a Map for faster activity lookup by projectId
    const activitiesByProject = new Map();
    groupedActivitiesObj.forEach((activity) => {
      if (!activitiesByProject.has(activity.projectId)) {
        activitiesByProject.set(activity.projectId, []);
      }
      activitiesByProject.get(activity.projectId).push(activity);
    });

    const me = await getMe();
    const fallback_deductible_vat_pct =
      me.options && me.options.deductible_vat_pct ? me.options.deductible_vat_pct : 100.0;
    const yearEntities = await strapi.db.query('api::year.year').findMany({});
    const deductibleVatPctByYear = new Map(
      (yearEntities || [])
        .filter((y) => y && y.year)
        .map((y) => [String(y.year), parseFloat(y.deductible_vat_pct || 100)]),
    );

    // Shared context handed to the projectFinancials engine for every project.
    const financialsCtx = {
      dailyDedications,
      festives,
      deductibleVatPctByYear,
      fallback_deductible_vat_pct,
      activitiesByProject,
    };

    // Delegate all per-project row construction to the shared engine so
    // the pivot view cannot drift from the form's RESUM FINANCER.
    const projectResponses = await Promise.all(projects.map((p) => buildProjectRows(p, financialsCtx)));

    // Flatten all project responses into a single array
    response = _.flatten(projectResponses);

    if (year) {
      response = response.filter((r) => r.year === year);
    }

    if (ctx.query && ctx.query._where && ctx.query._where.year_eq) {
      response = response.filter((r) => r.year.toString() === ctx.query._where.year_eq.toString());
    }

    if (paid != null) {
      response = response.filter((r) => r.paid === (paid === 'true'));
    }

    const returnData = _.sortBy(response, ['year', 'month', 'name']);

    // Removing some info
    // const newArray = projects.map(({ phases, activities, emitted_invoices, received_invoices, tickets, diets, emitted_grants, received_grants, quotes, original_phases, incomes, expenses, strategies, estimated_hours, intercooperations, clients, received_expenses, received_incomes, ...item }) => item)
    return returnData;
  },

  // Read-only diagnostic: compares the persisted total_* columns on `project`
  // against what projectFinancials would compute right now. Used to validate
  // the upcoming switch to refreshStoredTotals before wiring lifecycle hooks.
  //
  // Query params:
  //   ?ids=1,2,3        comma-separated project ids (max 200)
  //   ?limit=50         when ids is omitted, sample this many published projects
  //   ?onlyDiffs=true   trim the report to projects with a difference
  //   ?epsilon=0.01     tolerance per field (default 0.01)
  async verifyStoredTotals(ctx) {
    const { verifyStoredTotals } = require('../services/projectFinancials');

    const epsilon = ctx.query.epsilon ? parseFloat(ctx.query.epsilon) : 0.01;
    const onlyDiffs = ctx.query.onlyDiffs === 'true';

    let ids;
    if (ctx.query.ids) {
      ids = String(ctx.query.ids)
        .split(',')
        .map((s) => parseInt(s.trim(), 10))
        .filter((n) => n > 0)
        .slice(0, 200);
    } else {
      const limit = Math.min(parseInt(ctx.query.limit, 10) || 20, 200);
      const sample = await strapi.db.query('api::project.project').findMany({
        where: { trashed: false },
        orderBy: { id: 'desc' },
        limit,
      });
      ids = sample.map((p) => p.id);
    }

    const result = await verifyStoredTotals(ids, epsilon);
    if (onlyDiffs) {
      result.report = result.report.filter((r) => r.error || !r.ok);
    }
    return result;
  },

  // Targeted refresh of the persisted total_* columns on `project`.
  // Bypasses lifecycles (uses raw knex). Modes:
  //   ?id=240               refresh a single project
  //   ?ids=1,2,3            refresh a list (max 500)
  //   ?all=true             refresh every published project (sequential)
  //   ?all=true&limit=N     ditto, capped at N (handy for staged rollouts)
  //   add &dryRun=true      run verifyStoredTotals instead of writing
  async refreshStoredTotals(ctx) {
    const {
      refreshStoredTotals,
      refreshAllStoredTotals,
      verifyStoredTotals,
    } = require('../services/projectFinancials');

    const dryRun = ctx.query.dryRun === 'true';

    // Single id
    if (ctx.query.id) {
      const id = parseInt(ctx.query.id, 10);
      if (!(id > 0)) return ctx.badRequest('invalid id');
      if (dryRun) {
        return await verifyStoredTotals([id]);
      }
      const picked = await refreshStoredTotals(id);
      if (!picked) return ctx.notFound('project not found');
      return { id, written: picked };
    }

    // Explicit id list
    if (ctx.query.ids) {
      const ids = String(ctx.query.ids)
        .split(',')
        .map((s) => parseInt(s.trim(), 10))
        .filter((n) => n > 0)
        .slice(0, 500);
      if (!ids.length) return ctx.badRequest('no valid ids');
      if (dryRun) {
        return await verifyStoredTotals(ids);
      }
      let processed = 0;
      const failed = [];
      for (const id of ids) {
        try {
          await refreshStoredTotals(id);
          processed++;
        } catch (e) {
          failed.push({ id, error: e && e.message });
        }
      }
      return { total: ids.length, processed, failed };
    }

    // Bulk: every project
    if (ctx.query.all === 'true') {
      const limit = ctx.query.limit ? parseInt(ctx.query.limit, 10) : undefined;
      if (dryRun) {
        // For dry-run on `all`, just delegate to verifier with a sensible cap.
        const cap = Math.min(limit || 100, 500);
        const projects = await strapi.db.query('api::project.project').findMany({
          where: { trashed: false },
          orderBy: { id: 'desc' },
          limit: cap,
        });
        return await verifyStoredTotals(projects.map((p) => p.id));
      }
      return await refreshAllStoredTotals({ limit });
    }

    return ctx.badRequest('provide ?id=, ?ids= or ?all=true');
  },

  async findEstimatedTotalsByDay(ctx) {
    ctx.query.published_at_null = false;
    const { year, ...query } = ctx.query;

    const promises = [];
    if (query._q) {
      promises.push(
        strapi.db
          .query('api::project.project')
          .findMany(
            v3FindArgs(query, [
            'project_original_phases',
            'project_original_phases.incomes',
            'project_original_phases.incomes.estimated_hours',
            'project_original_phases.incomes.estimated_hours.users_permissions_user',
            ]),
          ),
      );
    } else {
      promises.push(
        strapi.db
          .query('api::project.project')
          .findMany(
            v3FindArgs(query, [
            'project_original_phases',
            'project_original_phases.incomes',
            'project_original_phases.incomes.estimated_hours',
            'project_original_phases.incomes.estimated_hours.users_permissions_user',
            ]),
          ),
      );
    }

    promises.push(strapi.db.query('api::daily-dedication.daily-dedication').findMany({}));
    promises.push(strapi.db.query('api::festive.festive').findMany({}));

    const results = await Promise.all(promises);

    let projects = results[0];
    const dailyDedications = results[1];
    const festives = results[2];

    const totals = [];
    for await (const p of projects) {
      const { totalsByDay } = await calculateEstimatedTotals(
        { id: p.id, name: p.name },
        p.project_original_phases,
        dailyDedications,
        festives,
      );
      totals.push(...totalsByDay.map((t) => ({ ...t, day: t.day.format('YYYY-MM-DD') })));
    }
    // for await (const event of eventsAdded) {
    if (year) {
      return totals.filter((r) => r.day.substring(0, 4) === year);
    }
    return totals;
  },

  async findChildren(ctx) {
    const { id, expense } = ctx.params;
    const project = await strapi.db.query('api::project.project').findOne({ where: { id } });

    // Check if this project is a mother (has children that reference it)
    if (project && project.is_mother) {
      const phasePopulate = {
        populate: {
          incomes: {
            populate: {
              income_type: true,
              invoice: true,
              grant: true,
              income: true,
              bank_account: true,
              estimated_hours: { populate: { users_permissions_user: true } },
            },
          },
          expenses: {
            populate: {
              expense_type: true,
              invoice: true,
              ticket: true,
              diet: true,
              expense: true,
              bank_account: true,
            },
          },
        },
      };
      const childrenAll = await strapi.db.query('api::project.project').findMany({
        where: { mother: id },
        populate: {
          project_phases: phasePopulate,
          project_original_phases: phasePopulate,
        },
      });
      const children = childrenAll.filter((c) => c.id != id);

      const flattenMap = (arrays, prop) => _.flatten(arrays.map((a) => a[prop]));

      // Store the children's values BEFORE calling doProjectInfoCalculations
      // because that function might modify the child objects
      // Store all three dimensions: original, estimated, real
      const childrenStoredValues = children.map((c) => ({
        id: c.id,
        // Original dimension
        total_original_incomes: parseFloat(c.total_original_incomes || 0),
        total_original_expenses: parseFloat(c.total_original_expenses || 0),
        total_original_expenses_vat: parseFloat(c.total_original_expenses_vat || 0),
        total_original_hours: parseFloat(c.total_original_hours || 0),
        total_original_hours_price: parseFloat(c.total_original_hours_price || 0),
        original_incomes_expenses: parseFloat(c.original_incomes_expenses || 0),
        // Estimated dimension
        total_estimated_incomes: parseFloat(c.total_estimated_incomes || 0),
        total_estimated_expenses: parseFloat(c.total_estimated_expenses || 0),
        total_estimated_expenses_vat: parseFloat(c.total_estimated_expenses_vat || 0),
        total_estimated_hours: parseFloat(c.total_estimated_hours || 0),
        total_estimated_hours_price: parseFloat(c.total_estimated_hours_price || 0),
        estimated_incomes_expenses: parseFloat(c.estimated_incomes_expenses || 0),
        // Real dimension
        total_real_incomes: parseFloat(c.total_real_incomes || 0),
        total_real_expenses: parseFloat(c.total_real_expenses || 0),
        total_real_expenses_vat: parseFloat(c.total_real_expenses_vat || 0),
        total_real_hours: parseFloat(c.total_real_hours || 0),
        total_real_hours_price: parseFloat(c.total_real_hours_price || 0),
        total_real_incomes_expenses: parseFloat(c.total_real_incomes_expenses || 0),
        // Backwards compatibility
        total_incomes: parseFloat(c.total_incomes || 0),
        total_expenses: parseFloat(c.total_expenses || 0),
        total_expenses_vat: parseFloat(c.total_expenses_vat || 0),
        incomes_expenses: parseFloat(c.incomes_expenses || 0),
      }));

      // Aggregate phases from all children
      const aggregatedProjectPhases = flattenMap(children, 'project_phases');
      const aggregatedProjectOriginalPhases = flattenMap(children, 'project_original_phases');

      // Aggregate allByYear data from all children
      const allChildrenByYear = [];
      for (const child of children) {
        const childCalculations = await doProjectInfoCalculations(child, child.id);
        if (childCalculations && childCalculations.allByYear) {
          allChildrenByYear.push(...childCalculations.allByYear);
        }
      }

      // Group by year and sum all three dimensions separately
      const aggregatedAllByYear = _(allChildrenByYear)
        .groupBy('year')
        .map((rows, year) => {
          const original_hours = _.sumBy(rows, (r) => parseFloat(r.total_original_hours || 0));
          const original_hours_price = _.sumBy(rows, (r) => parseFloat(r.total_original_hours_price || 0));

          return {
            year: year,
            // Original dimension
            total_original_incomes: _.sumBy(rows, (r) => parseFloat(r.total_original_incomes || 0)),
            total_original_expenses: _.sumBy(rows, (r) => parseFloat(r.total_original_expenses || 0)),
            total_original_expenses_vat: _.sumBy(rows, (r) => parseFloat(r.total_original_expenses_vat || 0)),
            total_original_hours: original_hours,
            total_original_hours_price: original_hours_price,
            original_incomes_expenses: _.sumBy(rows, (r) => parseFloat(r.original_incomes_expenses || 0)),
            // Estimated dimension
            // EXCEPTION: Estimated hours always copy from original hours
            total_estimated_incomes: _.sumBy(rows, (r) => parseFloat(r.total_estimated_incomes || 0)),
            total_estimated_expenses: _.sumBy(rows, (r) => parseFloat(r.total_estimated_expenses || 0)),
            total_estimated_expenses_vat: _.sumBy(rows, (r) =>
              parseFloat(r.total_estimated_expenses_vat || 0),
            ),
            total_estimated_hours: original_hours,
            total_estimated_hours_price: original_hours_price,
            estimated_incomes_expenses: _.sumBy(rows, (r) => parseFloat(r.estimated_incomes_expenses || 0)),
            // Real dimension
            total_real_incomes: _.sumBy(rows, (r) => parseFloat(r.total_real_incomes || 0)),
            total_real_expenses: _.sumBy(rows, (r) => parseFloat(r.total_real_expenses || 0)),
            total_real_expenses_vat: _.sumBy(rows, (r) => parseFloat(r.total_real_expenses_vat || 0)),
            total_real_hours: _.sumBy(rows, (r) => parseFloat(r.total_real_hours || 0)),
            total_real_hours_price: _.sumBy(rows, (r) => parseFloat(r.total_real_hours_price || 0)),
            total_real_incomes_expenses: _.sumBy(rows, (r) => parseFloat(r.total_real_incomes_expenses || 0)),
            // Backwards compatibility
            total_incomes: _.sumBy(rows, (r) =>
              parseFloat(r.total_estimated_incomes || r.total_incomes || 0),
            ),
            total_expenses: _.sumBy(rows, (r) =>
              parseFloat(r.total_estimated_expenses || r.total_expenses || 0),
            ),
            total_expenses_vat: _.sumBy(rows, (r) =>
              parseFloat(r.total_estimated_expenses_vat || r.total_expenses_vat || 0),
            ),
            incomes_expenses: _.sumBy(rows, (r) =>
              parseFloat(r.estimated_incomes_expenses || r.incomes_expenses || 0),
            ),
          };
        })
        .value();

      // Apply mother project's periodification on top of aggregated data
      const aggregatedAllByYearWithPeriodification = aggregatedAllByYear.map((y) => {
        const periodificationData =
          project.periodification && project.periodification.find((p) => p.year === y.year);

        if (!periodificationData) {
          return y;
        }

        const periodified_real_incomes = periodificationData.real_incomes || 0;
        const periodified_real_expenses = periodificationData.real_expenses || 0;
        const periodified_incomes = periodificationData.incomes || 0;
        const periodified_expenses = periodificationData.expenses || 0;

        // Periodification mapping (must mirror pushPeriodificationRows in
        // projectFinancials.js):
        //   - "previstos" (incomes/expenses) -> estimated dimension ONLY.
        //     The original dimension is a locked baseline and must never be
        //     touched by manual periodification.
        //   - "executats" (real_incomes/real_expenses) -> real dimension ONLY.
        const new_total_original_incomes = y.total_original_incomes;
        const new_total_original_expenses = y.total_original_expenses;

        const new_total_estimated_incomes = y.total_estimated_incomes + periodified_incomes;
        const new_total_estimated_expenses = y.total_estimated_expenses + periodified_expenses;

        const new_total_real_incomes = y.total_real_incomes + periodified_real_incomes;
        const new_total_real_expenses = y.total_real_expenses + periodified_real_expenses;

        return {
          ...y,
          // Original dimension (with periodification)
          total_original_incomes: new_total_original_incomes,
          total_original_expenses: new_total_original_expenses,
          original_incomes_expenses:
            new_total_original_incomes -
            new_total_original_expenses -
            (y.total_original_hours_price || 0) -
            (y.total_original_expenses_vat || 0),
          // Estimated dimension (with periodification)
          total_estimated_incomes: new_total_estimated_incomes,
          total_estimated_expenses: new_total_estimated_expenses,
          estimated_incomes_expenses:
            new_total_estimated_incomes -
            new_total_estimated_expenses -
            (y.total_estimated_hours_price || 0) -
            (y.total_estimated_expenses_vat || 0),
          // Real dimension (with periodification)
          total_real_incomes: new_total_real_incomes,
          total_real_expenses: new_total_real_expenses,
          total_real_incomes_expenses:
            new_total_real_incomes -
            new_total_real_expenses -
            (y.total_real_hours_price || 0) -
            (y.total_real_expenses_vat || 0),
          // Backwards compatibility
          total_incomes: new_total_estimated_incomes,
          total_expenses: new_total_estimated_expenses,
          incomes_expenses:
            new_total_estimated_incomes -
            new_total_estimated_expenses -
            (y.total_estimated_hours_price || 0) -
            (y.total_estimated_expenses_vat || 0),
        };
      });

      // REFACTORED: Calculate mother project totals by summing yearly values
      // This ensures perfect consistency between year-level and project-level numbers
      const totals = {
        // Original dimension
        total_original_incomes: _.sumBy(aggregatedAllByYearWithPeriodification, 'total_original_incomes'),
        total_original_expenses: _.sumBy(aggregatedAllByYearWithPeriodification, 'total_original_expenses'),
        total_original_expenses_vat: _.sumBy(
          aggregatedAllByYearWithPeriodification,
          'total_original_expenses_vat',
        ),
        total_original_hours: _.sumBy(aggregatedAllByYearWithPeriodification, 'total_original_hours'),
        total_original_hours_price: _.sumBy(
          aggregatedAllByYearWithPeriodification,
          'total_original_hours_price',
        ),
        original_incomes_expenses: _.sumBy(
          aggregatedAllByYearWithPeriodification,
          'original_incomes_expenses',
        ),
        // Estimated dimension
        total_estimated_incomes: _.sumBy(aggregatedAllByYearWithPeriodification, 'total_estimated_incomes'),
        total_estimated_expenses: _.sumBy(aggregatedAllByYearWithPeriodification, 'total_estimated_expenses'),
        total_estimated_expenses_vat: _.sumBy(
          aggregatedAllByYearWithPeriodification,
          'total_estimated_expenses_vat',
        ),
        total_estimated_hours: _.sumBy(aggregatedAllByYearWithPeriodification, 'total_estimated_hours'),
        total_estimated_hours_price: _.sumBy(
          aggregatedAllByYearWithPeriodification,
          'total_estimated_hours_price',
        ),
        estimated_incomes_expenses: _.sumBy(
          aggregatedAllByYearWithPeriodification,
          'estimated_incomes_expenses',
        ),
        // Real dimension
        total_real_incomes: _.sumBy(aggregatedAllByYearWithPeriodification, 'total_real_incomes'),
        total_real_expenses: _.sumBy(aggregatedAllByYearWithPeriodification, 'total_real_expenses'),
        total_real_expenses_vat: _.sumBy(aggregatedAllByYearWithPeriodification, 'total_real_expenses_vat'),
        total_real_hours: _.sumBy(aggregatedAllByYearWithPeriodification, 'total_real_hours'),
        total_real_hours_price: _.sumBy(aggregatedAllByYearWithPeriodification, 'total_real_hours_price'),
        total_real_incomes_expenses: _.sumBy(
          aggregatedAllByYearWithPeriodification,
          'total_real_incomes_expenses',
        ),
      };

      // EXCEPTION: Estimated hours should always copy from original hours
      // "Hores previstes" should always be the same as "Hores originals"
      totals.total_estimated_hours = totals.total_original_hours;
      totals.total_estimated_hours_price = totals.total_original_hours_price;

      // Recalculate estimated balance with corrected hours
      totals.estimated_incomes_expenses =
        totals.total_estimated_incomes -
        totals.total_estimated_expenses -
        totals.total_estimated_hours_price -
        totals.total_estimated_expenses_vat;

      // Update backwards compatibility fields
      totals.total_incomes = totals.total_estimated_incomes;
      totals.total_expenses = totals.total_estimated_expenses;
      totals.total_expenses_vat = totals.total_estimated_expenses_vat;
      totals.incomes_expenses = totals.estimated_incomes_expenses;
      totals.balance = totals.estimated_incomes_expenses;
      totals.estimated_balance = totals.estimated_incomes_expenses;

      // Continue with other legacy fields
      Object.assign(totals, {
        // Other legacy fields
        total_expenses_hours: _.sumBy(children, 'total_expenses_hours'),
        dedicated_hours: _.sumBy(children, 'dedicated_hours'),
        invoice_hours: _.sumBy(children, 'invoice_hours'),
        invoice_hours_price: _.sumBy(children, 'invoice_hours_price'),
        total_dedicated_hours: _.sumBy(children, 'total_dedicated_hours'),
        structural_expenses: _.sumBy(children, 'structural_expenses'),
        grantable_amount: _.sumBy(children, 'grantable_amount'),
        grantable_amount_total: _.sumBy(children, 'grantable_amount_total'),
      });

      return {
        children,
        totals,
        project_phases: aggregatedProjectPhases,
        project_original_phases: aggregatedProjectOriginalPhases,
        allByYear: aggregatedAllByYearWithPeriodification,
      };
    } else {
      return {};
    }
  },

  // async updatePhases(ctx) {
  //   const projects = await strapi.db.query('api::project.project').findMany({});

  //   for (let i = 0; i < projects.length; i++) {
  //     const project = projects[i];
  //     if (
  //       project.phases &&
  //       project.phases.length &&
  //       (!project.original_phases || !project.original_phases.length)
  //     ) {
  //       const projectToUpdate = { id: project.id };
  //       projectToUpdate.original_phases = project.phases;
  //       projectToUpdate.original_phases.forEach((p) => {
  //         delete p.id;
  //         p.incomes.forEach((sp) => {
  //           delete sp.id;
  //         });
  //         p.expenses.forEach((sp) => {
  //           delete sp.id;
  //         });
  //       });
  //       await strapi
  //         .query("project")
  //         .update({ id: project.id }, projectToUpdate);
  //     }
  //   }
  //   return { done: true };
  // },

  payExpense: async (ctx) => {
    // const { id, expense } = ctx.params;
    // const project = await strapi.db.query('api::project.project').findOne({ where: { id } });
    // var found = false;
    // if (project && project.id) {
    //   project.project_phases.forEach((ph) => {
    //     const expenseItem = ph.expenses.find((e) => e.id == expense);
    //     if (expenseItem) {
    //       found = true;
    //       expenseItem.paid = true;
    //       if (ctx.request.body.received && ctx.request.body.received.id) {
    //         expenseItem.invoice = ctx.request.body.received.id;
    //       }
    //       if (ctx.request.body.ticket && ctx.request.body.ticket.id) {
    //         expenseItem.ticket = ctx.request.body.ticket.id;
    //       }
    //       if (ctx.request.body.diet && ctx.request.body.diet.id) {
    //         expenseItem.diet = ctx.request.body.diet.id;
    //       }
    //       if (ctx.request.body.expense && ctx.request.body.expense.id) {
    //         expenseItem.expense = ctx.request.body.expense.id;
    //       }
    //     }
    //   });
    //   if (found) {
    //     const projectToUpdate = { phases: project.phases };
    //     await strapi.db.query('api::project.project').update({ id: id }, projectToUpdate);
    //   }
    // }
    // return { id, expense, found };
  },
  payIncome: async (ctx) => {
    // const { id, income } = ctx.params;
    // const project = await strapi.db.query('api::project.project').findOne({ where: { id } });
    // var found = false;
    // if (project && project.id) {
    //   project.phases.forEach((ph) => {
    //     const incomeItem = ph.incomes.find((e) => e.id == income);
    //     if (incomeItem) {
    //       found = true;
    //       incomeItem.paid = true;
    //       if (ctx.request.body.emitted && ctx.request.body.emitted.id) {
    //         incomeItem.emitted = ctx.request.body.emitted.id;
    //       }
    //       if (ctx.request.body.grant && ctx.request.body.grant.id) {
    //         incomeItem.grant = ctx.request.body.grant.id;
    //       }
    //       if (ctx.request.body.income && ctx.request.body.income.id) {
    //         incomeItem.income = ctx.request.body.income.id;
    //       }
    //     }
    //   });
    //   if (found) {
    //     const projectToUpdate = { phases: project.phases };
    //     await strapi.db.query('api::project.project').update({ id: id }, projectToUpdate);
    //   }
    // }
    // return { id, income, found };
  },

  /**
   * Override core create: the phases the form sends are extracted by the
   * project lifecycle and materialized in afterCreate, but they still pass
   * through v5's input validation on the way — and they carry the `dirty`
   * markers the compat middleware preserves for update. Strip those here;
   * nothing on the create path reads them.
   */
  async create(ctx) {
    const data = (ctx.request.body && ctx.request.body.data) || {};
    for (const key of ['project_phases', 'project_original_phases']) {
      stripDirty(data[key]);
    }
    return super.create(ctx);
  },

  /**
   * Override core update: materialize the phase edits the form sends.
   *
   * "GESTIÓ ECONÒMICA" ships the edited phases plus the rows the user removed,
   * flagged with v3 control fields (`_project_phases_updated`,
   * `project_phases_info`). This has to happen here rather than in a lifecycle:
   * v5 validates the input body BEFORE the service runs and rejects any key
   * that is not a model attribute, so the control fields must be consumed and
   * removed while the request is still in the controller.
   */
  async update(ctx) {
    const data = (ctx.request.body && ctx.request.body.data) || {};
    const id = numericId(ctx);

    const sections = [
      {
        flag: '_project_phases_updated',
        phases: 'project_phases',
        info: 'project_phases_info',
        entity: 'project-phases',
      },
      {
        flag: '_project_original_phases_updated',
        phases: 'project_original_phases',
        info: 'project_original_phases_info',
        entity: 'project-original-phases',
      },
    ];

    for (const section of sections) {
      const info = data[section.info];
      if (data[section.flag] && data[section.phases] && info) {
        await strapi
          .controller('api::project.project')
          .updatePhases(
            id,
            section.entity,
            data[section.phases],
            info.deletedPhases || [],
            info.deletedIncomes || [],
            info.deletedExpenses || [],
            info.deletedHours || [],
          );
      }
      // Phases are managed exclusively through updatePhases, so they never
      // belong on a core update — whether or not this request edited them. The
      // form echoes the whole graph back, carrying `dirty` markers that v5's
      // input validation rejects ("Invalid key dirty at project_phases.incomes")
      // and stale rows that would otherwise overwrite the relation.
      delete data[section.phases];
      delete data[section.flag];
      delete data[section.info];
    }

    return super.update(ctx);
  },

  async findOne(ctx) {
    const id = numericId(ctx);
    // Load project with all necessary relations for calculation
    const data = await strapi.db
      .query('api::project.project')
      .findOne({
        where: { id },
        populate: expandPopulate([
        'leader',
        'project_scope',
        'project_state',
        'clients',
        'default_dedication_type',
        'mother',
        'region',
        'project_likelihood',
        'documents',
        'project_type',
        'strategies',
        'intercooperations',
        'emitted_invoices',
        'received_invoices',
        'activity_types',
        'received_incomes',
        'received_expenses',
        'global_activity_types',
        'treasury_annotations',
        'activities',
        'activities.activity_type',
        'project_phases',
        'project_phases.incomes',
        'project_phases.incomes.estimated_hours',
        'project_phases.incomes.estimated_hours.users_permissions_user',
        'project_phases.incomes.income_type',
        'project_phases.incomes.invoice',
        'project_phases.incomes.income',
        'project_phases.expenses',
        'project_phases.expenses.expense_type',
        'project_phases.expenses.invoice',
        'project_phases.expenses.expense',
        'project_original_phases',
        'project_original_phases.incomes',
        'project_original_phases.incomes.estimated_hours',
        'project_original_phases.incomes.estimated_hours.users_permissions_user',
        'project_original_phases.incomes.income_type',
        'project_original_phases.incomes.invoice',
        'project_original_phases.incomes.income',
        'project_original_phases.expenses',
        'project_original_phases.expenses.expense_type',
        'project_original_phases.expenses.invoice',
        'project_original_phases.expenses.expense',
        // v3 returned components without being asked; v5 omits them as soon as
        // an explicit populate is given, and ProjectForm.getAuxiliarData() reads
        // `form.periodification.length` unguarded — so the whole auxiliary-data
        // setup threw on every load.
        'periodification',
        'grantable_years',
        'grantable_contacts',
        ]),
      });

    // Calculate fresh totals to ensure consistency with calculate endpoint
    // This ensures reports and lists get accurate totals from find/findOne methods
    if (data && data.id) {
      const calculatedData = await doProjectInfoCalculations(data, id);
      delete calculatedData.activities;
      // Mother projects: aggregate child totals (v3 afterFindOne port, P5.3).
      if (calculatedData.is_mother) {
        await calculateMotherProjectTotals(calculatedData);
      }
      return calculatedData;
    }

    if (data && data.is_mother) {
      await calculateMotherProjectTotals(data);
    }
    return data;
  },
  async findOneExtended(ctx) {
    const id = numericId(ctx);
    // const data = await strapi.db.query('api::project.project').findOne({ where: { id } });
    const data = await strapi.db
      .query('api::project.project')
      .findOne({
        where: { id },
        populate: expandPopulate([
        'leader',
        'project_scope',
        'project_likelihood',
        'project_state',
        'project_type',
        'clients',
        'default_dedication_type',
        'mother',
        'region',
        'documents',
        'strategies',
        'intercooperations',
        'emitted_invoices',
        'received_invoices',
        'activity_types',
        'received_incomes',
        'received_expenses',
        'global_activity_types',
        'treasury_annotations',
        'global_activity_types',
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
        // v3 returned components without being asked; v5 omits them as soon as
        // an explicit populate is given, and ProjectForm.getAuxiliarData() reads
        // `form.periodification.length` unguarded — so the whole auxiliary-data
        // setup threw on every load.
        'periodification',
        'grantable_years',
        'grantable_contacts',
        ]),
      });

    return data;
  },
  // doCalculateProjectInfo: async (ctx) => {
  //   const { id } = ctx.params;
  //   var start = new Date();
  //   const data = await strapi.db.query('api::project.project').findOne({ where: { id } });
  //   var end = new Date() - start;

  //   const result = await doProjectInfoCalculations(data, id);
  //   var end = new Date() - start;

  //   return result;
  // },

  // getProjectIsDirty: async (ctx) => {
  //   const { id } = ctx.params;
  //   const projects = await strapi
  //     .query("project")
  //     .model.query((qb) => {
  //       qb.select("id", "dirty").where({ id: id });
  //     })
  //     .fetchAll();

  //   const p = projects.map((entity) =>
  //     entity
  //   );

  //   return { id: id, dirty: p[0].dirty };
  // },

  // enqueueProjects: async (projects) => {
  //   //projectsQueue.push(projects);
  // },

  // updateQueuedProjects: async () => {
  //   const projects = projectsQueue.pop();
  //   if (projects && projects.current) {
  //     await updateProjectInfo(projects.current, true);
  //   }
  //   if (
  //     projects &&
  //     projects.previous &&
  //     projects.current !== projects.previous
  //   ) {
  //     await updateProjectInfo(projects.previous, true);
  //   }
  // },

  createPhaseWithNested: async (projectId, entity, phase) => {
    console.log('createPhaseWithNested:', entity, phase.name);

    // Extract nested data
    const { incomes, expenses, ...phaseData } = phase;

    // Create the phase
    const createdPhase = await strapi.db
      .query(PHASE_ENTITY_UIDS[entity])
      .create({ data: { project: projectId, name: phaseData.name } });

    console.log('  - Phase created with id:', createdPhase.id);

    // Create incomes
    if (incomes && incomes.length > 0) {
      console.log('  - Creating', incomes.length, 'incomes');
      for (const income of incomes) {
        const { estimated_hours, ...incomeData } = income;

        // Calculate total_amount
        incomeData.total_amount = (incomeData.quantity || 0) * (incomeData.amount || 0);

        // Clean up bank_account - ensure it's either a valid ID or null
        if (incomeData.bank_account && typeof incomeData.bank_account === 'object') {
          incomeData.bank_account = incomeData.bank_account.id || null;
        }

        // Link to phase
        if (entity === 'project-original-phases') {
          incomeData.project_original_phase = createdPhase.id;
        } else {
          incomeData.project_phase = createdPhase.id;
        }

        const createdIncome = await strapi.db
          .query('api::phase-income.phase-income')
          .create({ data: incomeData });

        // Create estimated_hours for both original and execution phases
        if (estimated_hours && estimated_hours.length > 0) {
          console.log('    - Creating', estimated_hours.length, 'estimated_hours for income');
          for (const hour of estimated_hours) {
            await strapi.db.query('api::estimated-hour.estimated-hour').create({
              data: { ...hour, phase_income: createdIncome.id },
            });
          }
        }
      }
    }

    // Create expenses
    if (expenses && expenses.length > 0) {
      console.log('  - Creating', expenses.length, 'expenses');
      for (const expense of expenses) {
        // Calculate total_amount
        expense.total_amount = (expense.quantity || 0) * (expense.amount || 0);

        // Clean up bank_account - ensure it's either a valid ID or null
        if (expense.bank_account && typeof expense.bank_account === 'object') {
          expense.bank_account = expense.bank_account.id || null;
        }

        // Link to phase
        if (entity === 'project-original-phases') {
          expense.project_original_phase = createdPhase.id;
        } else {
          expense.project_phase = createdPhase.id;
        }

        await strapi.db.query('api::phase-expense.phase-expense').create({ data: expense });
      }
    }

    return createdPhase;
  },
  updatePhases: async (id, entity, phases, deletedPhases, deletedIncomes, deletedExpenses, deletedHours) => {
    for await (const income of deletedIncomes.filter((i) => i)) {
      await strapi.db.query('api::phase-income.phase-income').deleteMany({ where: { id: income } });
    }
    for await (const expense of deletedExpenses.filter((i) => i)) {
      await strapi.db.query('api::phase-expense.phase-expense').deleteMany({ where: { id: expense } });
    }
    for await (const hour of deletedHours.filter((i) => i)) {
      await strapi.db.query('api::estimated-hour.estimated-hour').deleteMany({ where: { id: hour } });
    }
    for await (const phase of deletedPhases.filter((i) => i)) {
      if (entity === 'project-original-phases') {
        const incomesOfPhase = await strapi.db
          .query('api::phase-income.phase-income')
          .findMany({ where: { project_original_phase: phase } });
        for await (const income of incomesOfPhase) {
          await strapi.db.query('api::phase-income.phase-income').deleteMany({ where: { id: income.id } });
        }
        const expensesOfPhase = await strapi.db
          .query('api::phase-expense.phase-expense')
          .findMany({ where: { project_original_phase: phase } });

        for await (const expense of expensesOfPhase) {
          await strapi.db.query('api::phase-expense.phase-expense').deleteMany({ where: { id: expense.id } });
        }
        await strapi.db
          .query(
            entity === 'project-original-phases'
              ? 'api::project-original-phase.project-original-phase'
              : 'api::project-phase.project-phase',
          )
          .deleteMany({ where: { id: phase } });
      } else {
        const incomesOfPhase = await strapi.db
          .query('api::phase-income.phase-income')
          .findMany({ where: { project_phase: phase } });
        for await (const income of incomesOfPhase) {
          await strapi.db.query('api::phase-income.phase-income').deleteMany({ where: { id: income.id } });
        }
        const expensesOfPhase = await strapi.db
          .query('api::phase-expense.phase-expense')
          .findMany({ where: { project_phase: phase } });
        for await (const expense of expensesOfPhase) {
          await strapi.db.query('api::phase-expense.phase-expense').deleteMany({ where: { id: expense.id } });
        }
        await strapi.db
          .query(
            entity === 'project-original-phases'
              ? 'api::project-original-phase.project-original-phase'
              : 'api::project-phase.project-phase',
          )
          .deleteMany({ where: { id: phase } });
      }
    }

    for await (const phase of phases) {
      const { incomes, expenses, ...item } = phase;
      if (!phase.id) {
        const resp = await strapi.db
          .query(PHASE_ENTITY_UIDS[entity])
          .create({ data: { project: id, name: item.name } });
        phase.id = resp.id;
      } else if (phase.dirty) {
        await strapi.db
          .query(PHASE_ENTITY_UIDS[entity])
          .update({ where: { id: phase.id }, data: { project: id, name: item.name } });
      }

      if (incomes) {
        for await (const income of incomes) {
          income.total_amount = (income.quantity || 0) * (income.amount || 0);

          // Clean up bank_account - ensure it's either a valid ID or null
          if (income.bank_account && typeof income.bank_account === 'object' && !income.bank_account.id) {
            income.bank_account = null;
          } else if (income.bank_account && income.bank_account.id) {
            income.bank_account = income.bank_account.id;
          }

          if (!income.id) {
            const { estimated_hours, ...item } = income;
            // v5's db.query create takes { data }, unlike v3 — without it the
            // fields are read as query options and an empty row is written.
            const link =
              entity === 'project-original-phases'
                ? { project_original_phase: phase.id }
                : { project_phase: phase.id };
            const newIncome = await strapi.db
              .query('api::phase-income.phase-income')
              .create({ data: { ...item, ...link } });
            income.id = newIncome.id;
          } else if (income.dirty) {
            const { estimated_hours, ...item } = income;
            await strapi.db
              .query('api::phase-income.phase-income')
              .update({ where: { id: income.id }, data: item });
          }

          // Handle estimated_hours for both original and execution phases
          if (income.estimated_hours) {
            for await (const estimated_hours of income.estimated_hours) {
              if (!estimated_hours.id) {
                await strapi.db.query('api::estimated-hour.estimated-hour').create({
                  data: { ...estimated_hours, phase_income: income.id },
                });
              } else if (estimated_hours.dirty) {
                await strapi.db
                  .query('api::estimated-hour.estimated-hour')
                  .update({ where: { id: estimated_hours.id }, data: estimated_hours });
              }
            }

            // Recalculate total_estimated_hours aggregate for this income
            // This ensures the aggregate is always up-to-date after editing hours
            const allHours = await strapi.db
              .query('api::estimated-hour.estimated-hour')
              .findMany({ where: { phase_income: income.id } });

            const totalEstimatedHours = allHours.reduce((sum, h) => {
              return sum + (h.quantity || 0);
            }, 0);

            await strapi.db
              .query('api::phase-income.phase-income')
              .update({ where: { id: income.id }, data: { total_estimated_hours: totalEstimatedHours } });
          }
        }
      }

      if (expenses) {
        for await (const expense of expenses) {
          expense.total_amount = (expense.quantity || 0) * (expense.amount || 0);

          // Clean up bank_account - ensure it's either a valid ID or null
          if (expense.bank_account && typeof expense.bank_account === 'object' && !expense.bank_account.id) {
            expense.bank_account = null;
          }

          if (!expense.id) {
            if (entity === 'project-original-phases') {
              await strapi.db.query('api::phase-expense.phase-expense').create({
                data: { ...expense, project_original_phase: phase.id },
              });
            } else {
              await strapi.db.query('api::phase-expense.phase-expense').create({
                data: { ...expense, project_phase: phase.id },
              });
            }
          } else if (expense.dirty) {
            await strapi.db
              .query('api::phase-expense.phase-expense')
              .update({ where: { id: expense.id }, data: expense });
          }
        }
      }
    }
  },
  createPhasesForAllProjects: async (ctx) => {
    return; // Disabled in v3; the ETL (Phase 7) handles phase creation.

    // eslint-disable-next-line no-unreachable
    const phases0 = await strapi.db
      .query('api::project-original-phase.project-original-phase')
      .findMany({ limit: 1 });

    if (phases0.length > 0) {
      console.log('phases already created!');
      return;
    }

    await strapi.db.query('api::estimated-hour.estimated-hour').delete({ _limit: -1 });
    console.log('deleted estimated-hours');
    await strapi.db.query('api::phase-income.phase-income').delete({ _limit: -1 });
    console.log('deleted phase-income');
    await strapi.db.query('api::phase-expense.phase-expense').delete({ _limit: -1 });
    console.log('deleted phase-expense');
    await strapi.db.query('api::project-phase.project-phase').delete({ _limit: -1 });
    console.log('deleted project-phases');
    await strapi.db.query('api::project-original-phase.project-original-phase').delete({ _limit: -1 });
    console.log('deleted project-original-phases');
    console.log('deleted all!!!');

    const projects = await strapi.db.query('api::project.project').findMany({});

    for await (const p of projects) {
      // copy p.phases to project-phase
      console.log('project', p.name);
      for await (const ph of p.phases) {
        console.log('phase', ph.name);
        const phase = await strapi.db.query('api::project-phase.project-phase').create({
          name: ph.name,
          project: p.id,
        });
        for await (const income of ph.incomes) {
          if (!income || !income.id) continue;
          console.log('income', income.concept);
          const data = {
            concept: income.concept,
            quantity: income.quantity,
            amount: income.amount,
            total_amount: income.total_amount,
            date: income.date ? income.date.substring(0, 10) : null,
            paid: income.paid,
            client: income.client && income.client.id ? income.client.id : null,
            invoice: income.invoice && income.invoice.id ? income.invoice.id : null,
            total_estimated_hours: income.total_estimated_hours,
            income_type: income.income_type,
            income: income.income && income.income.id ? income.income.id : null,
            date_estimated_document: income.date_estimated_document
              ? income.date_estimated_document.substring(0, 10)
              : null,
            project_phase: phase.id,
          };
          const newIncome = await strapi.db.query('api::phase-income.phase-income').create(data);
        }
        for await (const expense of ph.expenses) {
          if (!expense || !expense.id) continue;
          console.log('expense', expense.concept);
          const data = {
            concept: expense.concept,
            quantity: expense.quantity,
            amount: expense.amount,
            total_amount: expense.total_amount,
            date: expense.date ? expense.date.substring(0, 10) : null,
            paid: expense.paid,
            provider: expense.provider && expense.provider.id ? expense.provider.id : null,
            invoice: expense.invoice && expense.invoice.id ? expense.invoice.id : null,
            total_estimated_hours: expense.total_estimated_hours,
            expense_type: expense.expense_type,
            expense: expense.expense && expense.expense.id ? expense.expense.id : null,
            date_estimated_document: expense.date_estimated_document
              ? expense.date_estimated_document.substring(0, 10)
              : null,
            project_phase: phase.id,
          };
          const newExpense = await strapi.db.query('api::phase-expense.phase-expense').create(data);
        }
      }
      // copy p.original-phases to project-original-phase
      for await (const ph of p.original_phases) {
        console.log('original-phase', ph.name);
        const phase = await strapi.db.query('api::project-original-phase.project-original-phase').create({
          name: ph.name,
          project: p.id,
        });
        for await (const income of ph.incomes) {
          console.log('income', income.concept);
          if (!income || !income.id) continue;
          const data = {
            concept: income.concept,
            quantity: income.quantity,
            amount: income.amount,
            total_amount: income.total_amount,
            date: income.date ? income.date.substring(0, 10) : null,
            // paid: income.paid,
            //client: income.client,
            //invoice: income.invoice,
            total_estimated_hours: income.total_estimated_hours,
            income_type: income.income_type,
            //income: income.income,
            date_estimated_document: income.date_estimated_document
              ? income.date_estimated_document.substring(0, 10)
              : null,
            project_original_phase: phase.id,
          };
          const newIncome = await strapi.db.query('api::phase-income.phase-income').create(data);

          for await (const estimated_hours of income.estimated_hours) {
            console.log('estimated_hours', estimated_hours.hours);
            const data = {
              users_permissions_user: estimated_hours.users_permissions_user,
              quantity: estimated_hours.quantity,
              amount: estimated_hours.amount,
              total_amount: estimated_hours.total_amount,
              comment: estimated_hours.comment,
              from: estimated_hours.from,
              to: estimated_hours.to,
              monthly_quantity: estimated_hours.monthly_quantity,
              quantity_type: estimated_hours.quantity_type,
              phase_income: newIncome.id,
            };
            const newEstimatedHours = await strapi.db.query('api::estimated-hour.estimated-hour').create({ data });
          }
        }
        for await (const expense of ph.expenses) {
          if (!expense || !expense.id) continue;
          console.log('expense', expense.concept);
          const data = {
            concept: expense.concept,
            quantity: expense.quantity,
            amount: expense.amount,
            total_amount: expense.total_amount,
            date: expense.date ? expense.date.substring(0, 10) : null,
            // paid: expense.paid,
            //provider: expense.provider,
            //invoice: expense.invoice,
            total_estimated_hours: expense.total_estimated_hours,
            expense_type: expense.expense_type,
            //expense: expense.expense,
            date_estimated_document: expense.date_estimated_document
              ? expense.date_estimated_document.substring(0, 10)
              : null,
            project_original_phase: phase.id,
          };
          const newExpense = await strapi.db.query('api::phase-expense.phase-expense').create(data);
        }
      }
    }
  },
}));

/**
 * Aggregates child totals onto a mother project (ported verbatim from the v3
 * afterFind/afterFindOne lifecycle helpers; lives here since v5 removed those hooks).
 */
async function calculateMotherProjectTotals(motherProject) {
  try {
    const children = await strapi.db
      .query('api::project.project')
      .findMany({ where: { mother: motherProject.id } });
    if (!children || children.length === 0) return;

    for (const f of [
      'total_original_incomes',
      'total_original_expenses',
      'total_original_hours',
      'total_original_hours_price',
      'total_original_expenses_vat',
      'original_incomes_expenses',
      'total_estimated_incomes',
      'total_estimated_expenses',
      'total_estimated_hours',
      'total_estimated_hours_price',
      'total_estimated_expenses_vat',
      'estimated_incomes_expenses',
      'total_real_incomes',
      'total_real_expenses',
      'total_real_hours',
      'total_real_hours_price',
      'total_real_expenses_vat',
      'total_real_incomes_expenses',
      'total_incomes',
      'total_expenses',
      'incomes_expenses',
    ]) {
      motherProject[f] = 0;
    }

    for (const child of children) {
      for (const f of [
        'total_original_incomes',
        'total_original_expenses',
        'total_original_hours',
        'total_original_hours_price',
        'total_original_expenses_vat',
        'original_incomes_expenses',
        'total_estimated_incomes',
        'total_estimated_expenses',
        'total_estimated_hours',
        'total_estimated_hours_price',
        'total_estimated_expenses_vat',
        'estimated_incomes_expenses',
        'total_real_incomes',
        'total_real_expenses',
        'total_real_hours',
        'total_real_hours_price',
        'total_real_expenses_vat',
        'total_real_incomes_expenses',
      ]) {
        motherProject[f] += parseFloat(child[f] || 0);
      }
      // Backwards-compat fields fall back to the estimated dimension.
      motherProject.total_incomes += parseFloat(child.total_incomes || child.total_estimated_incomes || 0);
      motherProject.total_expenses += parseFloat(child.total_expenses || child.total_estimated_expenses || 0);
      motherProject.incomes_expenses += parseFloat(
        child.incomes_expenses || child.estimated_incomes_expenses || 0,
      );
    }
  } catch (error) {
    console.error(`Error calculating mother project totals for project ${motherProject.id}:`, error);
  }
}
