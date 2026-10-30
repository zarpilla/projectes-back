'use strict';
/* global strapi */
const { createCoreController } = require('@strapi/strapi').factories;
const _ = require('lodash');
const moment = require('moment');
const { liveChildrenWhere, addChildrenTotals, addChildrenTotalsToList } = require('../services/motherChildren');
const {
  adaptQuery,
  adaptCtxQuery,
  expandPopulate,
  toDbArgs,
  v3FindArgs,
} = require('../../../services/query-adapter');
const { numericId } = require('../../../middlewares/v3-compat');
const { getDailyDedications, getFestives } = require('../../../services/calendars');
const { getMe } = require('../../../services/me-settings');
const { fiscalYearStartMonth } = require('../../../services/fiscal-year');
const { documentsOfProject, mergeDocuments, refreshLineWarnings } = require('../../../services/refresh-line-warnings');
const { loadActivitiesByProjectMonth } = require('../services/economic-detail-activities');
const { getReadCache } = require('../../../services/read-cache');
const { queryTables } = require('../../../services/query-tables');
const { LINKED_POPULATE, mergeLinkedDocuments } = require('../services/projectDocuments');
const { lineTotal, invalidLineValueMessage, assignLinePositions, sortPhasesByPosition } = require('../../../services/budget-line');
const { touchesDates, projectDatesError } = require('../../../services/project-dates');
const { BILLING_MODES, priceHoursLines } = require('../../../services/hours-billing');
const {
  buildProjectRows,
  aggregateRowsByYear,
  findUndatedLines,
  buildSingleProjectActivitiesMap,
  calculateEstimatedTotals,
  getProjectDefaultYear,
  buildPlannedHoursByMonth,
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
    fiscalYearStartMonth: fiscalYearStartMonth(me),
  };

  const rows = await buildProjectRows(data, financialsCtx);

  data.allByYear = aggregateRowsByYear(rows);
  // Lines the form must flag: they put a "9999" year in the periodification (issues/015).
  data.undatedLines = findUndatedLines(data);

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
  const childProjects = await strapi.db.query('api::project.project').count({ where: liveChildrenWhere(id) });
  data.is_mother = childProjects > 0;

  return data;
};

let projectsQueue = [];

// Relations left out of the default populate of a project list and of the entity
// a project update answers with. The creator fields are Strapi's own and are
// not populatable over REST ("Invalid key createdBy").
const DEFAULT_POPULATE_SKIPS = ['activities', 'createdBy', 'updatedBy', 'localizations'];

/** The v3 default populate (`*`: first-level relations, components and media) minus `skip`. */
const firstLevelPopulateWithout = (skip) => {
  const { attributes } = strapi.contentType('api::project.project');
  return Object.keys(attributes).filter(
    (name) =>
      ['relation', 'component', 'media', 'dynamiczone'].includes(attributes[name].type) &&
      !skip.includes(name),
  );
};

// The same as an object populate, with the relations inside the grant
// components: populating a component doesn't populate its relations, so
// grantable_years came without their `year` and Justificacions couldn't tell
// which year an amount was for (issues/059).
const firstLevelPopulateWithComponentRelations = (skip) => ({
  ...Object.fromEntries(firstLevelPopulateWithout(skip).map((name) => [name, true])),
  grantable_years: { populate: { year: true } },
  grantable_contacts: { populate: { contact: true } },
});

// issues/345: a line (or a phase) that only moved gets its new position with
// updateMany, which runs no lifecycle (the order changes no total).
const saveLinePositions = async (uid, moved) => {
  for (const { id, position } of moved) {
    await strapi.db.query(uid).updateMany({ where: { id }, data: { position } });
  }
};

// v3 plural entity names used by the phase helpers -> v5 UIDs
// ('project-phases' / 'project-original-phases').
const PHASE_ENTITY_UIDS = {
  'project-phases': 'api::project-phase.project-phase',
  'project-original-phases': 'api::project-original-phase.project-original-phase',
};

