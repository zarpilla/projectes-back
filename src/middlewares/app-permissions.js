'use strict';

/**
 * Enforces the app permissions on every content-API route (issues/099).
 *
 * Until now the permissions were applied by the front end only (menu entries,
 * screens, "only my orders" filters): any logged-in user could call the API
 * directly and read or change almost everything, including payrolls, salaries,
 * invoices and other members' orders. Attached to every content-API route by
 * `registerAppPermissions` (src/index.js), after Strapi's role check and the
 * route policies, so `ctx.state.user` and `ctx.state.route` are known.
 *
 * 1. The action must be allowed for one of the user's app permissions
 *    (services/app-access-rules.js); `projects` and `admin` reach everything.
 * 2. Without full access, `GET /api/me` leaves out the bank accounts and the
 *    entity's certificates.
 * 3. A member (`orders` only) is limited to her own orders: the ones she owns,
 *    plus the ones delivered to her own contact (her pickup point), on which
 *    she can only mark what was picked up. The only state change she makes is
 *    cancelling a pending order of hers. Incidences follow their order, and
 *    her invoices are the ones addressed to her contact. She can't give an
 *    order or a contact to someone else, and only changes contacts she can see
 *    on «Punts d'entrega».
 * 4. A worker (`hours`, without full access) reads and changes only her own
 *    hours, time counters, workday logs and personal holidays, and reads her
 *    own working periods (daily dedications) without the salary fields.
 *
 * Public routes (no user) are left to the Public role.
 */
const { errors } = require('@strapi/utils');
const { isAllowed, isOrdersMember, FULL_ACCESS } = require('../services/app-access-rules');

const ORDER = 'api::order.order';
const CONTACT = 'api::contact.contact';
const INCIDENCE = 'api::incidence.incidence';
const USER = 'plugin::users-permissions.user';
const ACTIVITY = 'api::activity.activity';
const TIME_COUNTER = 'api::time-counter.time-counter';
const WORKDAY_LOG = 'api::workday-log.workday-log';
const DAILY_DEDICATION = 'api::daily-dedication.daily-dedication';
const FESTIVE = 'api::festive.festive';

// What a member may change on an order delivered to her contact but owned by
// another member (PickupPoints: the boxes she picked up; incidences modal).
const PICKUP_POINT_FIELDS = new Set(['lines', 'picked_up', 'incidences', '_tracking_user']);

// Left out of `GET /api/me` for users without full access.
const ME_PRIVATE_FIELDS = [
  'bank_account_payroll',
  'bank_account_ss',
  'bank_account_irpf',
  'bank_account_default',
  'bank_account_vat',
  'google_credentials',
  'face_certificate',
];

// Left out of the daily dedications for users without full access: what the
// hours screens need is the period and its hours per day.
const DEDICATION_SALARY_FIELDS = [
  'costByHour',
  'monthly_salary',
  'scheme',
  'quota',
  'pct_irpf',
  'pct_other',
  'pct_quota',
];

const forbidden = () => new errors.ForbiddenError('No tens permís per fer aquesta acció');

/** `api::order.order.table`, `plugin::users-permissions.user.me`, … */
function actionOf(route) {
  if (!route || typeof route.handler !== 'string') return null;
  const { handler, info = {} } = route;
  if (handler.startsWith('api::') || handler.startsWith('plugin::')) return handler;
  if (info.apiName) return `api::${info.apiName}.${handler}`;
  if (info.pluginName) return `plugin::${info.pluginName}.${handler}`;
  return null;
}

async function appPermissionsOf(strapi, userId) {
  const user = await strapi.db
    .query(USER)
    .findOne({ where: { id: userId }, populate: { permissions: true } });
  return ((user && user.permissions) || []).map((p) => p && p.permission).filter(Boolean);
}

const idOf = (value) => (value && typeof value === 'object' ? value.id : value);

/** The ids of the member's own contacts (the contact linked to her user). */
async function memberContactIds(strapi, userId) {
  const contacts = await strapi.db.query(CONTACT).findMany({
    where: { users_permissions_user: { id: userId } },
    select: ['id'],
  });
  return contacts.map((c) => c.id);
}

