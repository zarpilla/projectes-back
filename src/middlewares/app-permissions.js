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
 * 5. A member's order keeps only what she decides (issues/163): the price,
 *    the discounts, the invoice and the moves of the office are dropped from
 *    what she sends, and the price is computed by the server. A driver
 *    (`orders_delivery` without the office) changes only the operation fields
 *    of an order (state, deposit, pickup, transfer, delivery).
 * 6. A member changes only the address and contact fields of her delivery
 *    points, and of the shared ones only the address (issues/164).
 * 7. Saved pivot views are read and changed only for the screens the user's
 *    permissions open (issues/166).
 * 8. Every response is cleaned of the salaries, the identity of the people and
 *    the projects' finances, however deep the populate went
 *    (services/response-sanitizer.js, issues/165); members also get only the
 *    contacts they can see on «Punts d'entrega».
 *
 * Public routes (no user) are left to the Public role.
 */
const { errors } = require('@strapi/utils');
const {
  isAllowed,
  isOrdersMember,
  isDriver,
  pivotIdentifiersFor,
  FULL_ACCESS,
  LOGISTICS,
} = require('../services/app-access-rules');
const { rulesFor, sanitizeResponse, modelUidOfAction } = require('../services/response-sanitizer');
const { findOrderRouteRate } = require('../api/order/services/route-price');
const { relationId } = require('../services/relation-input');

const ORDER = 'api::order.order';
const CONTACT = 'api::contact.contact';
const INCIDENCE = 'api::incidence.incidence';
const USER = 'plugin::users-permissions.user';
const ACTIVITY = 'api::activity.activity';
const TIME_COUNTER = 'api::time-counter.time-counter';
const WORKDAY_LOG = 'api::workday-log.workday-log';
const DAILY_DEDICATION = 'api::daily-dedication.daily-dedication';
const FESTIVE = 'api::festive.festive';
const PIVOT_VIEW = 'api::pivot-table-view.pivot-table-view';

// What a member may change on an order delivered to her contact but owned by
// another member (PickupPoints: the boxes she picked up; incidences modal).
const PICKUP_POINT_FIELDS = new Set(['lines', 'picked_up', 'incidences', '_tracking_user']);

// The office's fields of an order (issues/163). The member's order form posts
// the whole order, these included, so they are dropped rather than refused.
// The price and the discounts are computed by the server (order lifecycles,
// route-price.js) from what she chose; the deposit is hers («Dipòsits»), but
// always in her name.
const OFFICE_ORDER_FIELDS = [
  'price',
  'multidelivery_discount',
  'volume_discount',
  'contact_pickup_discount',
  'emitted_invoice',
  'emitted_invoice_datetime',
  'delivery_date',
  'route_date',
  'pickup_date',
  'pickup_user',
  'transfer',
  'transfer_start_date',
  'transfer_start_user',
  'transfer_end_date',
  'transfer_end_user',
  'transfer_pickup_origin',
  'transfer_pickup_destination',
  'transfer_route',
  'transfer_route_date',
  'manual_transfer_route',
  'last_mile',
  'is_collection_order',
  'collection_order',
  'collection_orders',
  'deposit_user',
];

// What the price of an order depends on: when one of them changes, the price
// is computed again.
const PRICE_INPUTS = [
  'kilograms',
  'lines',
  'route_rate',
  'route',
  'pickup',
  'delivery_type',
  'collection_point',
];

// What a member still changes on her order once the office has processed it:
// the boxes picked up, the incidences, the deposit and cancelling.
const MEMBER_LATE_FIELDS = new Set([...PICKUP_POINT_FIELDS, 'status', 'deposit_date']);

// What a driver changes on an order (Operacions, Transferències, Dipòsits, the
// state of the Comandes list and the incidences).
const DRIVER_ORDER_FIELDS = new Set([
  'status',
  'delivery_date',
  'deposit_date',
  'deposit_user',
  'pickup_date',
  'pickup_user',
  'transfer_start_date',
  'transfer_start_user',
  'transfer_end_date',
  'transfer_end_user',
  'picked_up',
  'incidences',
  '_tracking_user',
]);