// What the economic detail reads of each project: everything buildProjectRows
// (projectFinancials.js) turns into rows, the same as the form's RESUM FINANCER.
// Only the fields the rows use (issues/309): the activities are summed by the
// database (loadActivitiesByProjectMonth), the linked documents give only their
// dates and VAT, the planned hours only their person's id. Loading all of it
// made the report the slowest call of the app.
const ECONOMIC_DETAIL_DOCUMENT = { select: ['id', 'emitted', 'paid_date', 'total_vat'] };
const ECONOMIC_DETAIL_PHASES = {
  populate: {
    incomes: {
      populate: {
        estimated_hours: { populate: { users_permissions_user: { select: ['id'] } } },
        income_type: true,
        invoice: ECONOMIC_DETAIL_DOCUMENT,
        income: ECONOMIC_DETAIL_DOCUMENT,
      },
    },
    expenses: {
      populate: { expense_type: true, invoice: ECONOMIC_DETAIL_DOCUMENT, expense: ECONOMIC_DETAIL_DOCUMENT },
    },
  },
};
const ECONOMIC_DETAIL_POPULATE = {
  project_state: true,
  project_scope: true,
  project_likelihood: true,
  project_type: true,
  leader: { select: ['id', 'username'] },
  // the «Mare» dimension carries the mother's name, not the project's (issues/282)
  mother: { select: ['id', 'name'] },
  // the yearly adjustments of the form's PERIODIFICACIÓ card (issues/171)
  periodification: true,
  project_phases: ECONOMIC_DETAIL_PHASES,
  project_original_phases: ECONOMIC_DETAIL_PHASES,
};

// What projects/phases-both keeps of every project (issues/309): the planned
// hours need the phase trees, the report the dimensions.
const PHASES_BOTH_PHASES = {
  populate: {
    incomes: {
      populate: { estimated_hours: { populate: { users_permissions_user: { select: ['id'] } } } },
    },
  },
};
const PHASES_BOTH_POPULATE = {
  project_phases: PHASES_BOTH_PHASES,
  project_original_phases: PHASES_BOTH_PHASES,
  project_state: true,
  leader: { select: ['id', 'username'] },
  project_scope: true,
  default_dedication_type: true,
};
// Frozen and shared, never copied; each piece declares the tables its query
// reads, so their MySQL stamps are read before its first load (issues/307).
const phasesBothTables = new Map();
const phasesBothData = (name, [uid, populate], loader) => {
  if (!phasesBothTables.has(name)) phasesBothTables.set(name, [...queryTables(strapi, uid, populate)]);
  return getReadCache().get(`project.phases-both:${name}`, loader, {
    frozen: true,
    verifyRate: 0,
    tables: phasesBothTables.get(name),
  });
};
const PHASES_BOTH_ACTIVITY_POPULATE = {
  project: { select: ['id'] },
  users_permissions_user: { select: ['id'] },
  activity_type: { select: ['id'] },
  dedication_type: { select: ['id'] },
};
// State filter of projects/economic-detail (Ingressos/Despeses, Preu hora).
// The id 0 is the «Sense estat» chip: projects without a project_state
// (issues/205).
const NO_STATE = 0;
const economicDetailStateIds = (stateIds) =>
  (stateIds || []).map((s) => parseInt(s, 10)).filter((n) => !isNaN(n));
const economicDetailStateFilter = (stateIds) => {
  const ids = economicDetailStateIds(stateIds);
  const withState = { project_state: { id: { $in: ids.filter((n) => n !== NO_STATE) } } };
  if (!ids.includes(NO_STATE)) return withState;
  return { $or: [withState, { project_state: { id: { $null: true } } }] };
};
/** The same filter on a project's state id (null: no state), applied in memory. */
const economicDetailStateMatch = (stateIds) => {
  const ids = economicDetailStateIds(stateIds);
  const withState = new Set(ids.filter((n) => n !== NO_STATE));
  const withoutState = ids.includes(NO_STATE);
  return (state) => (state === null ? withoutState : withState.has(state));
};

// The projects of the economic detail: the published ones (mothers are left
// out after loading, their children carry the figures).
const ECONOMIC_DETAIL_QUERY = { _limit: -1, published_at_null: false };

/**
 * The engine's context shared by every project of the economic detail: the
 * calendars, the executed hours per project and month (issues/060, summed by
 * the database since issues/309), the deductible VAT and the fiscal year.
 */
async function economicDetailContext(projects, dailyDedications, festives) {
  const activitiesByProject = await loadActivitiesByProjectMonth(projects.map((p) => p.id));
  const me = await getMe();
  const fallback_deductible_vat_pct =
    me.options && me.options.deductible_vat_pct ? me.options.deductible_vat_pct : 100.0;
  const yearEntities = await strapi.db.query('api::year.year').findMany({});
  const deductibleVatPctByYear = new Map(
    (yearEntities || [])
      .filter((y) => y && y.year)
      .map((y) => [String(y.year), parseFloat(y.deductible_vat_pct || 100)]),
  );
  return {
    dailyDedications,
    festives,
    deductibleVatPctByYear,
    fallback_deductible_vat_pct,
    activitiesByProject,
    fiscalYearStartMonth: fiscalYearStartMonth(me),
  };
}

