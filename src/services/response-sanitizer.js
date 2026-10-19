'use strict';

/**
 * What users without full access never get in an API response, wherever it
 * comes from (issues/165).
 *
 * The app permissions (issues/099) allow or refuse an action, but an allowed
 * action could still `populate` its way to data the role must not see:
 * `/users?populate=daily_dedications` gave a worker everyone's salary,
 * `/tasks?populate[project][populate]=*` the projects' finances and invoices.
 * The response is walked along the content-type schema (relations and
 * components lead to their own type), so a field is dropped by the type it
 * belongs to, however deep the populate went, and a field with the same name
 * on another type (`balance` of a treasury, `email` of a contact) is left
 * alone.
 *
 * A rule is `{ drop: [...] }` (fields removed), `{ keep: [...] }` (only
 * those kept) or `{ pick: (row, nested) => rule }` (the rule of that row: the user's
 * own row keeps her calendar and identity, which «Hores dedicades» and
 * «Registre jornades» read from the people list). `nestedOnly` rules leave the root of the response alone: a
 * member's «Factures» reads her own income lines (phase-income.findAssigned)
 * with their amounts, while the same lines reached through a project are the
 * project's finances.
 */

const USER = 'plugin::users-permissions.user';
// who reads emitted invoices (app-access-rules: the office, and a member her own)
const INVOICE_READERS = ['projects', 'admin', 'orders_admin', 'orders'];
const PROJECT = 'api::project.project';

// the salary and the identity of a person
const USER_PRIVATE = [
  'ical',
  'identity_number',
  'naf',
  'cost_by_hour',
  'monthly_salary',
  'monthly_tax',
  'daily_dedications',
];

// what her own row leaves out (issues/099: her working periods come without them too)
const SALARY = ['cost_by_hour', 'monthly_salary', 'monthly_tax'];

// Left out of the daily dedications: what the hours screens need is the
// period and its hours per day.
const DEDICATION_SALARY_FIELDS = [
  'costByHour',
  'monthly_salary',
  'scheme',
  'quota',
  'pct_irpf',
  'pct_other',
  'pct_quota',
];

// A project's money, internal notes and the documents that carry amounts.
// The hours (total_*_hours) stay: they are what the hours screens show.
const PROJECT_FINANCES = [
  'total_expenses',
  'total_incomes',
  'total_expenses_hours',
  'balance',
  'total_estimated_expenses',
  'estimated_balance',
  'incomes_expenses',
  'total_original_incomes',
  'total_original_expenses',
  'total_original_hours_price',
  'total_original_expenses_vat',
  'original_incomes_expenses',
  'total_estimated_incomes',
  'total_estimated_expenses_vat',
  'estimated_incomes_expenses',
  'invoice_hours_price',
  'total_real_incomes',
  'total_real_expenses',
  'total_real_incomes_expenses',
  'structural_expenses_pct',
  'total_estimated_hours_price',
  'total_real_hours_price',
  'grantable_amount',
  'grantable_amount_total',
  'grantable_cofinancing_pct',
  'grantable_estructural_pct',
  'grantable_cofinancing',
  'total_expenses_vat',
  'total_real_expenses_vat',
  'grantable_structural_expenses',
  'grantable_structural_expenses_justify_invoices',
  'internal_notes',
  'emitted_invoices',
  'received_invoices',
  'received_incomes',
  'received_expenses',
  'linked_emitted_invoices',
  'linked_received_expenses',
  'linked_received_incomes',
  'linked_received_invoices',
  'tickets',
  'diets',
  'emitted_grants',
  'received_grants',
  'quotes',
  'treasury_annotations',
  // the project's files (contracts, budgets…): the media entries carry their
  // URL, and /uploads is public (issues/220)
  'documents',
];

// What a project reached through another type (a route's, a task's, an
// activity type's project) leaves out: everyone's hours, the budget lines with
// their incomes (concepts naming members) and the grant data. The project
// screens that need them read the project itself (issues/188).
const NESTED_PROJECT_DATA = [
  'activities',
  'project_phases',
  'project_original_phases',
  'periodification',
  'grantable_years',
  'grantable_contacts',
];

// The amounts of a budget line and of its planned hours (the hours stay)
const LINE_AMOUNTS = ['amount', 'total_amount', 'bank_account', 'invoice', 'income', 'vat_pct'];

/**
 * The rules for a user without full access: `member` for `orders` only,
 * `selfId` the user's own id.
 */