// A move and the user it is recorded with: always whoever makes it.
const MOVES = {
  deposit_date: 'deposit_user',
  pickup_date: 'pickup_user',
  transfer_start_date: 'transfer_start_user',
  transfer_end_date: 'transfer_end_user',
};

// What a member changes on her own delivery points (ContactsUserForm), and on
// the shared ones or the ones of other members her orders go to: the address
// only (issues/164). Discounts, partner data and the office's flags stay with
// the office.
const SHARED_CONTACT_FIELDS = [
  'address',
  'city',
  'postcode',
  'country',
  'state',
  'phone',
  'contact_person',
  'contact_phone',
  'email',
  'time_slot_1_ini',
  'time_slot_1_end',
  'time_slot_2_ini',
  'time_slot_2_end',
];
const MEMBER_CONTACT_FIELDS = [
  ...SHARED_CONTACT_FIELDS,
  'name',
  'trade_name',
  'nif',
  'website',
  'notes',
  'legal_form',
  'sector',
  'owner',
  'users_permissions_user',
];
// a new point from the order form is tagged as a delivery point
const MEMBER_NEW_CONTACT_FIELDS = [...MEMBER_CONTACT_FIELDS, 'contact_types'];

// What a worker gets of the contacts (the Dedicació pivot loads the list).
const CONTACT_NAME_FIELDS = ['id', 'documentId', 'name', 'trade_name'];

// A member deletes an incidence of her order while it is open and less than a
// day old, like the Incidències screen lets her.
const INCIDENCE_DELETE_HOURS = 24;

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

const omit = (payload, fields) => {
  for (const field of fields) delete payload[field];
};

const pick = (payload, fields) => {
  for (const key of Object.keys(payload)) if (!fields.includes(key)) delete payload[key];
};

/** Each move sent is recorded in the name of `userId` (or cleared with its date). */
function ownMoves(payload, userId) {
  for (const [date, user] of Object.entries(MOVES)) {
    if (date in payload) payload[user] = payload[date] ? userId : null;
    else delete payload[user];
  }
}

// The relations a regular order's rate depends on (route-price.js findOrderRouteRate).
const RATE_INPUTS = ['route', 'delivery_type', 'pickup', 'collection_point'];

/**
 * The rate of a member's order is the server's, whatever rate she sends: any
 * rate id was priced, another route's cheaper one, the normal rate of a
 * refrigerated order, an empty one at 0 € (issues/186). `order` is the stored
 * row on update; the CSV import reads the rate as `{ id }`.
 */
async function memberRouteRate(strapi, payload, userId, { order, csv }) {
  let stored = {};
  if (order && order.id) {
    stored =
      (await strapi.db.query(ORDER).findOne({
        where: { id: order.id },
        populate: Object.fromEntries(RATE_INPUTS.map((field) => [field, { select: ['id'] }])),
      })) || {};
    if (stored.is_collection_order) return;
  }
  const effective = { id: order && order.id };
  for (const field of RATE_INPUTS) effective[field] = field in payload ? payload[field] : stored[field];
  const rate = await findOrderRouteRate(effective, userId, strapi);
  payload.route_rate = rate ? (csv ? { id: rate.id } : rate.id) : null;
}

/**
 * The delivery point and the collection point of a member's order must be ones
 * she sees: attaching any contact id to an order made it «one her orders go
 * to», readable in full and editable from then on (issues/187). A new point
 * (the CSV import's contact without id) is created as hers.
 */
async function checkMemberOrderContacts(strapi, payload, userId) {
  const contactId = relationId(payload.contact);
  if (contactId !== undefined) {
    await loadVisibleContact(
      strapi,
      typeof contactId === 'number' ? { id: contactId } : { documentId: contactId },
      userId,
    );
  }
  const pointId = relationId(payload.collection_point);
  if (pointId !== undefined) {
    const own = await strapi.db.query(CONTACT).findMany({
      where: { users_permissions_user: { id: userId } },
      select: ['id'],
      populate: { collection_points: { select: ['id', 'documentId'] } },
    });
    const points = own.flatMap((c) => c.collection_points || []);
    if (!points.some((p) => p.id === pointId || p.documentId === pointId)) {
      await loadVisibleContact(
        strapi,
        typeof pointId === 'number' ? { id: pointId } : { documentId: pointId },
        userId,
      );
    }
  }
}