/**
 * The year, state and paid filters of projects/economic-detail on the rows of
 * the chosen projects, and its order. The rows' `document` (the whole linked
 * invoice) is left out: the reports drop it on arrival and it was a third of
 * the response (issues/309).
 */
const ECONOMIC_DETAIL_ORDER = ['year', 'date', 'name'];

// The rows of every published, non-mother project, computed once and kept by
// the read cache (issues/307): 1 s locally and ~6.8 s in production on every
// change of chip in Ingressos/Despeses or Preu hora. Kept in the order the
// answers have, each row with its project's state: a request only filters.
// Frozen and shared: answers are made of copies. The current year is in the
// key: undated projects take it (getProjectDefaultYear).
const MB = 1024 * 1024;
const economicDetailTables = () => [
  ...new Set([
    ...queryTables(strapi, 'api::project.project', ECONOMIC_DETAIL_POPULATE),
    ...queryTables(strapi, 'api::activity.activity', { project: true }),
    ...queryTables(strapi, 'api::me.me', '*'),
    ...queryTables(strapi, 'api::year.year'),
  ]),
];

async function loadEconomicDetail() {
  const [all, dailyDedications, festives] = await Promise.all([
    strapi.db
      .query('api::project.project')
      .findMany(toDbArgs(adaptQuery(ECONOMIC_DETAIL_QUERY), ECONOMIC_DETAIL_POPULATE)),
    getDailyDedications(),
    getFestives(),
  ]);
  const projects = all.filter((p) => !p.is_mother);
  const financialsCtx = await economicDetailContext(projects, dailyDedications, festives);
  const perProject = await Promise.all(projects.map((p) => buildProjectRows(p, financialsCtx)));
  const items = [];
  perProject.forEach((rows, i) => {
    const p = projects[i];
    const state = p.project_state && p.project_state.id ? p.project_state.id : null;
    for (const { document: _document, ...row } of rows) items.push({ row, state });
  });
  // lodash's sortBy is stable: filtering this order gives each answer's order
  const sorted = _.sortBy(items, ECONOMIC_DETAIL_ORDER.map((field) => (item) => item.row[field]));
  return { rows: sorted.map((item) => item.row), states: sorted.map((item) => item.state) };
}

const economicDetailRows = () =>
  getReadCache().get(`project.economic-detail:${moment().format('YYYY')}`, loadEconomicDetail, {
    frozen: true,
    // a verified hit would redo the whole computation
    verifyRate: 0,
    // ~11 MB on resilience, the biggest tenant
    maxBytes: 32 * MB,
    tables: economicDetailTables(),
  });

/**
 * projects/economic-detail computed on the projects the database finds: for a
 * search by name (`_q`) or one state (`_where[project_state_eq]`), which the
 * kept rows (economicDetailRows) don't cover.
 */
async function economicDetailComputed(ctx) {
  const { paid } = ctx.query;
  const year = ctx.query && ctx.query._where && ctx.query._where.year_eq ? ctx.query._where.year_eq : null;

  // `_where` on this endpoint carries its own control params — `year_eq`
  // selects the reporting year and `project_state_in`/`_eq` the state filter.
  // Neither is a column on `projects`, so the whole ctx.query must never be
  // handed to adaptQuery: `year` reached the projects table as a field filter
  // and answered "Unknown column 't0.year' in 'where clause'". Build the
  // project query explicitly instead, on both branches.
  const projectQuery = { ...ECONOMIC_DETAIL_QUERY };
  let stateFilter = null;
  if (ctx.query && ctx.query._where) {
    if (ctx.query._where.project_state_eq) {
      projectQuery.project_state = ctx.query._where.project_state_eq;
    } else if (ctx.query._where.project_state_in) {
      const stateIds =
        typeof ctx.query._where.project_state_in === 'string'
          ? ctx.query._where.project_state_in.split(',').map((s) => parseInt(s))
          : ctx.query._where.project_state_in;
      stateFilter = economicDetailStateFilter(stateIds);
    }
  }
  // the state filter is ANDed apart: the `_q` search already uses `$or`
  const withStates = (args) => (stateFilter ? { ...args, where: { $and: [args.where, stateFilter] } } : args);
  const projectArgs = ctx.query._q
    ? withStates(
        toDbArgs(adaptQuery({ ...projectQuery, _q: ctx.query._q }, { searchFields: ['name'] }), ECONOMIC_DETAIL_POPULATE),
      )
    : withStates(toDbArgs(adaptQuery(projectQuery), ECONOMIC_DETAIL_POPULATE));

  const [found, dailyDedications, festives] = await Promise.all([
    strapi.db.query('api::project.project').findMany(projectArgs),
    getDailyDedications(),
    getFestives(),
  ]);
  // Filter out mother projects to avoid double-counting (children are already included)
  const projects = found.filter((p) => !p.is_mother);
  const financialsCtx = await economicDetailContext(projects, dailyDedications, festives);

  // Delegate all per-project row construction to the shared engine so
  // the pivot view cannot drift from the form's RESUM FINANCER.
  const projectResponses = await Promise.all(projects.map((p) => buildProjectRows(p, financialsCtx)));
  let response = [];
  for (const rows of projectResponses) {
    for (const { document: _document, ...row } of rows) response.push(row);
  }
  if (year) {
    response = response.filter((r) => r.year === year);
  }
  if (ctx.query && ctx.query._where && ctx.query._where.year_eq) {
    response = response.filter((r) => r.year.toString() === ctx.query._where.year_eq.toString());
  }
  if (paid != null) {
    response = response.filter((r) => r.paid === (paid === 'true'));
  }
  // By date within each year: with a fiscal year starting in September,
  // sorting by month put January before the September that opens the year.
  return _.sortBy(response, ECONOMIC_DETAIL_ORDER);
}

