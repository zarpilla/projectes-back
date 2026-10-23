'use strict';

/**
 * Which app permissions may call each API action (issues/099).
 *
 * The app permissions (`projects`, `hours`, `admin`, `orders`, `orders_admin`,
 * `orders_delivery`) used to be applied by the front end only: every logged-in
 * user could call the whole API directly. `middlewares/app-permissions.js`
 * checks every content-API request against this table.
 *
 * - `projects` and `admin` keep access to everything (FULL_ACCESS): they are
 *   the entity's own staff and the screens they use reach almost every route.
 *   What was admin-only before (isAdmin policy, user writes) still is.
 * - Every other user reaches only the actions listed here for one of her
 *   permissions. An action that is not listed is refused (403).
 *
 * The lists come from the calls the front end's screens make for each
 * permission (menu entries of src/service/menu.js and the screens they open,
 * plus the calls made on every page after login). Keep them in step with the
 * front: a screen that starts calling a new endpoint needs it added here.
 *
 * Owner scoping for members with only `orders` (external organisations) is
 * applied on top of this table by the middleware (ORDER_SCOPED below).
 */

const FULL_ACCESS = ['projects', 'admin'];

const ORDERS = 'orders';
const ORDERS_ADMIN = 'orders_admin';
const ORDERS_DELIVERY = 'orders_delivery';
const HOURS = 'hours';

// any logged-in user, even one with no app permission
const ANY = '*';
const LOGISTICS = [ORDERS, ORDERS_ADMIN, ORDERS_DELIVERY];
const STAFF = [ORDERS_ADMIN, ORDERS_DELIVERY];
const EVERYONE = [...LOGISTICS, HOURS];

const READ = ['find', 'findOne'];
const WRITE = ['create', 'update', 'delete'];

const rules = {};

function allow(uid, actions, permissions) {
  const list = Array.isArray(permissions) ? permissions : [permissions];
  for (const action of actions) {
    const key = `${uid}.${action}`;
    rules[key] = [...new Set([...(rules[key] || []), ...list])];
  }
}

const api = (name) => `api::${name}.${name}`;

// --- every user -------------------------------------------------------------
// The app reads the user, the entity's name and logo, and the tickets login
// (changelog, reachable from the profile) whatever the permissions, and keeps
// their own Inici (GET/PUT /users/me/home).
allow('plugin::users-permissions.user', ['me', 'home', 'updateHome'], ANY);
allow(api('me'), ['find', 'ticketsLogin', 'docsLogin'], ANY);
allow(api('logo'), READ, ANY);

// Catalogs read by the logistics and hours screens, and by the landing page
// every user goes through after login (Home.vue).
for (const name of [
  'project-state',
  'project-type',
  'project-scope',
  'project-likelihood',
  'task-state',
  'year',
  'month',
  'dedication-type',
  'activity-type',
  'festive-type',
  'festive',
  'document-type',
  'legal-form',
  'sector',
  'contact-type',
  'city',
  'vat-type',
  'payment-method',
  'income-type',
  'expense-type',
  'region',
]) {
  allow(api(name), READ, EVERYONE);
}
allow(api('activity-type'), ['getBasic'], EVERYONE);
// The logistics catalogs, for the logistics screens only: no hours screen
// reads routes, tariffs, pickups or products (issues/188).
for (const name of ['route', 'pickup', 'delivery-type', 'route-rate', 'route-pickup-notice', 'product', 'city-route', 'route-festive']) {
  allow(api(name), READ, LOGISTICS);
}
allow(api('city-route'), ['basic'], LOGISTICS);
// the CP of each town, for the delivery point form (issues/182)
allow(api('city'), ['postcodes'], EVERYONE);
// Person pickers and owner columns on the hours and logistics screens.
allow('plugin::users-permissions.user', ['find', 'findOne', 'count'], EVERYONE);
// Project pickers (hours), the landing page and the member's «Factures» filter.
allow(api('project'), ['findWithBasicInfo'], EVERYONE);
// «Dedicació» pivot (hours), delivery points and the CSV import (logistics).
allow(api('contact'), ['basic'], EVERYONE);

// --- hours (workers): Hores dedicades, Registre jornades, Dedicació ------------
// Only her own rows (middleware OWN_SCOPES): the «Persona» picker of these
// screens is of no use to a worker, by decision (issues/099). Her daily
// dedications come without the salary fields.
allow(api('activity'), [...READ, ...WRITE, 'getForCalendar', 'importCalendar', 'move'], HOURS);
allow(api('time-counter'), [...READ, ...WRITE], HOURS);
allow(api('workday-log'), [...READ, ...WRITE], HOURS);
allow(api('daily-dedication'), READ, HOURS);
allow(api('festive'), WRITE, HOURS);
allow(api('task'), READ, HOURS);
allow(api('project'), ['findWithPhasesBoth'], HOURS);
// Saved pivot views: only the ones of her screens (middleware, issues/166).
allow(api('pivot-table-view'), [...READ, ...WRITE], [HOURS, ORDERS_ADMIN]);
const PIVOT_IDENTIFIERS = {
  [HOURS]: ['dedication-pivot', 'dedication-est-pivot'],
  [ORDERS_ADMIN]: ['orders-pivot', 'incidences-pivot'],
};