/**
 * What a member sends for her order, without the office's fields (issues/163).
 * The pickup discount is the one of the delivery point, and the rate and price
 * are left for the server to compute (route-price.js, the form's choice and
 * tiers) when the order is new or one of its inputs changes; the discounts are
 * the lifecycles'.
 */
async function memberOrderPayload(
  strapi,
  payload,
  userId,
  { creating, order = null, csv = false, permissions = [] },
) {
  const depositSent = 'deposit_date' in payload;
  // a driver who is a member too sees every point already
  if (!permissions.includes('orders_delivery')) await checkMemberOrderContacts(strapi, payload, userId);
  omit(payload, OFFICE_ORDER_FIELDS);
  if (depositSent) payload.deposit_user = payload.deposit_date ? userId : null;
  const contactId = idOf(payload.contact);
  if (contactId !== undefined && contactId !== null) {
    const contact = await strapi.db
      .query(CONTACT)
      .findOne({ where: { id: contactId }, select: ['id', 'pickup_discount'] });
    payload.contact_pickup_discount = (contact && contact.pickup_discount) || 0;
  }
  if (creating || PRICE_INPUTS.some((field) => field in payload)) {
    payload.price = null;
    await memberRouteRate(strapi, payload, userId, { order, csv });
  }
  return payload;
}

/** A member's own order: the order form, the Comandes list, Dipòsits. */
async function memberOwnOrderUpdate(strapi, order, payload, userId, permissions = []) {
  if (payload.owner !== undefined && payload.owner !== null && idOf(payload.owner) !== userId)
    throw forbidden();
  if (!memberMayChangeStatus(order.status, payload.status)) throw forbidden();
  // once the office has the order, the form is read-only for her
  if (order.status !== 'pending') pick(payload, [...MEMBER_LATE_FIELDS]);
  await memberOrderPayload(strapi, payload, userId, { creating: false, order, permissions });
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
      await memberOwnOrderUpdate(strapi, order, payload, userId);
    }
  }
  return next();
}

async function scopeOrderCreate(ctx, next, { strapi, userId, permissions }) {
  const payload = payloadOf(ctx);
  if (payload.owner !== undefined && payload.owner !== null && idOf(payload.owner) !== userId)
    throw forbidden();
  payload.owner = userId;
  // a new order is the office's to process (issues/163)
  payload.status = 'pending';
  await memberOrderPayload(strapi, payload, userId, { creating: true, permissions });
  return next();
}

async function scopeOrderCsv(ctx, next, { strapi, userId, permissions }) {
  const body = ctx.request.body || {};
  if (body.owner !== undefined && body.owner !== null && idOf(body.owner) !== userId) throw forbidden();
  // a new point (a contact without id): the office's fields of a contact stay out too
  if (body.contact && typeof body.contact === 'object' && body.contact.id === undefined) {
    pick(body.contact, MEMBER_NEW_CONTACT_FIELDS);
  }
  await memberOrderPayload(strapi, body, userId, { creating: true, csv: true, permissions });
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
  const access = orderAccess(order, userId, await memberContactIds(strapi, userId));
  if (!access) throw forbidden();
  if (ctx.method === 'DELETE' && !memberMayDeleteIncidence(incidence, access)) throw forbidden();
  return next();
}

/** Her order's incidence, still open, less than a day old (IncidencesTable's canDelete). */
function memberMayDeleteIncidence(incidence, access) {
  if (access !== 'owner' || incidence.state === 'closed') return false;
  const created = Date.parse(incidence.createdAt || incidence.created_at);
  return Number.isFinite(created) && Date.now() - created < INCIDENCE_DELETE_HOURS * 3600 * 1000;
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
  pick(payload, MEMBER_NEW_CONTACT_FIELDS);
  payload.owner = userId;
  return next();
}