function rulesFor({ member = false, selfId = null, permissions = [] } = {}) {
  const others = member ? { keep: ['id', 'documentId', 'username', 'fullname'] } : { drop: USER_PRIVATE };
  const rules = {
    [USER]: { pick: (row) => (selfId !== null && row.id === selfId ? { drop: SALARY } : others) },
    'api::daily-dedication.daily-dedication': { drop: DEDICATION_SALARY_FIELDS },
    'api::activity.activity': { drop: ['cost_by_hour', 'invoice_hours_price'] },
    // the comments of a task: only the full-access users read them
    // (`/task-comments` is theirs), `populate[task_comments]` gave them to a worker (issues/220)
    'api::task.task': { drop: ['task_comments'] },
    [PROJECT]: {
      pick: (row, nested) => ({ drop: nested ? [...PROJECT_FINANCES, ...NESTED_PROJECT_DATA] : PROJECT_FINANCES }),
    },
    'api::phase-income.phase-income': { drop: LINE_AMOUNTS, nestedOnly: true },
    'api::phase-expense.phase-expense': { drop: LINE_AMOUNTS, nestedOnly: true },
    'api::estimated-hour.estimated-hour': { drop: LINE_AMOUNTS, nestedOnly: true },
    'budget-line.budget-line': { drop: LINE_AMOUNTS, nestedOnly: true },
    'budget-line.simple-income': { drop: LINE_AMOUNTS, nestedOnly: true },
    'budget-line.simple-expense': { drop: LINE_AMOUNTS, nestedOnly: true },
    'expense.expense': { drop: LINE_AMOUNTS, nestedOnly: true },
    'hours.hours': { drop: LINE_AMOUNTS, nestedOnly: true },
  };
  // an order's invoice, for whoever can't read the invoices (drivers, workers):
  // `incidences?populate[order][populate][emitted_invoice]` gave a driver the
  // whole invoice (issues/188)
  if (!permissions.some((p) => INVOICE_READERS.includes(p))) {
    rules['api::order.order'] = { drop: ['emitted_invoice'] };
  }
  if (member) {
    // the office's data on a contact
    rules['api::contact.contact'] = {
      drop: ['partner_amount', 'partner_amount_date', 'followup_date', 'projects', 'projectes'],
    };
  }
  return rules;
}

function modelOf(strapi, uid) {
  return (
    (strapi.contentTypes && strapi.contentTypes[uid]) || (strapi.components && strapi.components[uid]) || null
  );
}

function applyRule(row, rule, nested) {
  if (rule.pick) {
    applyRule(row, rule.pick(row, nested), nested);
  } else if (rule.keep) {
    for (const key of Object.keys(row)) if (!rule.keep.includes(key)) delete row[key];
  } else {
    for (const key of rule.drop) delete row[key];
  }
}

function walk(strapi, uid, value, rules, nested) {
  if (Array.isArray(value)) {
    for (const item of value) walk(strapi, uid, item, rules, nested);
    return;
  }
  if (!value || typeof value !== 'object') return;
  // v4-style `{ data: … }` around a relation
  if (
    'data' in value &&
    Object.keys(value).length <= 2 &&
    (value.data === null || typeof value.data === 'object')
  ) {
    walk(strapi, uid, value.data, rules, nested);
    return;
  }
  const row = value.attributes && typeof value.attributes === 'object' ? value.attributes : value;
  const rule = rules[uid];
  if (rule && (nested || !rule.nestedOnly)) applyRule(row, rule, nested);

  const model = modelOf(strapi, uid);
  if (!model || !model.attributes) return;
  for (const [key, child] of Object.entries(row)) {
    if (!child || typeof child !== 'object') continue;
    const attribute = model.attributes[key];
    if (!attribute) continue;
    if (attribute.type === 'relation' && attribute.target) {
      walk(strapi, attribute.target, child, rules, true);
    } else if (attribute.type === 'component' && attribute.component) {
      walk(strapi, attribute.component, child, rules, true);
    } else if (attribute.type === 'dynamiczone') {
      for (const item of Array.isArray(child) ? child : []) {
        if (item && item.__component) walk(strapi, item.__component, item, rules, true);
      }
    }
  }
}

/**
 * Drops from `body` (a response of an action on `uid`) what the rules keep
 * from the user. Plain arrays, `{ data, meta }` and single rows are walked.
 */
function sanitizeResponse(strapi, uid, body, rules) {
  if (!uid || !body || typeof body !== 'object') return;
  // a PDF or a file
  if (Buffer.isBuffer(body) || typeof body.pipe === 'function') return;
  const data = !Array.isArray(body) && 'data' in body ? body.data : body;
  walk(strapi, uid, data, rules, false);
}

/** `api::task.task` for `api::task.task.find`, the user for its plugin's actions. */
function modelUidOfAction(action) {
  if (!action) return null;
  if (action.startsWith('plugin::users-permissions.user.')) return USER;
  const match = /^(api::[^.]+\.[^.]+)\./.exec(action);
  return match ? match[1] : null;
}

module.exports = {
  rulesFor,
  sanitizeResponse,
  modelUidOfAction,
  DEDICATION_SALARY_FIELDS,
  USER_PRIVATE,
  PROJECT_FINANCES,
};