// --- logistics ----------------------------------------------------------------
allow(
  api('order'),
  [
    ...READ,
    'create',
    'update',
    'table',
    'totals',
    'tableCount',
    'tableStatusCounts',
    'checkMultidelivery',
    'collectionPointRoutes',
    'createCSV',
    'pdfmultiple',
  ],
  LOGISTICS,
);
allow(api('order'), ['infoAll', 'invoice', 'forInvoicing'], ORDERS_ADMIN);
// The order form's «Historial» (issues/119): the logistics staff, not members
// (it names who made each change).
allow(api('order'), ['history'], STAFF);
allow(api('orders-import'), ['create'], LOGISTICS);
allow('plugin::upload.content-api', ['upload'], LOGISTICS);
allow(api('incidence'), [...READ, 'update', 'delete'], LOGISTICS);
allow(api('incidence'), ['infoAll'], ORDERS_ADMIN);
allow(api('contact'), [...READ, 'create', 'update', 'forOrders', 'withorders'], LOGISTICS);
// The drivers keep these (issues/163): «Punts d'entrega» lets them unify and
// delete points, and «Poblacions i rutes» / «Rutes i dies» let them add towns,
// link them to routes and close routes (canEdit there is orders_admin or
// orders_delivery), even if those two are not in their menu.
allow(api('contact'), ['delete', 'orders', 'unify'], STAFF);
allow(api('city'), ['create'], STAFF);
allow(api('city-route'), WRITE, STAFF);
allow(api('route-festive'), WRITE, STAFF);
// «Rutes i punts › Rutes» (issues/141): the office creates and disables routes
allow(api('route'), ['create', 'update'], ORDERS_ADMIN);
// «Taules auxiliars › Logística» (issues/159): the office keeps the pickup
// points, the delivery types and the towns (a town in use can't be deleted:
// api/city lifecycles)
allow(api('pickup'), WRITE, ORDERS_ADMIN);
allow(api('delivery-type'), WRITE, ORDERS_ADMIN);
allow(api('city'), ['update', 'delete'], ORDERS_ADMIN);
// …and the route rates, and opens those tables in the app (only those: the
// metadata controller narrows the list for her)
allow(api('route-rate'), WRITE, ORDERS_ADMIN);
// the deposit notices per route and warehouse (issues/313)
allow(api('route-pickup-notice'), WRITE, ORDERS_ADMIN);
allow(api('entity-metadata'), ['adminEntities'], ORDERS_ADMIN);
// «Facturar comandes»: the project's last invoices; the contact form's DIR3 search
allow(api('emitted-invoice'), ['find'], ORDERS_ADMIN);
allow(api('me'), ['dir3SearchNif', 'dir3SearchName'], ORDERS_ADMIN);
// The member's «Factures» (invoices to her as provider) and «Contacta».
allow(api('emitted-invoice'), ['findBasic', 'pendingProvider'], ORDERS);
allow(api('received-income'), ['findBasic'], ORDERS);
allow(api('phase-income'), ['findAssigned'], ORDERS);
allow(api('form-submission'), ['create'], ORDERS);

/**
 * The permissions that may call `action` (`api::order.order.find`,
 * `plugin::users-permissions.user.me`), or undefined when none but FULL_ACCESS.
 * The users-permissions `auth` routes (login, refresh, logout, password) are
 * left to the plugin.
 */
function allowedPermissions(action) {
  if (action.startsWith('plugin::users-permissions.auth.')) return [ANY];
  return rules[action];
}

function isAllowed(action, permissions) {
  if (permissions.some((p) => FULL_ACCESS.includes(p))) return true;
  const allowed = allowedPermissions(action);
  if (!allowed) return false;
  return allowed.includes(ANY) || permissions.some((p) => allowed.includes(p));
}

/**
 * A member: `orders` without FULL_ACCESS nor the logistics staff permissions.
 * Her orders, incidences, contacts and invoices are limited to her own.
 */
function isOrdersMember(permissions) {
  return (
    permissions.includes(ORDERS) && !permissions.some((p) => FULL_ACCESS.includes(p) || STAFF.includes(p))
  );
}

/**
 * A driver: `orders_delivery` without FULL_ACCESS nor the office. She makes the
 * moves of the orders, not the orders (issues/163).
 */
function isDriver(permissions) {
  return (
    permissions.includes(ORDERS_DELIVERY) &&
    !permissions.some((p) => FULL_ACCESS.includes(p) || p === ORDERS_ADMIN)
  );
}

/** The pivot identifiers of the screens the permissions open (issues/166). */
function pivotIdentifiersFor(permissions) {
  return [...new Set(permissions.flatMap((p) => PIVOT_IDENTIFIERS[p] || []))];
}

module.exports = {
  FULL_ACCESS,
  LOGISTICS,
  ANY,
  rules,
  allowedPermissions,
  isAllowed,
  isOrdersMember,
  isDriver,
  pivotIdentifiersFor,
};