// `$in` with an empty list would be dropped on the way through the query
// string, and the filter with it: -1 matches no row instead.
const idList = (ids) => (ids.length ? ids : [-1]);

/**
 * Adds `clause` (v3 `_where` syntax) to the request's filters, ANDed with
 * whatever the caller asked for. It goes both into `_where` (read by
 * adaptQuery / adaptCtxQuery) and, when the caller sent v5 `filters`, into
 * those too, so whichever of the two the controller ends up using is narrowed.
 */
function narrowQuery(ctx, clause, v5Clause) {
  const query = { ...(ctx.query || {}) };
  query._where = { _and: [clause, ...(query._where !== undefined ? [query._where] : [])] };
  if (query.filters !== undefined) query.filters = { $and: [v5Clause, query.filters] };
  ctx.query = query;
}

function ordersClause(userId, contactIds) {
  return {
    v3: { _or: [{ 'owner.id': userId }, { 'contact.id_in': idList(contactIds) }] },
    v5: { $or: [{ owner: { id: userId } }, { contact: { id: { $in: idList(contactIds) } } }] },
  };
}

/** The row a core `/:id` route addresses (v3-compat resolved the numeric id). */
function addressedRow(ctx) {
  const numericId = ctx.state && ctx.state.v3 && ctx.state.v3.numericId;
  if (numericId !== undefined && numericId !== null) return { id: numericId };
  const id = ctx.params && ctx.params.id;
  if (id === undefined) return null;
  return /^\d+$/.test(String(id)) ? { id: Number(id) } : { documentId: id };
}

const payloadOf = (ctx) => {
  const body = ctx.request.body;
  if (!body || typeof body !== 'object') return {};
  return body.data && typeof body.data === 'object' ? body.data : body;
};

/** 'owner' when she owns the order, 'pickup' when it goes to her contact, else null. */
function orderAccess(order, userId, contactIds) {
  if (!order) return null;
  if (idOf(order.owner) === userId) return 'owner';
  if (contactIds.includes(idOf(order.contact))) return 'pickup';
  return null;
}

async function loadOrder(strapi, where) {
  return strapi.db
    .query(ORDER)
    .findOne({ where, populate: { owner: { select: ['id'] }, contact: { select: ['id'] } } });
}

/**
 * A member changes the state of her own orders only to cancel a pending one
 * (the order form's «Anul·la la comanda»); sending the status unchanged is
 * fine (the form saves it). Processed, delivered, invoiced or cancelled orders
 * are the office's: no going back to Pendent (issues/144).
 */
function memberMayChangeStatus(current, requested) {
  if (requested === undefined || requested === null || requested === current) return true;
  return current === 'pending' && requested === 'cancelled';
}

// ---------------------------------------------------------------------------
// Member scopes: action -> (ctx, next, { strapi, userId }) handler
// ---------------------------------------------------------------------------

async function scopeOrderList(ctx, next, { strapi, userId }) {
  const { v3, v5 } = ordersClause(userId, await memberContactIds(strapi, userId));
  narrowQuery(ctx, v3, v5);
  return next();
}

async function scopeOrderRow(ctx, next, { strapi, userId }) {
  const where = addressedRow(ctx);
  if (!where) throw forbidden();
  const order = await loadOrder(strapi, where);
  if (!order) return next(); // let the controller answer its 404
  const access = orderAccess(order, userId, await memberContactIds(strapi, userId));
  if (!access) throw forbidden();
  if (ctx.method === 'PUT') {
    const payload = payloadOf(ctx);
    if (access === 'pickup') {
      if (Object.keys(payload).some((key) => !PICKUP_POINT_FIELDS.has(key))) throw forbidden();
    } else {
      if (payload.owner !== undefined && payload.owner !== null && idOf(payload.owner) !== userId)
        throw forbidden();
      if (!memberMayChangeStatus(order.status, payload.status)) throw forbidden();
    }
  }
  return next();
}

async function scopeOrderCreate(ctx, next, { userId }) {
  const payload = payloadOf(ctx);
  if (payload.owner !== undefined && payload.owner !== null && idOf(payload.owner) !== userId)
    throw forbidden();
  payload.owner = userId;
  return next();
}

