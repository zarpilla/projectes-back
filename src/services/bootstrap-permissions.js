'use strict';
/* global strapi */
const { getMe } = require('./me-settings');

/**
 * Permission matrix + seed rows (P6.1 + P6.3). Ported from the v3
 * config/functions/bootstrap.js importSeedData() — the authoritative
 * public/authenticated permission list.
 *
 * v5 differences:
 *  - Permission rows have NO `enabled` column: a row EXISTS = granted.
 *    So setPermissions() creates the rows the matrix wants (idempotent).
 *  - v3 controller names were lowercased in the matrix ("findone",
 *    "createcsv"); v5 action names are the real handler names ("findOne",
 *    "createCSV"). Matching is case-insensitive against the plugin's
 *    registered actions (getActions()).
 *  - v3 API slugs were sometimes plural ("orders"); v5 API names are the
 *    singular folders ("order"). The lookup normalizes both.
 */

// v3 controller slug -> v5 API name (only where they differ).
const API_NAME_MAP = {
  contacts: 'contact',
  orders: 'order',
  regions: 'region',
  incidences: 'incidence',
  pickups: 'pickup',
  justifications: 'justification',
  'bank-accounts': 'bank-account',
  'orders-imports': 'orders-import',
  'project-phases': 'project-phase',
  'project-original-phases': 'project-original-phase',
  'estimated-hours': 'estimated-hour',
  logos: 'logo',
};

/**
 * Grants the listed controller actions to a role (type: 'public'|'authenticated').
 * Uses the plugin's official updateRole() (the admin Roles-UI mechanism), which
 * diffs old vs new actions and syncs the permission rows correctly.
 *
 * @param {string} roleType
 * @param {Record<string,string[]>} controllers controller slug -> action names
 */
async function setPermissions(roleType, controllers) {
  const up = strapi.service('plugin::users-permissions.users-permissions');
  const roleService = strapi.service('plugin::users-permissions.role');

  const role = await strapi.query('plugin::users-permissions.role').findOne({ where: { type: roleType } });
  if (!role) {
    strapi.log.warn(`[bootstrap-permissions] role "${roleType}" not found — skipping`);
    return;
  }

  // All registered actions, keyed case-insensitively by "<controller>.<action>".
  // getActions() sections are ALREADY prefixed: 'api::<apiName>' or 'plugin::<pluginName>'.
  const registered = await up.getActions();
  // lookup: lowercased "controller.action" -> { typeName, controllerName, actionName }
  const lookup = new Map();
  for (const [typeName, content] of Object.entries(registered || {})) {
    const ctls = content?.controllers || {};
    for (const [controllerName, actions] of Object.entries(ctls)) {
      for (const actionName of Object.keys(actions)) {
        lookup.set(`${controllerName}.${actionName}`.toLowerCase(), {
          typeName,
          controllerName,
          actionName,
        });
      }
    }
  }

  // Build the nested updateRole payload:
  // { '<typeName>': { controllers: { '<controller>': { '<action>': { enabled: true } } } } }
  const permissionsPayload = {};
  let granted = 0;
  const unmatched = [];
  for (const [v3Controller, actions] of Object.entries(controllers)) {
    const apiName = API_NAME_MAP[v3Controller] || v3Controller;
    for (const v3Action of actions) {
      const hit = lookup.get(`${apiName}.${v3Action}`.toLowerCase());
      if (!hit) {
        unmatched.push(`${apiName}.${v3Action}`);
        continue;
      }
      permissionsPayload[hit.typeName] = permissionsPayload[hit.typeName] || {
        controllers: {},
      };
      const ctl =
        permissionsPayload[hit.typeName].controllers[hit.controllerName] ||
        (permissionsPayload[hit.typeName].controllers[hit.controllerName] = {});
      ctl[hit.actionName] = { enabled: true };
      granted++;
    }
  }

  await roleService.updateRole(role.id, { permissions: permissionsPayload });

  if (unmatched.length) {
    strapi.log.warn(
      `[bootstrap-permissions] ${roleType}: ${unmatched.length} unmatched actions: ${unmatched.join(', ')}`,
    );
  }
  strapi.log.info(`[bootstrap-permissions] ${roleType}: granted ${granted} permissions`);
}