/** The ids of the contacts her orders go to. */
async function orderContactIds(strapi, userId) {
  const orders = await strapi.db.query(ORDER).findMany({
    where: { owner: { id: userId } },
    select: ['id'],
    populate: { contact: { select: ['id'] } },
  });
  return [...new Set(orders.map((o) => idOf(o.contact)).filter((id) => id !== undefined && id !== null))];
}

/**
 * The contacts a member sees on «Punts d'entrega» and in the order form (issues/165):
 * hers (owner or her own contact), the shared ones, and the ones her orders go to.
 */
/** The contacts a member sees, as v3 and v5 clauses (issues/165). */
async function memberContactsClauses(strapi, userId) {
  const ids = idList(await orderContactIds(strapi, userId));
  return {
    v3: {
      _or: [
        { 'owner.id': userId },
        { 'users_permissions_user.id': userId },
        { 'multiowner_eq': true },
        { 'multidelivery_eq': true },
        { 'id_in': ids },
      ],
    },
    v5: {
      $or: [
        { owner: { id: userId } },
        { users_permissions_user: { id: userId } },
        { multiowner: true },
        { multidelivery: true },
        { id: { $in: ids } },
      ],
    },
  };
}

async function scopeContactList(ctx, next, { strapi, userId }) {
  const { v3, v5 } = await memberContactsClauses(strapi, userId);
  narrowQuery(ctx, v3, v5);
  return next();
}

/**
 * `contacts/for-orders` (Comandes, the order form) gave a member the whole
 * directory, with NIF, phone, address, notes and discounts (issues/187): she
 * gets the contacts «Punts d'entrega» shows her, and of the `?socies=1` list
 * (her collection points) only her own contact.
 */
async function scopeContactsForOrders(ctx, next, { strapi, userId }) {
  const socies = ['1', 'true'].includes(String((ctx.query || {}).socies));
  const visible = socies
    ? null
    : await strapi.db
        .query(CONTACT)
        .findMany({ where: (await memberContactsClauses(strapi, userId)).v5, select: ['id'] });
  await next();
  if (!Array.isArray(ctx.body)) return;
  if (socies) {
    ctx.body = ctx.body.filter((c) => idOf(c.users_permissions_user) === userId);
    return;
  }
  const ids = new Set(visible.map((c) => c.id));
  ctx.body = ctx.body.filter((c) => ids.has(c.id));
}

async function loadVisibleContact(strapi, where, userId) {
  const contact = await strapi.db.query(CONTACT).findOne({
    where,
    populate: { owner: { select: ['id'] }, users_permissions_user: { select: ['id'] } },
  });
  if (!contact) return { contact: null };
  const own = idOf(contact.owner) === userId || idOf(contact.users_permissions_user) === userId;
  const visible =
    own ||
    contact.multiowner === true ||
    contact.multidelivery === true ||
    (await strapi.db.query(ORDER).count({ where: { owner: { id: userId }, contact: { id: contact.id } } })) >
      0;
  if (!visible) throw forbidden();
  return { contact, own };
}

async function scopeContactRow(ctx, next, { strapi, userId }) {
  const where = addressedRow(ctx);
  if (!where) throw forbidden();
  await loadVisibleContact(strapi, where, userId);
  return next();
}

/**
 * The contacts a member can open on «Punts d'entrega»: hers (owner or her own
 * contact), the shared ones, and the ones her orders go to. Hers she edits but
 * for the office's fields; the others, only their address (issues/164).
 */