async function scopeOrderCsv(ctx, next, { userId }) {
  const body = ctx.request.body || {};
  if (body.owner !== undefined && body.owner !== null && idOf(body.owner) !== userId) throw forbidden();
  // createCSV reads `owner.id`, and gives the same owner to a contact it creates
  body.owner = { id: userId };
  return next();
}

async function scopeOrderPdf(ctx, next, { strapi, userId }) {
  const ids = ((ctx.request.body && ctx.request.body.orders) || []).map(Number);
  if (ids.length) {
    const contactIds = await memberContactIds(strapi, userId);
    const orders = await strapi.db.query(ORDER).findMany({
      where: { id: { $in: ids } },
      populate: { owner: { select: ['id'] }, contact: { select: ['id'] } },
    });
    if (orders.some((order) => !orderAccess(order, userId, contactIds))) throw forbidden();
  }
  return next();
}

/**
 * «Rutes i dies» counts the orders of every member per route and day, from
 * `orders/table` with no owner filter. The member keeps those counts, but the
 * rows of other members' orders come down to what is counted.
 */
async function scopeOrderTable(ctx, next, { strapi, userId }) {
  const contactIds = await memberContactIds(strapi, userId);
  await next();
  if (!Array.isArray(ctx.body)) return;
  ctx.body = ctx.body.map((order) =>
    orderAccess(order, userId, contactIds)
      ? order
      : {
          id: order.id,
          status: order.status,
          estimated_delivery_date: order.estimated_delivery_date,
          route: order.route ? { id: idOf(order.route) } : null,
        },
  );
}

async function scopeIncidenceList(ctx, next, { strapi, userId }) {
  const contactIds = idList(await memberContactIds(strapi, userId));
  narrowQuery(
    ctx,
    { _or: [{ 'order.owner.id': userId }, { 'order.contact.id_in': contactIds }] },
    { $or: [{ order: { owner: { id: userId } } }, { order: { contact: { id: { $in: contactIds } } } }] },
  );
  return next();
}

async function scopeIncidenceRow(ctx, next, { strapi, userId }) {
  const where = addressedRow(ctx);
  if (!where) throw forbidden();
  const incidence = await strapi.db
    .query(INCIDENCE)
    .findOne({ where, populate: { order: { select: ['id'] } } });
  if (!incidence) return next();
  const order = incidence.order ? await loadOrder(strapi, { id: incidence.order.id }) : null;
  if (!orderAccess(order, userId, await memberContactIds(strapi, userId))) throw forbidden();
  return next();
}

/** Invoices addressed to the member's own contact («Factures»). */
async function scopeInvoiceList(ctx, next, { strapi, userId }) {
  const contactIds = idList(await memberContactIds(strapi, userId));
  narrowQuery(ctx, { 'contact.id_in': contactIds }, { contact: { id: { $in: contactIds } } });
  return next();
}

/**
 * Her emitted invoices, without the drafts: «Facturar» creates them and the
 * office checks and issues them before she sees them (issues/155).
 */
async function scopeEmittedInvoiceList(ctx, next, { strapi, userId }) {
  const contactIds = idList(await memberContactIds(strapi, userId));
  // v3 spelling, read by the query adapter like the request's own `_where`
  const notDraft = { _or: [{ 'state_ne': 'draft' }, { 'state_null': true }] };
  narrowQuery(
    ctx,
    { _and: [{ 'contact.id_in': contactIds }, notDraft] },
    {
      $and: [
        { contact: { id: { $in: contactIds } } },
        { $or: [{ state: { $ne: 'draft' } }, { state: { $null: true } }] },
      ],
    },
  );
  return next();
}

async function scopeContactCreate(ctx, next, { userId }) {
  const payload = payloadOf(ctx);
  if (payload.owner !== undefined && payload.owner !== null && idOf(payload.owner) !== userId)
    throw forbidden();
  payload.owner = userId;
  return next();
}

/**
 * The contacts a member can open on «Punts d'entrega»: hers (owner or her own
 * contact), the shared ones, and the ones her orders go to.
 */