module.exports = createCoreController('api::project.project', ({ strapi }) => ({
  /**
   * find override — ports the v3 afterFind hook (removed in v5): aggregates
   * child totals onto mother projects in list responses.
   */
  async find(ctx) {
    // The v3 default populate brought every activity of every project along:
    // 83% of an 11 MB answer, and most of the 4.4 s it took, for lists that
    // never read them. The views that do ask `projects/with-activities`
    // (issues/016). An explicit populate is left alone.
    if (ctx.state.v3DefaultPopulate) {
      ctx.query = { ...ctx.query, populate: firstLevelPopulateWithout(DEFAULT_POPULATE_SKIPS) };
    }
    // Without the trashed projects unless the caller filters on them: Projectes
    // mare, Estratègies and Intercooperació listed and counted them (issues/236)
    if (ctx.query.published_at_null === undefined && !JSON.stringify(ctx.query).includes('trashed')) {
      ctx.query = { ...ctx.query, published_at_null: false };
    }
    adaptCtxQuery(ctx);
    const response = await super.find(ctx);
    const rows = response?.data;
    if (Array.isArray(rows) && !ctx.state.ownTotals) {
      for (const entry of rows) {
        const attrs = entry?.attributes || entry;
        if (attrs && attrs.is_mother) {
          await calculateMotherProjectTotals(attrs);
        }
      }
    }
    return response;
  },

  /**
   * GET /projects/with-activities — the project list (same filters and shape as
   * GET /projects) with each project's `activities`, for the views that work on
   * the logged hours: the "Projectes" and "Dedicació" pivots and the real hours
   * of a justification.
   *
   * The activities carry their relations as ids (`project`,
   * `users_permissions_user`, `activity_type`, `dedication_type`), which is how
   * v3 nested them and what those views compare against.
   */
  async findWithActivities(ctx) {
    // without the trashed projects, like the list (issues/128)
    if (ctx.query.published_at_null === undefined) {
      ctx.query = { ...ctx.query, published_at_null: false };
    }
    if (ctx.query.populate === undefined) {
      ctx.query = { ...ctx.query, populate: firstLevelPopulateWithComponentRelations(DEFAULT_POPULATE_SKIPS) };
    }
    // Each project with its own totals, like projects/basic: the list comes with
    // the children too, and the Panell de projectes, which sums every row,
    // counted them twice through their mother's aggregated totals (issues/169).
    ctx.state = { ...ctx.state, ownTotals: true };
    const response = await strapi.controller('api::project.project').find(ctx);
    const rows = (response && response.data) || [];
    if (rows.length === 0) return response;

    const only = { select: ['id'] };
    const activities = await strapi.db.query('api::activity.activity').findMany({
      where: { project: { id: { $in: rows.map((row) => row.id) } } },
      populate: { project: only, users_permissions_user: only, activity_type: only, dedication_type: only },
      orderBy: { id: 'asc' },
    });
    const idOf = (relation) => (relation && relation.id) || null;
    const byProject = new Map();
    for (const activity of activities) {
      const projectId = idOf(activity.project);
      if (!byProject.has(projectId)) byProject.set(projectId, []);
      byProject.get(projectId).push({
        ...activity,
        project: projectId,
        users_permissions_user: idOf(activity.users_permissions_user),
        activity_type: idOf(activity.activity_type),
        dedication_type: idOf(activity.dedication_type),
      });
    }
    for (const row of rows) row.activities = byProject.get(row.id) || [];
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
        // Populating a component does NOT populate the relations inside it, so
        // the `year` and `contact` need naming explicitly. Without them the
        // component came back with its amounts but no `year` key at all, and
        // ProjectGrantableYears' <b-select> had nothing to match its options
        // against — the "Imports per any" dropdown rendered blank.
        'grantable_years.year',
        'grantable_contacts.contact',
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
          // ModalBoxDedication ("Entrada hores") preselects "Tipus dedicació"
          // from this, and DedicationEstPivot renders it as a column. v3 kept
          // it as an FK column so it was always on the row; unpopulated in v5
          // it is absent entirely, and the frontend's
          // `default_dedication_type === null` branch never matches undefined,
          // so nothing was ever preselected.
          'default_dedication_type',
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
          // ModalBoxDedication ("Entrada hores") preselects "Tipus dedicació"
          // from this, and DedicationEstPivot renders it as a column. v3 kept
          // it as an FK column so it was always on the row; unpopulated in v5
          // it is absent entirely, and the frontend's
          // `default_dedication_type === null` branch never matches undefined,
          // so nothing was ever preselected.
          'default_dedication_type',
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

    // a mother shows its children's figures, like Projectes mare (issues/172)
    return addChildrenTotalsToList(newArray);
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
  //   plannedHours=true                (optional, add `planned_hours`: the
  //                                     project's hours by person and month,
  //                                     computed like its stored total; issues/067)
  // Informes › Dedicació (DedicationEstPivot). The projects, their logged hours,
  // the calendars and the festives are loaded once without any filter and kept
  // by the read cache (issues/307, 309); the query string filters them on every
  // request: _where[project_state_in], and optionally `year` (calendar year of
  // the hours), `user` and `project`, which the report applied after
  // downloading everything (4.6 s and 6.4 MB on resilience).
  // The answer leaves out the phase trees (only used here to compute
  // `planned_hours`) and keeps of each activity what the report reads.
  async findWithPhasesBoth(ctx) {
    const { activities, plannedHours } = ctx.query;
    const where = ctx.query._where || {};
    const project_state_in = where.project_state_in || ctx.query.project_state_in;

    if (ctx.query._q) {
      // v3 parity: the _q branch ignored the search term and only populated
      // the phase collections one level.
      return strapi.db.query('api::project.project').findMany({
        populate: { project_phases: true, project_original_phases: true },
      });
    }

    const stateIds = project_state_in
      ? String(project_state_in)
          .split(',')
          .map((s) => parseInt(s.trim(), 10))
          .filter((n) => !isNaN(n))
      : [];
    const year = parseInt(ctx.query.year, 10) > 0 ? String(parseInt(ctx.query.year, 10)) : null;
    const userId = parseInt(ctx.query.user, 10) > 0 ? parseInt(ctx.query.user, 10) : null;
    const projectId = parseInt(ctx.query.project, 10) > 0 ? parseInt(ctx.query.project, 10) : null;

    const all = await phasesBothData('projects', ['api::project.project', PHASES_BOTH_POPULATE], () =>
      strapi.db.query('api::project.project').findMany({
        // date_start / createdAt back the pivot's "Any" dimension, which reads
        // `p.date_start || p.created_at`.
        select: ['id', 'name', 'trashed', 'date_start', 'createdAt'],
        populate: PHASES_BOTH_POPULATE,
      }),
    );
    const projects = all.filter(
      (p) =>
        p.trashed !== true &&
        (!stateIds.length || (p.project_state && stateIds.includes(p.project_state.id))) &&
        (!projectId || p.id === projectId),
    );

    let activitiesByProject = null;
    if (activities) {
      // their relations as ids, like with-activities (what DedicationEstPivot reads)
      const rows = await phasesBothData('activities', ['api::activity.activity', PHASES_BOTH_ACTIVITY_POPULATE], () =>
        strapi.db.query('api::activity.activity').findMany({
          select: ['id', 'date', 'hours', 'cost_by_hour'],
          populate: PHASES_BOTH_ACTIVITY_POPULATE,
        }),
      );
      const idOf = (relation) => (relation && relation.id) || null;
      activitiesByProject = new Map();
      for (const a of rows) {
        const pid = idOf(a.project);
        if (!pid) continue;
        if (year && !(a.date && a.date.substring(0, 4) === year)) continue;
        const uid = idOf(a.users_permissions_user);
        if (userId && uid !== userId) continue;
        if (!activitiesByProject.has(pid)) activitiesByProject.set(pid, []);
        activitiesByProject.get(pid).push({
          id: a.id,
          date: a.date,
          hours: a.hours,
          cost_by_hour: a.cost_by_hour,
          users_permissions_user: uid,
          activity_type: idOf(a.activity_type),
          dedication_type: idOf(a.dedication_type),
        });
      }
    }

    let dailyDedications = null;
    let festives = null;
    if (plannedHours === 'true' || plannedHours === true) {
      // shared with the other reports and the project form (services/calendars.js)
      [dailyDedications, festives] = await Promise.all([getDailyDedications(), getFestives()]);
    }

    // New objects only: the kept data is shared between requests, and the
    // response sanitizer (app-permissions) deletes fields of what it answers.
    const copyOf = (relation) => (relation ? { ...relation } : relation);
    const out = [];
    for (const p of projects) {
      const { project_phases: _phases, project_original_phases: _original, ...rest } = p;
      const row = {
        ...rest,
        project_state: copyOf(p.project_state),
        leader: copyOf(p.leader),
        project_scope: copyOf(p.project_scope),
        default_dedication_type: copyOf(p.default_dedication_type),
      };
      if (activitiesByProject) row.activities = activitiesByProject.get(p.id) || [];
      if (dailyDedications) {
        const planned = await buildPlannedHoursByMonth(p, dailyDedications, festives);
        row.planned_hours = planned.filter((h) => (!year || h.year === year) && (!userId || h.user === userId));
      }
      out.push(row);
    }
    return out;
  },

  // precomputed cells) plus the per-day dedications rows used by the Excel
  // export. Moves the expensive per-day expansion + re-aggregation previously
  // done client-side (DedicationGantt.vue / DedicationGanttChart.vue) to the
  // server. Query params mirror /projects/phases:
  //   _where[project_state_in]=1,2,3   (required, comma-separated)
  //   hoursType=previstes|original      (default previstes)
  //   year=2026                         (default current year)
  //   view=month|week                   (default month)
  //   rows=false                        without the per-day Excel rows
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
      rows: ctx.query.rows !== 'false',
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

  // Informes › Ingressos/Despeses and Preu hora (EconomicDetailPivot,
  // PricePerHourDetail):
  //   _where[project_state_in]=1,2,0   states (0: «Sense estat», issues/205)
  //   _where[year_eq]=2026             the rows of one year
  //   paid=true|false                  only the paid or the unpaid rows
  // Answered from the rows kept by the read cache (issues/307); a search by
  // name (`_q`) or one state (`_where[project_state_eq]`) is computed as
  // before, on the projects the database finds.
  async findWithEconomicDetail(ctx) {
    const where = (ctx.query && ctx.query._where) || {};
    if (ctx.query._q || where.project_state_eq) return economicDetailComputed(ctx);

    const { paid } = ctx.query;
    const year = where.year_eq || null;
    const wanted = where.project_state_in
      ? economicDetailStateMatch(
          typeof where.project_state_in === 'string'
            ? where.project_state_in.split(',').map((s) => parseInt(s))
            : where.project_state_in,
        )
      : null;

    const { rows, states } = await economicDetailRows();
    const response = [];
    for (let i = 0; i < rows.length; i++) {
      if (wanted && !wanted(states[i])) continue;
      const r = rows[i];
      if (year && r.year !== year) continue;
      if (where.year_eq && r.year.toString() !== where.year_eq.toString()) continue;
      if (paid != null && r.paid !== (paid === 'true')) continue;
      // a copy: the kept rows are shared and the response sanitizer deletes fields
      response.push({ ...r });
    }
    return response;
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

  /**
   * Planned hours by day of the projects (Justificacions «Previstes»). They
   * come from the current estimate (`project_phases`, «Previsió»), like the
   * project's «Hores previstes», not from the original budget (issues/283,
   * user decision 2026-10-20).
   */
  async findEstimatedTotalsByDay(ctx) {
    ctx.query.published_at_null = false;
    const { year, ...query } = ctx.query;

    const promises = [];
    promises.push(
      strapi.db
        .query('api::project.project')
        .findMany(
          v3FindArgs(query, [
            'project_phases',
            'project_phases.incomes',
            'project_phases.incomes.estimated_hours',
            'project_phases.incomes.estimated_hours.users_permissions_user',
          ]),
        ),
    );

    // the calendars from the read cache, shared with the other reports (issues/307)
    promises.push(getDailyDedications());
    promises.push(getFestives());

    const results = await Promise.all(promises);

    let projects = results[0];
    const dailyDedications = results[1];
    const festives = results[2];

    const totals = [];
    for await (const p of projects) {
      // Same arguments as the stored «Hores previstes» (pushHoursRows).
      const { totalsByDay } = await calculateEstimatedTotals(
        { id: p.id, name: p.name },
        p.project_phases,
        dailyDedications,
        festives,
        true,
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
        where: liveChildrenWhere(id),
        populate: {
          // the mother's Planificació splits its children into active and not (issues/282)
          project_state: true,
          project_phases: phasePopulate,
          project_original_phases: phasePopulate,
        },
      });
      const children = childrenAll.filter((c) => c.id != id);
      children.forEach((c) => {
        sortPhasesByPosition(c.project_phases);
        sortPhasesByPosition(c.project_original_phases);
      });

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
            total_estimated_incomes: _.sumBy(rows, (r) => parseFloat(r.total_estimated_incomes || 0)),
            total_estimated_expenses: _.sumBy(rows, (r) => parseFloat(r.total_estimated_expenses || 0)),
            total_estimated_expenses_vat: _.sumBy(rows, (r) =>
              parseFloat(r.total_estimated_expenses_vat || 0),
            ),
            // the children's estimated hours, not their original ones (issues/172)
            total_estimated_hours: _.sumBy(rows, (r) => parseFloat(r.total_estimated_hours || 0)),
            total_estimated_hours_price: _.sumBy(rows, (r) => parseFloat(r.total_estimated_hours_price || 0)),
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
    // End before start is refused (issues/212)
    const datesError = projectDatesError(data);
    if (datesError) return ctx.badRequest(datesError);
    // A new project is billed per project or by the hour as Configuració says (issues/371)
    if (!BILLING_MODES.includes(data.billing_mode)) {
      // settings that can't be read don't stop the create: «Projecte», as before
      const me = await Promise.resolve()
        .then(() => getMe({ options: true }))
        .catch(() => null);
      data.billing_mode = (me && me.options && me.options.default_billing_mode) === 'hours' ? 'hours' : 'project';
      if (ctx.request.body && ctx.request.body.data) ctx.request.body.data = data;
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

    // A non-numeric quantity / price is the caller's error, not a 500 (issues/224)
    for (const section of sections) {
      const message = data[section.flag] ? invalidLineValueMessage(data[section.phases]) : null;
      if (message) return ctx.badRequest(message);
    }

    // End before start is refused; a request with one of the dates is checked
    // against the stored other one (issues/212)
    if (touchesDates(data)) {
      // `id` is the documentId when the v3 middleware did not rewrite the
      // request (PUT /api/projects/<documentId>), so look it up by either
      const where = /^\d+$/.test(String(id)) ? { id: Number(id) } : { documentId: id };
      const stored = 'date_start' in data && 'date_end' in data
        ? {}
        : await strapi.db.query('api::project.project').findOne({ where, select: ['date_start', 'date_end'] });
      const datesError = projectDatesError(data, stored);
      if (datesError) return ctx.badRequest(datesError);
    }

    // One transaction for the phase writes and the core update: if the update
    // fails (validation, beforeUpdate totals, afterUpdate is_mother), the phase
    // edits roll back too instead of surviving a 500. db.query and the
    // document service both join the ambient transaction.
    return strapi.db.transaction(async () => {
      let phasesEdited = false;
      for (const section of sections) {
        const info = data[section.info];
        if (data[section.flag] && data[section.phases] && info) {
          // The documents the execution lines point to, before and after the
          // save, get their «Imports diferents» warning recomputed (issues/094).
          const execution = section.entity === 'project-phases';
          const linkedBefore = execution ? await documentsOfProject(id) : null;
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
          if (execution) {
            phasesEdited = true;
            await refreshLineWarnings(mergeDocuments(linkedBefore, await documentsOfProject(id)));
          }
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

      // A project billed by the hour prices its income lines with estimated
      // hours as hours × price/hour, before beforeUpdate recomputes the totals
      // from the stored lines (issues/371)
      if (phasesEdited || 'billing_mode' in data || 'invoice_hours_price' in data) {
        const where = /^\d+$/.test(String(id)) ? { id: Number(id) } : { documentId: id };
        const stored = await strapi.db
          .query('api::project.project')
          .findOne({ where, select: ['id', 'billing_mode', 'invoice_hours_price'] });
        if (stored) {
          await priceHoursLines(stored.id, {
            mode: 'billing_mode' in data ? data.billing_mode : stored.billing_mode,
            pricePerHour: 'invoice_hours_price' in data ? data.invoice_hours_price : stored.invoice_hours_price,
          });
        }
      }

      // The saved project is echoed back with the v3 default populate, which
      // includes every activity ever logged on it: 1.3 MB and a second of
      // sanitizing for a project with 4,400 of them, on every save and on every
      // document assigned to one of its lines. No view reads them from this
      // answer (issues/016).
      if (ctx.state.v3DefaultPopulate) {
        ctx.query = { ...ctx.query, populate: firstLevelPopulateWithout(DEFAULT_POPULATE_SKIPS) };
      }

      return super.update(ctx);
    });
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
        // the documents linked through their `projects` relation (issues/120)
        ...LINKED_POPULATE,
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
        // Populating a component does NOT populate the relations inside it, so
        // the `year` and `contact` need naming explicitly. Without them the
        // component came back with its amounts but no `year` key at all, and
        // ProjectGrantableYears' <b-select> had nothing to match its options
        // against — the "Imports per any" dropdown rendered blank.
        'grantable_years.year',
        'grantable_contacts.contact',
        ]),
      });

    if (data) {
      sortPhasesByPosition(data.project_phases);
      sortPhasesByPosition(data.project_original_phases);
    }

    // Calculate fresh totals to ensure consistency with calculate endpoint
    // This ensures reports and lists get accurate totals from find/findOne methods
    if (data && data.id) {
      const calculatedData = await doProjectInfoCalculations(data, id);
      delete calculatedData.activities;
      // `_phases=false`: the caller loads the phases from their own endpoints
      // (ProjectForm does, and replaces these with them), so don't send a
      // second copy — 380 of the 485 KB of a large project (issues/016). They
      // are still loaded above: the totals are computed from them.
      if (ctx.query && String(ctx.query._phases) === 'false') {
        delete calculatedData.project_phases;
        delete calculatedData.project_original_phases;
      }
      // Mother projects: aggregate child totals (v3 afterFindOne port, P5.3).
      if (calculatedData.is_mother) {
        await calculateMotherProjectTotals(calculatedData);
      }
      return mergeLinkedDocuments(calculatedData);
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
        // Populating a component does NOT populate the relations inside it, so
        // the `year` and `contact` need naming explicitly. Without them the
        // component came back with its amounts but no `year` key at all, and
        // ProjectGrantableYears' <b-select> had nothing to match its options
        // against — the "Imports per any" dropdown rendered blank.
        'grantable_years.year',
        'grantable_contacts.contact',
        ]),
      });

    if (data) {
      sortPhasesByPosition(data.project_phases);
      sortPhasesByPosition(data.project_original_phases);
    }
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
        incomeData.total_amount = lineTotal(incomeData);

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
        expense.total_amount = lineTotal(expense);

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

    // the phases keep the order the form sends them in, as their lines do
    const movedPhases = assignLinePositions(phases);
    await saveLinePositions(PHASE_ENTITY_UIDS[entity], movedPhases);

    for await (const phase of phases) {
      const { incomes, expenses, ...item } = phase;
      if (!phase.id) {
        const resp = await strapi.db
          .query(PHASE_ENTITY_UIDS[entity])
          .create({ data: { project: id, name: item.name, position: phase.position } });
        phase.id = resp.id;
      } else if (phase.dirty) {
        await strapi.db
          .query(PHASE_ENTITY_UIDS[entity])
          .update({ where: { id: phase.id }, data: { project: id, name: item.name, position: phase.position } });
      }

      if (incomes) {
        const movedIncomes = assignLinePositions(incomes);
        for await (const income of incomes) {
          income.total_amount = lineTotal(income);

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
        await saveLinePositions('api::phase-income.phase-income', movedIncomes);
      }

      if (expenses) {
        const movedExpenses = assignLinePositions(expenses);
        for await (const expense of expenses) {
          expense.total_amount = lineTotal(expense);

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
        await saveLinePositions('api::phase-expense.phase-expense', movedExpenses);
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
      .findMany({ where: liveChildrenWhere(motherProject.id) });
    addChildrenTotals(motherProject, children);
  } catch (error) {
    console.error(`Error calculating mother project totals for project ${motherProject.id}:`, error);
  }
}