async function scopeContactUpdate(ctx, next, { strapi, userId }) {
  const where = addressedRow(ctx);
  if (!where) throw forbidden();
  const { contact, own } = await loadVisibleContact(strapi, where, userId);
  if (!contact) return next();
  const payload = payloadOf(ctx);
  pick(payload, own ? MEMBER_CONTACT_FIELDS : SHARED_CONTACT_FIELDS);
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
// Driver scopes (issues/163): `orders_delivery` without the office. She makes
// the moves of any order; the orders themselves are the office's, or the
// member's when she is one too.
// ---------------------------------------------------------------------------

const asMember = (scope) =>
  async function scopeDriverAsMember(ctx, next, deps) {
    if (!deps.permissions.includes('orders')) throw forbidden();
    return scope(ctx, next, deps);
  };

async function scopeDriverOrderUpdate(ctx, next, { strapi, userId, permissions }) {
  const where = addressedRow(ctx);
  if (!where) throw forbidden();
  const order = await loadOrder(strapi, where);
  if (!order) return next();
  const payload = payloadOf(ctx);
  // her own pending order, when she is a member too
  if (permissions.includes('orders') && idOf(order.owner) === userId && order.status === 'pending') {
    await memberOwnOrderUpdate(strapi, order, payload, userId, permissions);
    return next();
  }
  if (Object.keys(payload).some((key) => !DRIVER_ORDER_FIELDS.has(key))) throw forbidden();
  const { status } = payload;
  if (status !== undefined && status !== null && status !== order.status) {
    // invoicing is the office's, and so is what has been invoiced
    if (status === 'invoiced' || order.status === 'invoiced') throw forbidden();
  }
  ownMoves(payload, userId);
  return next();
}

// ---------------------------------------------------------------------------
// Saved pivot views (issues/166): only the ones of her screens.
// ---------------------------------------------------------------------------

async function scopePivotViewList(ctx, next, { permissions }) {
  const identifiers = idList(pivotIdentifiersFor(permissions));
  narrowQuery(ctx, { 'identifier_in': identifiers }, { identifier: { $in: identifiers } });
  return next();
}

async function scopePivotViewRow(ctx, next, { strapi, permissions }) {
  const where = addressedRow(ctx);
  if (!where) throw forbidden();
  const identifiers = pivotIdentifiersFor(permissions);
  const view = await strapi.db.query(PIVOT_VIEW).findOne({ where, select: ['id', 'identifier'] });
  if (!view) return next();
  if (!identifiers.includes(view.identifier)) throw forbidden();
  const payload = payloadOf(ctx);
  if (ctx.method === 'PUT' && payload.identifier !== undefined && !identifiers.includes(payload.identifier)) {
    throw forbidden();
  }
  return next();
}

async function scopePivotViewCreate(ctx, next, { permissions }) {
  if (!pivotIdentifiersFor(permissions).includes(payloadOf(ctx).identifier)) throw forbidden();
  return next();
}

/**
 * The contact list (`contacts/basic`): members see the contacts of «Punts
 * d'entrega»; a worker, who only loads it with the Dedicació pivot, gets their
 * names (issues/165).
 */
async function scopeContactBasic(ctx, next, deps) {
  const { permissions } = deps;
  if (isOrdersMember(permissions)) return scopeContactList(ctx, next, deps);
  if (permissions.some((p) => LOGISTICS.includes(p))) return next();
  await next();
  if (Array.isArray(ctx.body)) {
    ctx.body = ctx.body.map((contact) =>
      Object.fromEntries(CONTACT_NAME_FIELDS.filter((f) => f in contact).map((f) => [f, contact[f]])),
    );
  }
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

/**
 * The holidays: the ones for everyone and her own. The personal holidays of
 * the others (vacances, festiu local…) came with the person to every user
 * (`festives?populate[users_permissions_user]`, issues/188); the hours screens
 * only use the shared ones and her own.
 */
const sharedOrOwnClause = (userId) => ({
  v3: { _or: [{ 'users_permissions_user.id_null': true }, { 'users_permissions_user.id': userId }] },
  v5: { $or: [{ users_permissions_user: { id: { $null: true } } }, { users_permissions_user: { id: userId } }] },
});

async function scopeFestiveList(ctx, next, { userId }) {
  const { v3, v5 } = sharedOrOwnClause(userId);
  narrowQuery(ctx, v3, v5);
  return next();
}

async function scopeFestiveRow(ctx, next, { strapi, userId }) {
  const where = addressedRow(ctx);
  if (!where) throw forbidden();
  const row = await strapi.db
    .query(FESTIVE)
    .findOne({ where, populate: { users_permissions_user: { select: ['id'] } } });
  if (row && row.users_permissions_user && idOf(row.users_permissions_user) !== userId) throw forbidden();
  return next();
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
  // without the salary fields: the response sanitizer drops them
  [`${DAILY_DEDICATION}.find`]: scopeOwnList,
  [`${DAILY_DEDICATION}.findOne`]: scopeOwnRow(DAILY_DEDICATION),
  // the holidays for everyone stay readable (calendars); the festive controller
  // already keeps their changes to admins (issues/140)
  [`${FESTIVE}.find`]: scopeFestiveList,
  [`${FESTIVE}.findOne`]: scopeFestiveRow,
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
  // the figures over the member's own orders, like the list (issues/177)
  [`${ORDER}.totals`]: scopeOrderList,
  [`${INCIDENCE}.find`]: scopeIncidenceList,
  [`${INCIDENCE}.findOne`]: scopeIncidenceRow,
  [`${INCIDENCE}.update`]: scopeIncidenceRow,
  [`${INCIDENCE}.delete`]: scopeIncidenceRow,
  'api::emitted-invoice.emitted-invoice.findBasic': scopeEmittedInvoiceList,
  'api::received-income.received-income.findBasic': scopeInvoiceList,
  [`${CONTACT}.find`]: scopeContactList,
  [`${CONTACT}.findOne`]: scopeContactRow,
  [`${CONTACT}.create`]: scopeContactCreate,
  [`${CONTACT}.update`]: scopeContactUpdate,
  [`${CONTACT}.forOrders`]: scopeContactsForOrders,
  'api::orders-import.orders-import.create': scopeOrdersImport,
};

const DRIVER_SCOPES = {
  [`${ORDER}.update`]: scopeDriverOrderUpdate,
  [`${ORDER}.create`]: asMember(scopeOrderCreate),
  [`${ORDER}.createCSV`]: asMember(scopeOrderCsv),
  'api::orders-import.orders-import.create': asMember(scopeOrdersImport),
};

// for every user without full access
const GENERAL_SCOPES = {
  [`${PIVOT_VIEW}.find`]: scopePivotViewList,
  [`${PIVOT_VIEW}.findOne`]: scopePivotViewRow,
  [`${PIVOT_VIEW}.update`]: scopePivotViewRow,
  [`${PIVOT_VIEW}.delete`]: scopePivotViewRow,
  [`${PIVOT_VIEW}.create`]: scopePivotViewCreate,
  [`${CONTACT}.basic`]: scopeContactBasic,
};

// the user's own data: nothing to clean
const OWN_DATA_ACTIONS = new Set([
  'api::me.me.find',
  'plugin::users-permissions.user.me',
  'plugin::users-permissions.user.home',
  'plugin::users-permissions.user.updateHome',
]);

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
    const member = isOrdersMember(permissions);
    const scope =
      OWN_SCOPES[action] ||
      (member && MEMBER_SCOPES[action]) ||
      (isDriver(permissions) && DRIVER_SCOPES[action]) ||
      GENERAL_SCOPES[action];
    if (scope) await scope(ctx, next, { strapi, userId: user.id, permissions });
    else await next();
    if (!OWN_DATA_ACTIONS.has(action)) {
      sanitizeResponse(
        strapi,
        modelUidOfAction(action),
        ctx.body,
        rulesFor({ member, selfId: user.id, permissions }),
      );
    }
  };

module.exports.actionOf = actionOf;
module.exports.MEMBER_SCOPES = MEMBER_SCOPES;
module.exports.OWN_SCOPES = OWN_SCOPES;
module.exports.DRIVER_SCOPES = DRIVER_SCOPES;
module.exports.GENERAL_SCOPES = GENERAL_SCOPES;