async function scopeContactUpdate(ctx, next, { strapi, userId }) {
  const where = addressedRow(ctx);
  if (!where) throw forbidden();
  const contact = await strapi.db.query(CONTACT).findOne({
    where,
    populate: { owner: { select: ['id'] }, users_permissions_user: { select: ['id'] } },
  });
  if (!contact) return next();
  const visible =
    idOf(contact.owner) === userId ||
    idOf(contact.users_permissions_user) === userId ||
    contact.multiowner === true ||
    contact.multidelivery === true ||
    (await strapi.db.query(ORDER).count({ where: { owner: { id: userId }, contact: { id: contact.id } } })) >
      0;
  if (!visible) throw forbidden();
  const payload = payloadOf(ctx);
  // the form sends her as the owner; anyone else would hand the contact over
  if (
    payload.owner !== undefined &&
    payload.owner !== null &&
    ![userId, idOf(contact.owner)].includes(idOf(payload.owner))
  ) {
    throw forbidden();
  }
  if (
    payload.users_permissions_user !== undefined &&
    idOf(payload.users_permissions_user) !== idOf(contact.users_permissions_user)
  ) {
    throw forbidden();
  }
  return next();
}

async function scopeOrdersImport(ctx, next, { userId }) {
  const payload = payloadOf(ctx);
  payload.users_permissions_user = userId;
  return next();
}

// ---------------------------------------------------------------------------
// Own rows (hours): action -> (ctx, next, { strapi, userId }) handler, for every
// user without full access. The rows belong to `users_permissions_user`.
// ---------------------------------------------------------------------------

const ownClause = (userId) => ({
  v3: { 'users_permissions_user.id': userId },
  v5: { users_permissions_user: { id: userId } },
});

async function scopeOwnList(ctx, next, { userId }) {
  const { v3, v5 } = ownClause(userId);
  narrowQuery(ctx, v3, v5);
  return next();
}

/** The payload may only name her as the person (or leave it out). */
function checkOwnPayload(ctx, userId) {
  const payload = payloadOf(ctx);
  if (
    payload.users_permissions_user !== undefined &&
    payload.users_permissions_user !== null &&
    idOf(payload.users_permissions_user) !== userId
  ) {
    throw forbidden();
  }
  return payload;
}

const scopeOwnCreate = (ctx, next, { userId }) => {
  checkOwnPayload(ctx, userId).users_permissions_user = userId;
  return next();
};

const scopeOwnRow = (uid) =>
  async function scopeOwn(ctx, next, { strapi, userId }) {
    const where = addressedRow(ctx);
    if (!where) throw forbidden();
    const row = await strapi.db
      .query(uid)
      .findOne({ where, populate: { users_permissions_user: { select: ['id'] } } });
    if (!row) return next();
    if (idOf(row.users_permissions_user) !== userId) throw forbidden();
    if (ctx.method === 'PUT') checkOwnPayload(ctx, userId);
    return next();
  };

/** «Mou les hores» moves only her own hours. */
async function scopeActivityMove(ctx, next, { userId }) {
  const body = ctx.request.body || {};
  if (body.user !== undefined && body.user !== null && idOf(body.user) !== userId) throw forbidden();
  body.user = userId;
  ctx.request.body = body;
  return next();
}

async function scopeActivityImportCalendar(ctx, next, { userId }) {
  if (Number(ctx.params && ctx.params.id) !== userId) throw forbidden();
  return next();
}

function stripDedications(body) {
  const data = body && typeof body === 'object' && 'data' in body ? body.data : body;
  for (const row of Array.isArray(data) ? data : [data]) {
    if (row && typeof row === 'object') for (const field of DEDICATION_SALARY_FIELDS) delete row[field];
  }
}

const withoutSalary = (scope) =>
  async function scopeDedications(ctx, next, deps) {
    await scope(ctx, next, deps);
    stripDedications(ctx.body);
  };