/** The full public/authenticated matrix (ported verbatim from v3 importSeedData). */
async function importSeedPermissions() {
  // updateRole() REPLACES a role's permission set, so the users-permissions
  // actions Strapi grants Public by default are wiped unless they are listed
  // here — without them POST /api/auth/local answers 403 and nobody can log in.
  // Same six the v3 public role had (v3 `users-permissions_permission`, role 2).
  await setPermissions('public', {
    logos: ['find'],
    auth: ['callback', 'connect', 'forgotPassword', 'resetPassword'],
    user: ['me'],
  });

  await setPermissions('authenticated', {
    // Present in the v3 authenticated role but missing from this matrix until
    // P9 smoke-tested every screen: without them /api/months, /api/tickets,
    // /api/time-counters, /api/diets, the grant endpoints and the config and
    // home-menu single types all answer 403 to a logged-in user.
    // (v3's `<type>.count` actions have no v5 equivalent — the frontend's
    // `/count` calls are served from the list endpoint's meta.pagination.total.)
    config: ['find'],
    diet: ['find', 'findOne'],
    'emitted-grant': ['find', 'findOne'],
    'home-menu': ['find'],
    month: ['find'],
    'received-grant': ['find', 'findOne'],
    ticket: ['find', 'findOne'],
    'time-counter': ['create', 'find', 'findOne', 'update', 'delete'],
    activity: [
      'create',
      'find',
      'update',
      'delete',
      'importCalendar',
      'move',
      'totalByDay',
      'getForCalendar',
    ],
    'activity-type': ['create', 'find', 'getBasic'],
    'emitted-invoice': [
      'create',
      'find',
      'findBasic',
      'findOne',
      'update',
      'delete',
      'payVat',
      'payVatIds',
      'pdf',
      'sendInvoiceByEmail',
      'pendingProvider',
    ],
    'received-invoice': ['create', 'find', 'findBasic', 'findOne', 'update', 'delete', 'upload'],
    'received-income': ['create', 'find', 'findBasic', 'findOne', 'update', 'delete'],
    'received-expense': ['create', 'find', 'findBasic', 'findOne', 'update', 'delete', 'upload'],
    payroll: ['create', 'find', 'findOne', 'update', 'delete', 'createAll'],
    project: [
      'create',
      'find',
      'findOne',
      'update',
      'delete',
      'findWithBasicInfo',
      'findEstimatedTotalsByDay',
      'findNames',
      'findWithPhases',
      'findWithPhasesBoth',
      'payExpense',
      'payIncome',
      'findWithEconomicDetail',
      'findChildren',
      'calculateProject2',
      'findOneExtended',
      'findDedications',
      'findRealDedications',
      'verifyStoredTotals',
      'refreshStoredTotals',
      'reset',
      'updatePhases',
      'createPhasesForAllProjects',
    ],
    quote: ['create', 'find', 'findOne', 'update', 'delete'],
    contacts: ['create', 'find', 'findOne', 'update', 'delete', 'basic', 'withorders', 'orders', 'unify'],
    'festive-type': ['find'],
    festive: ['create', 'find', 'findOne', 'update', 'delete'],
    'daily-dedication': ['create', 'find', 'findOne', 'update', 'delete'],
    'document-type': ['find', 'findOne'],
    regions: ['find', 'findOne'],
    task: ['create', 'find', 'findOne', 'update', 'delete'],
    'task-state': ['find', 'findOne'],
    treasury: ['create', 'find', 'forecast', 'findOne', 'update', 'delete'],
    'treasury-validation': ['toggle', 'find', 'findByKey', 'delete'],
    'kanban-view': ['create', 'find', 'findOne', 'update', 'delete'],
    justifications: ['create', 'find', 'findOne', 'update', 'delete'],
    'workday-log': ['create', 'find', 'findOne', 'update', 'delete'],
    product: ['find', 'findOne'],
    'user-festive': ['find', 'create', 'findOne', 'update', 'delete'],
    orders: [
      'create',
      'find',
      'findOne',
      'update',
      'delete',
      'createCSV',
      'invoice',
      'infoAll',
      'pdfmultiple',
      'checkMultidelivery',
      'collectionPointRoutes',
      'table',
    ],
    'orders-imports': ['create', 'find', 'findOne', 'update'],
    'delivery-type': ['find'],
    pickups: ['find'],
    route: ['find'],
    'route-rate': ['find'],
    city: ['find', 'findOne', 'create'],
    'city-route': ['find', 'findOne', 'create', 'delete'],
    'form-submission': ['create'],
    'route-festive': ['find', 'findOne', 'create', 'delete'],
    'project-phases': ['find', 'findOne', 'create', 'update', 'delete'],
    'project-original-phases': ['find', 'findOne', 'create', 'update', 'delete', 'findWithHours'],
    'estimated-hours': ['find', 'findOne', 'create', 'update', 'delete'],
    'phase-income': ['find', 'findAssigned'],
    'phase-expense': ['find', 'findAssigned'],
    verifactu: ['find'], // single-type: no findOne route in v5
    'verifactu-declaration': ['find', 'findOne', 'create'],
    'verifactu-chain': ['find', 'findOne', 'create', 'update', 'delete'],
    'face-queue': ['find', 'findOne', 'create', 'update', 'delete', 'checkStatus', 'verifySetup'],
    'pivot-table-view': ['find', 'findOne', 'create', 'update', 'delete'],
    'bank-accounts': ['find', 'findOne', 'create', 'update', 'delete'],
    incidences: ['create', 'find', 'findOne', 'update', 'delete', 'infoAll'],
    'vat-type': ['find'],
    'contact-type': ['create', 'find', 'findOne', 'update', 'delete'],
    'dedication-type': ['create', 'find', 'findOne', 'update', 'delete'],
    'expense-type': ['create', 'find', 'findOne', 'update', 'delete'],
    'income-type': ['create', 'find', 'findOne', 'update', 'delete'],
    'legal-form': ['create', 'find', 'findOne', 'update', 'delete'],
    'payment-method': ['create', 'find', 'findOne', 'update', 'delete'],
    'project-state': ['create', 'find', 'findOne', 'update', 'delete'],
    'project-likelihood': ['create', 'find', 'findOne', 'update', 'delete'],
    'project-type': ['create', 'find', 'findOne', 'update', 'delete'],
    'project-scope': ['create', 'find', 'findOne', 'update', 'delete'],
    sector: ['create', 'find', 'findOne', 'update', 'delete'],
    serie: ['create', 'find', 'findOne', 'update', 'delete'],
    'social-entity': ['create', 'find', 'findOne', 'update', 'delete'],
    strategy: ['create', 'find', 'findOne', 'update', 'delete'],
    year: ['create', 'find', 'findOne', 'update', 'delete'],
    'entity-metadata': ['adminEntities'],
    me: ['find', 'update', 'dir3SearchNif', 'dir3SearchName'],
    // users-permissions plugin actions for authenticated users
    // (merged into the SAME call because updateRole REPLACES the role's set)
    user: ['find', 'findOne', 'create', 'update', 'count', 'me'],
    // v3 "userspermissions: getroles" -> the roles read action
    role: ['find'],
  });
}