const OWN_SCOPES = {
  [`${ACTIVITY}.find`]: scopeOwnList,
  [`${ACTIVITY}.getForCalendar`]: scopeOwnList,
  [`${ACTIVITY}.findOne`]: scopeOwnRow(ACTIVITY),
  [`${ACTIVITY}.create`]: scopeOwnCreate,
  [`${ACTIVITY}.update`]: scopeOwnRow(ACTIVITY),
  [`${ACTIVITY}.delete`]: scopeOwnRow(ACTIVITY),
  [`${ACTIVITY}.move`]: scopeActivityMove,
  [`${ACTIVITY}.importCalendar`]: scopeActivityImportCalendar,
  [`${TIME_COUNTER}.find`]: scopeOwnList,
  [`${TIME_COUNTER}.findOne`]: scopeOwnRow(TIME_COUNTER),
  [`${TIME_COUNTER}.create`]: scopeOwnCreate,
  [`${TIME_COUNTER}.update`]: scopeOwnRow(TIME_COUNTER),
  [`${TIME_COUNTER}.delete`]: scopeOwnRow(TIME_COUNTER),
  [`${WORKDAY_LOG}.find`]: scopeOwnList,
  [`${WORKDAY_LOG}.findOne`]: scopeOwnRow(WORKDAY_LOG),
  [`${WORKDAY_LOG}.create`]: scopeOwnCreate,
  [`${WORKDAY_LOG}.update`]: scopeOwnRow(WORKDAY_LOG),
  [`${WORKDAY_LOG}.delete`]: scopeOwnRow(WORKDAY_LOG),
  [`${DAILY_DEDICATION}.find`]: withoutSalary(scopeOwnList),
  [`${DAILY_DEDICATION}.findOne`]: withoutSalary(scopeOwnRow(DAILY_DEDICATION)),
  // the holidays for everyone stay readable (calendars); the festive controller
  // already keeps their changes to admins (issues/140)
  [`${FESTIVE}.create`]: scopeOwnCreate,
  [`${FESTIVE}.update`]: scopeOwnRow(FESTIVE),
  [`${FESTIVE}.delete`]: scopeOwnRow(FESTIVE),
};

const MEMBER_SCOPES = {
  [`${ORDER}.find`]: scopeOrderList,
  [`${ORDER}.findOne`]: scopeOrderRow,
  [`${ORDER}.update`]: scopeOrderRow,
  [`${ORDER}.create`]: scopeOrderCreate,
  [`${ORDER}.createCSV`]: scopeOrderCsv,
  [`${ORDER}.pdfmultiple`]: scopeOrderPdf,
  [`${ORDER}.table`]: scopeOrderTable,
  [`${INCIDENCE}.find`]: scopeIncidenceList,
  [`${INCIDENCE}.findOne`]: scopeIncidenceRow,
  [`${INCIDENCE}.update`]: scopeIncidenceRow,
  [`${INCIDENCE}.delete`]: scopeIncidenceRow,
  'api::emitted-invoice.emitted-invoice.findBasic': scopeEmittedInvoiceList,
  'api::received-income.received-income.findBasic': scopeInvoiceList,
  [`${CONTACT}.create`]: scopeContactCreate,
  [`${CONTACT}.update`]: scopeContactUpdate,
  'api::orders-import.orders-import.create': scopeOrdersImport,
};

function stripMe(body) {
  const me =
    body && typeof body === 'object' && body.data && typeof body.data === 'object' ? body.data : body;
  if (!me || typeof me !== 'object') return;
  for (const field of ME_PRIVATE_FIELDS) delete me[field];
}

module.exports = (config, { strapi }) =>
  async function appPermissions(ctx, next) {
    const user = ctx.state && ctx.state.user;
    const action = actionOf(ctx.state && ctx.state.route);
    if (!user || !action) return next();

    const permissions = await appPermissionsOf(strapi, user.id);
    if (!isAllowed(action, permissions)) throw forbidden();
    if (permissions.some((p) => FULL_ACCESS.includes(p))) return next();

    if (action === 'api::me.me.find') {
      await next();
      stripMe(ctx.body);
      return;
    }
    const scope = OWN_SCOPES[action] || (isOrdersMember(permissions) && MEMBER_SCOPES[action]);
    if (scope) return scope(ctx, next, { strapi, userId: user.id });
    return next();
  };

module.exports.actionOf = actionOf;
module.exports.MEMBER_SCOPES = MEMBER_SCOPES;
module.exports.OWN_SCOPES = OWN_SCOPES;