/** Seed rows (P6.3): verifactu settings, declarations, default bank account. */
async function importSeedRows() {
  const me = await getMe();

  // Verifactu settings single-type
  const verifactu = await strapi.documents('api::verifactu.verifactu').findFirst();
  if (!verifactu) {
    await strapi.db.query('api::verifactu.verifactu').create({
      data: {
        mode: 'no',
        software_developerName: '',
        software_developerIrsId: '',
        software_name: 'ESSTRAPIS',
        software_version: '2025.11.18',
        software_id: '01',
        software_number: me?.nif || '',
        software_useOnlyVerifactu: true,
        software_useMulti: true,
        software_useCurrentMulti: false,
        software_address: '',
        software_date: '18 de noviembre de 2025',
        software_location: '-',
        publishedAt: new Date(),
      },
    });
  } else if (verifactu.software_version !== '2025.11.18') {
    await strapi.db.query('api::verifactu.verifactu').update({
      where: { id: verifactu.id },
      data: { software_version: '2025.11.18', software_date: '18 de noviembre de 2025' },
    });
  }

  // Verifactu declarations (versioned rows)
  const declarationVersions = ['2025.06.28', '2025.08.02', '2025.11.18'];
  for (const version of declarationVersions) {
    const existing = await strapi.db
      .query('api::verifactu-declaration.verifactu-declaration')
      .findOne({ where: { version } });
    if (!existing) {
      await strapi.db.query('api::verifactu-declaration.verifactu-declaration').create({
        data: {
          version,
          url: 'https://github.com/zarpilla/projectes/tree/master/public/verifactu',
          publishedAt: new Date(),
        },
      });
    }
  }

  // Default bank account (only when none exist) + wire it into me
  const bankAccounts = await strapi.db.query('api::bank-account.bank-account').findMany({ limit: 1 });
  if (bankAccounts.length === 0) {
    const account = await strapi.db.query('api::bank-account.bank-account').create({
      data: { name: '-', publishedAt: new Date() },
    });
    if (me) {
      await strapi.db.query('api::me.me').update({
        where: { id: me.id },
        data: {
          bank_account_payroll: account.id,
          bank_account_ss: account.id,
          bank_account_irpf: account.id,
          bank_account_default: account.id,
          bank_account_vat: account.id,
        },
      });
    }
  }
}

module.exports = { importSeedPermissions, importSeedRows, setPermissions };
