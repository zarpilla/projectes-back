'use strict';
/* global strapi */

/**
 * PUT /api/integrations/orders and POST /api/integrations/orders/cancel — a
 * member's orders from her own system, identified by her `external_id`
 * (services/integrations/refs.js), with the rules her order form has:
 *
 * - Created pending, in her name; the rate, the price and the discounts are
 *   the server's (app-permissions memberOrderPayload, order lifecycles).
 * - Route and day: without a route (the usual way, the user's decision
 *   2026-10-30), the day she wants puts the order on the route of the point's
 *   town that runs that day, or on the first day after it that one does
 *   (route-assignment.js); the day asked is kept on its integration ref, so
 *   sending it again is no change. With a route, the day must be one the
 *   route runs (DATE_NOT_ON_ROUTE). Either way from tomorrow on
 *   (deliveryDateRefusal); past the cutoff it is late and pays the surcharge
 *   (applyLateFlags). Without a day, the first one from tomorrow.
 * - Only a pending order changes; one the office has taken is refused
 *   (ORDER_LOCKED), and cancelled is final (ORDER_CANCELLED). The same order
 *   sent again unchanged is `unchanged`, whatever its state.
 * - Cancelling is the member's «Anul·la la comanda»: pending → cancelled.
 *
 * Farm pickups (collection orders) are not part of the API: La Dotzena brings
 * its boxes to the warehouses.
 */
const moment = require('moment');
const { memberRules } = require('../../../middlewares/app-permissions');
const { orderRules } = require('../../order/controllers/order');
const { contactSnapshot } = require('../../order/services/contact-snapshot');
const { orderDiscountedPrice } = require('../../order/services/final-price');
const { fillMissingPrice } = require('../../order/services/route-price');
const { loadRouteClosures, nextRouteDay, routeRunsOn } = require('../../order/services/route-days');
const { readDefaultPickup } = require('../../../services/user-default-pickup');
const { toLocalDay } = require('../../../services/date-fields');
const refs = require('../../../services/integrations/refs');
const { norm, normNif, isBlank, resolveNamed } = require('./lookups');
const { reject } = require('./sync-common');
const { assignRouteDay } = require('./route-assignment');

const ORDER = 'api::order.order';
const CONTACT = 'api::contact.contact';

// what the CSV import checks on the delivery point of an order, but the sector
// (the user's decision 2026-10-30: a point without it still takes orders)
const POINT_REQUIRED = {
  nif: 'NIF',
  phone: 'telèfon',
  address: 'adreça',
  postcode: 'codi postal',
  city: 'població',
  time_slot_1_ini: 'horari',
  time_slot_1_end: 'horari',
};

const ymd = (value) => {
  if (!value) return null;
  if (typeof value === 'string') return value.slice(0, 10);
  return moment(value).format('YYYY-MM-DD');
};
const idOf = (value) => (value && typeof value === 'object' ? value.id : value || null);
const today = () => toLocalDay(new Date());
// «dimarts 03/11/2026»; without moment's 'ca' locale, which would become the process-wide one
const WEEKDAY_NAMES = ['diumenge', 'dilluns', 'dimarts', 'dimecres', 'dijous', 'divendres', 'dissabte'];
const dayText = (day) => {
  const m = moment(day, 'YYYY-MM-DD');
  return `${WEEKDAY_NAMES[m.day()]} ${m.format('DD/MM/YYYY')}`;
};

function booleanOf(value, field) {
  if (value === true || value === false) return value;
  if (value === 1 || value === '1' || value === 'true') return true;
  if (value === 0 || value === '0' || value === 'false' || value === null || value === '') return false;
  return reject('INVALID', `${field} ha de ser true o false`, { field });
}

function positiveInteger(value, field) {
  const n = typeof value === 'string' ? Number(value.trim()) : value;
  if (!Number.isInteger(n) || n <= 0)
    reject('INVALID', `${field} ha de ser un nombre enter més gran que 0`, { field });
  return n;
}

function positiveNumber(value, field) {
  const n = typeof value === 'string' ? Number(value.trim().replace(',', '.')) : value;
  if (typeof n !== 'number' || !Number.isFinite(n) || n <= 0) {
    reject('INVALID', `${field} ha de ser un nombre més gran que 0`, { field });
  }
  return Math.round(n * 100) / 100;
}

function textOf(value, field, max = 2000) {
  if (isBlank(value)) return null;
  if (typeof value === 'object') reject('INVALID', `${field} ha de ser un text`, { field });
  const text = String(value).trim();
  if (text.length > max) reject('INVALID', `${field} massa llarg (màxim ${max} caràcters)`, { field });
  return text;
}

function linesOf(value) {
  if (value === null || value === undefined) return [];
  if (!Array.isArray(value)) return reject('INVALID', 'lines ha de ser una llista', { field: 'lines' });
  return value.map((line, i) => {
    if (!line || typeof line !== 'object')
      reject('INVALID', `lines[${i}] ha de ser un objecte`, { field: 'lines' });
    return {
      units: isBlank(line.units) ? null : positiveInteger(line.units, `lines[${i}].units`),
      kilograms: isBlank(line.kilograms) ? null : positiveNumber(line.kilograms, `lines[${i}].kilograms`),
      name: textOf(line.name, `lines[${i}].name`, 255),
      nif: line.nif ? normNif(line.nif) : null,
    };
  });
}

const lineKey = (lines) =>
  JSON.stringify(
    (lines || []).map((l) => [
      l.units === null || l.units === undefined ? null : Number(l.units),
      l.kilograms === null || l.kilograms === undefined ? null : Number(l.kilograms),
      isBlank(l.name) ? null : String(l.name).trim(),
      isBlank(l.nif) ? null : normNif(l.nif),
    ]),
  );

async function resolveRoute(value, lookups) {
  const routes = (await lookups.routes()).filter((r) => r.active);
  const found = resolveNamed(routes, value, ['name', 'short_name']);
  if (found.error === 'ambiguous')
    reject('ROUTE_AMBIGUOUS', `Hi ha més d'una ruta «${value}»`, { field: 'route' });
  if (!found.item) reject('ROUTE_NOT_FOUND', `Ruta «${value}» no trobada o no activa`, { field: 'route' });
  return found.item;
}

async function resolvePickup(value, lookups, userId) {
  const pickups = await lookups.pickups();
  let pickup;
  if (isBlank(value)) {
    const preferred = await readDefaultPickup(userId);
    pickup = preferred && pickups.find((p) => p.id === preferred.id);
    if (!pickup) {
      reject('PICKUP_REQUIRED', 'Cal indicar el magatzem (pickup): no tens cap magatzem per defecte', {
        field: 'pickup',
      });
    }
  } else {
    const found = resolveNamed(pickups, value, ['name', 'alias']);
    if (!found.item) reject('PICKUP_NOT_FOUND', `Magatzem «${value}» no trobat`, { field: 'pickup' });
    pickup = found.item;
  }
  if (pickup.pickup) {
    reject('FARM_PICKUP_NOT_SUPPORTED', "Les recollides a finca no es poden fer des de l'API", {
      field: 'pickup',
    });
  }
  return pickup;
}

async function deliveryTypeOf(refrigerated, lookups) {
  const type = (await lookups.deliveryTypes()).find((t) => Boolean(t.refrigerated) === refrigerated);
  if (!type)
    reject('DELIVERY_TYPE_NOT_FOUND', `No hi ha cap tipus d'entrega ${refrigerated ? 'refrigerat' : 'sec'}`);
  return type;
}

async function loadPoint(id) {
  return strapi.db.query(CONTACT).findOne({
    where: { id },
    populate: { sector: { select: ['id'] }, legal_form: { select: ['id'] }, owner: { select: ['id'] } },
  });
}

/** The delivery point an order names: { external_id } (hers), { id }, or { nif, trade_name }. */
async function resolvePoint(value, ctx) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    reject('INVALID', 'delivery_point ha de ser un objecte: { external_id }, { id } o { nif, trade_name }', {
      field: 'delivery_point',
    });
  }
  let id = null;
  if (!isBlank(value.external_id)) {
    const ext = String(value.external_id).trim();
    const found = (await refs.findRefs(ctx.userId, 'contact', [ext])).get(ext);
    if (!found || !found.target) {
      reject('DELIVERY_POINT_NOT_FOUND', `No tens cap punt d'entrega amb external_id «${ext}»`, {
        field: 'delivery_point',
      });
    }
    id = found.target;
  } else if (!isBlank(value.id)) {
    id = Number(value.id);
  } else if (!isBlank(value.nif) && !isBlank(value.trade_name)) {
    id = await pointByNifAndName(value, ctx);
  } else {
    reject('INVALID', 'delivery_point necessita external_id, id o nif i trade_name', {
      field: 'delivery_point',
    });
  }
  const point = Number.isInteger(id) ? await loadPoint(id) : null;
  if (!point) reject('DELIVERY_POINT_NOT_FOUND', "Punt d'entrega no trobat", { field: 'delivery_point' });
  const missing = [
    ...new Set(
      Object.keys(POINT_REQUIRED)
        .filter((f) => isBlank(point[f]))
        .map((f) => POINT_REQUIRED[f]),
    ),
  ];
  if (missing.length) {
    reject(
      'DELIVERY_POINT_INCOMPLETE',
      `Al punt d'entrega ${point.trade_name || point.name} li falta: ${missing.join(', ')}`,
      { field: 'delivery_point', contact_id: point.id },
    );
  }
  return point;
}

/** A delivery point by NIF and trade name: hers first, then anyone's (members send to any point). */
async function pointByNifAndName(value, ctx) {
  if (!ctx.cache.points) {
    ctx.cache.points = await strapi.db.query(CONTACT).findMany({
      where: { owner: { id: { $notNull: true } }, nif: { $notNull: true } },
      select: ['id', 'nif', 'name', 'trade_name'],
      populate: { owner: { select: ['id'] } },
    });
  }
  const nif = normNif(value.nif);
  const name = norm(value.trade_name);
  const matches = ctx.cache.points.filter(
    (c) => normNif(c.nif) === nif && norm(c.trade_name || c.name) === name,
  );
  const own = matches.filter((c) => idOf(c.owner) === ctx.userId);
  const pool = own.length ? own : matches;
  if (pool.length > 1) {
    reject(
      'DELIVERY_POINT_AMBIGUOUS',
      "Hi ha més d'un punt d'entrega amb aquest NIF i aquest nom comercial",
      {
        field: 'delivery_point',
        contact_ids: pool.map((c) => c.id),
      },
    );
  }
  if (!pool.length) {
    reject('DELIVERY_POINT_NOT_FOUND', "No hi ha cap punt d'entrega amb aquest NIF i aquest nom comercial", {
      field: 'delivery_point',
    });
  }
  return pool[0].id;
}

const tomorrow = () => moment(today(), 'YYYY-MM-DD').add(1, 'day').format('YYYY-MM-DD');

/** The day asked for (YYYY-MM-DD), from tomorrow on; blank → tomorrow. */
async function requestedDayOf(value, ctx, { moving = false } = {}) {
  if (isBlank(value)) return tomorrow();
  const text = String(value).trim();
  if (!/^\d{4}-\d{2}-\d{2}$/.test(text) || !moment(text, 'YYYY-MM-DD', true).isValid()) {
    reject('INVALID', 'estimated_delivery_date ha de ser una data AAAA-MM-DD', {
      field: 'estimated_delivery_date',
    });
  }
  const refusal = await orderRules.deliveryDateRefusal(text, ctx.user);
  if (refusal) {
    reject('DATE_NOT_ALLOWED', moving ? refusal.replace('crear', 'moure') : refusal, {
      field: 'estimated_delivery_date',
    });
  }
  return text;
}

/** The route and day for the day asked, and the warning when it moved. */
async function assignedFor(point, day, ctx) {
  const assigned = await assignRouteDay(point, day, { lookups: ctx.lookups, today: today() });
  const warning = assigned.moved
    ? {
        code: 'DATE_MOVED',
        message: `Cap ruta de ${point.city} no surt el ${dayText(day)}: la comanda va el ${dayText(assigned.date)} amb la ruta ${assigned.route.name}`,
      }
    : null;
  return { ...assigned, warning };
}

/** The delivery date sent, checked against the route; or the route's next open day. */
async function deliveryDateOf(value, route, ctx, { moving = false } = {}) {
  if (isBlank(value)) {
    const day = await nextRouteDay(route, { after: today() });
    if (!day) reject('ROUTE_WITHOUT_DAYS', `La ruta ${route.name} no té cap dia obert`, { field: 'route' });
    return day;
  }
  const text = String(value).trim();
  if (!/^\d{4}-\d{2}-\d{2}$/.test(text) || !moment(text, 'YYYY-MM-DD', true).isValid()) {
    reject('INVALID', 'estimated_delivery_date ha de ser una data AAAA-MM-DD', {
      field: 'estimated_delivery_date',
    });
  }
  const refusal = await orderRules.deliveryDateRefusal(text, ctx.user);
  if (refusal) {
    reject('DATE_NOT_ALLOWED', moving ? refusal.replace('crear', 'moure') : refusal, {
      field: 'estimated_delivery_date',
    });
  }
  const closures = await loadRouteClosures(text, text);
  if (!routeRunsOn(route, text, closures)) {
    const closed = closures.find((c) => !idOf(c.route) || idOf(c.route) === route.id);
    reject(
      'DATE_NOT_ON_ROUTE',
      closed
        ? `La ruta ${route.name} està tancada el ${dayText(text)}`
        : `La ruta ${route.name} no surt el ${dayText(text)}`,
      { field: 'estimated_delivery_date', next_route_day: await nextRouteDay(route, { after: text }) },
    );
  }
  return text;
}

/** The order's fields as sent (only those present), resolved to ids. */
async function wantedOf(item, ctx) {
  const { lookups } = ctx;
  const wanted = {};
  if ('route' in item) wanted.route = await resolveRoute(item.route, lookups);
  if ('delivery_point' in item) wanted.point = await resolvePoint(item.delivery_point, ctx);
  if ('units' in item) wanted.units = positiveInteger(item.units, 'units');
  if ('kilograms' in item) wanted.kilograms = positiveNumber(item.kilograms, 'kilograms');
  if ('refrigerated' in item) wanted.refrigerated = booleanOf(item.refrigerated, 'refrigerated');
  if ('fragile' in item) wanted.fragile = booleanOf(item.fragile, 'fragile');
  if ('notes' in item) wanted.comments = textOf(item.notes, 'notes');
  if ('provider_order_number' in item) {
    wanted.provider_order_number = textOf(item.provider_order_number, 'provider_order_number', 255);
  }
  if ('lines' in item) wanted.lines = linesOf(item.lines);
  if ('pickup' in item && !isBlank(item.pickup))
    wanted.pickup = await resolvePickup(item.pickup, lookups, ctx.userId);
  return wanted;
}

const ORDER_SELECT = [
  'id',
  'documentId',
  'status',
  'estimated_delivery_date',
  'collection_pickup_date',
  'delivery_date',
  'units',
  'kilograms',
  'refrigerated',
  'fragile',
  'comments',
  'provider_order_number',
  'is_collection_order',
  'price',
  'volume_discount',
  'multidelivery_discount',
  'contact_pickup_discount',
  'late_order',
  'late_surcharge',
  'transfer',
];

async function loadOrder(id) {
  return strapi.db.query(ORDER).findOne({
    where: { id },
    select: ORDER_SELECT,
    populate: {
      owner: { select: ['id'] },
      route: { select: ['id', 'name'] },
      contact: { select: ['id', 'city'] },
      pickup: { select: ['id'] },
      delivery_type: { select: ['id', 'refrigerated'] },
      collection_point: { select: ['id'] },
      collection_pickup_route: { select: ['id'] },
      lines: true,
    },
  });
}

const routeOut = (route) => {
  if (!route) return null;
  return typeof route === 'object' ? { id: route.id, name: route.name || null } : { id: route, name: null };
};

/** What the answer tells of an order. */
function orderOut(order) {
  if (!order) return {};
  const price = order.price === null || order.price === undefined ? null : orderDiscountedPrice(order);
  return {
    order_id: order.id,
    status: order.status,
    route: routeOut(order.route),
    estimated_delivery_date: ymd(order.estimated_delivery_date),
    price,
    late_order: Boolean(order.late_order),
    late_surcharge: order.late_order ? Number(order.late_surcharge) || 0 : 0,
    transfer: Boolean(order.transfer),
  };
}

const LOCK_MESSAGES = {
  processed: 'Processada',
  deposited: 'Dipositada',
  distributing: 'En distribució',
  lastmile: 'A última milla',
  delivered: 'Lliurada',
  invoiced: 'Facturada',
};

function refuseIfNotPending(order) {
  if (order.status === 'pending') return;
  if (order.status === 'cancelled') {
    reject(
      'ORDER_CANCELLED',
      'La comanda està anul·lada i no es pot modificar. Fes-ne una de nova amb un altre external_id.',
      orderOut(order),
    );
  }
  reject(
    'ORDER_LOCKED',
    `La comanda ja està ${LOCK_MESSAGES[order.status] || order.status} i no es pot modificar. Parla amb l'oficina.`,
    orderOut(order),
  );
}

const warningsOf = (order) =>
  order && order.late_order
    ? [
        {
          code: 'LATE_ORDER',
          message: `Comanda fora de temps: porta un recàrrec del ${Number(order.late_surcharge) || 0} %`,
        },
      ]
    : [];

/** The stored order for an external_id, or null (a dangling reservation is released). */
async function storedOrder(externalId, ctx) {
  const found = (await refs.findRefs(ctx.userId, 'order', [externalId])).get(externalId);
  if (!found) return null;
  const order = found.target ? await loadOrder(found.target) : null;
  if (!order && !ctx.dryRun) await refs.release(found.id);
  if (order) order.ref = found;
  if (order && idOf(order.owner) !== ctx.userId) {
    reject('FORBIDDEN', "Aquesta comanda ja no és teva: l'oficina l'ha canviat. Parla amb l'oficina.", {
      order_id: order.id,
    });
  }
  return order;
}

/** PUT one order; `ctx` = { userId, user, permissions, lookups, dryRun, cache }. */
async function syncOrder(item, externalId, ctx) {
  if (!item || typeof item !== 'object' || Array.isArray(item))
    reject('INVALID', 'Cada comanda ha de ser un objecte');
  const stored = await storedOrder(externalId, ctx);
  return stored ? updateOrder(item, stored, ctx) : createOrder(item, externalId, ctx);
}

async function createOrder(item, externalId, ctx) {
  const missing = ['delivery_point', 'units', 'kilograms'].filter((f) => isBlank(item[f]));
  if (missing.length)
    reject('INVALID', `Falten camps obligatoris: ${missing.join(', ')}`, { fields: missing });
  const wanted = await wantedOf(item, ctx);
  const pickup = wanted.pickup || (await resolvePickup(null, ctx.lookups, ctx.userId));
  const deliveryType = await deliveryTypeOf(Boolean(wanted.refrigerated), ctx.lookups);
  let date;
  let requested = null;
  const extraWarnings = [];
  if (wanted.route) {
    date = await deliveryDateOf(item.estimated_delivery_date, wanted.route, ctx);
  } else {
    requested = await requestedDayOf(item.estimated_delivery_date, ctx);
    const assigned = await assignedFor(wanted.point, requested, ctx);
    wanted.route = assigned.route;
    date = assigned.date;
    if (assigned.warning && !isBlank(item.estimated_delivery_date)) extraWarnings.push(assigned.warning);
  }

  const payload = {
    ...contactSnapshot(wanted.point),
    owner: ctx.userId,
    status: 'pending',
    route: wanted.route.id,
    contact: wanted.point.id,
    pickup: pickup.id,
    delivery_type: deliveryType.id,
    estimated_delivery_date: date,
    units: wanted.units,
    kilograms: wanted.kilograms,
    fragile: Boolean(wanted.fragile),
    comments: wanted.comments || null,
    provider_order_number: wanted.provider_order_number || externalId,
    lines: wanted.lines || [],
  };
  await memberRules.memberOrderPayload(strapi, payload, ctx.userId, {
    creating: true,
    permissions: ctx.permissions,
  });
  payload.owner = ctx.userId;
  payload.status = 'pending';
  const missingField = orderRules.missingOrderFields(payload);
  if (missingField) reject('INVALID', missingField);
  await orderRules.applyLateFlags(payload, ctx.user);

  if (ctx.dryRun) {
    const out = await dryRunOut({ ...payload, route: wanted.route });
    return { result: 'created', ...out, warnings: [...extraWarnings, ...out.warnings] };
  }
  const refId = await refs.reserve(ctx.userId, 'order', externalId);
  if (!refId) reject('BUSY', "Aquest external_id ja s'està desant en una altra petició");
  let created;
  try {
    created = await strapi.service(ORDER).create({ data: payload });
    await refs.complete(refId, 'order', created.id, { requested_date: requested });
  } catch (error) {
    if (created)
      await strapi.db
        .query(ORDER)
        .delete({ where: { id: created.id } })
        .catch(() => {});
    await refs.release(refId);
    throw error;
  }
  const order = await loadOrder(created.id);
  return { result: 'created', ...orderOut(order), warnings: [...extraWarnings, ...warningsOf(order)] };
}

/** The fields of an update that differ from the stored order. */
function changesOf(wanted, stored, item, { requestedDate = null } = {}) {
  const payload = {};
  const changed = [];
  const set = (field, value, label = field) => {
    payload[field] = value;
    changed.push(label);
  };
  if (wanted.route && wanted.route.id !== idOf(stored.route)) set('route', wanted.route.id);
  if (wanted.point && wanted.point.id !== idOf(stored.contact))
    set('contact', wanted.point.id, 'delivery_point');
  if (wanted.pickup && wanted.pickup.id !== idOf(stored.pickup)) set('pickup', wanted.pickup.id);
  if ('units' in wanted && wanted.units !== Number(stored.units)) set('units', wanted.units);
  if ('kilograms' in wanted && wanted.kilograms !== Number(stored.kilograms))
    set('kilograms', wanted.kilograms);
  if (
    'refrigerated' in wanted &&
    wanted.refrigerated !== Boolean(stored.delivery_type && stored.delivery_type.refrigerated)
  ) {
    changed.push('refrigerated');
  }
  if ('fragile' in wanted && wanted.fragile !== Boolean(stored.fragile)) set('fragile', wanted.fragile);
  if (
    'comments' in wanted &&
    (wanted.comments || null) !== (isBlank(stored.comments) ? null : String(stored.comments).trim())
  ) {
    set('comments', wanted.comments, 'notes');
  }
  if (
    'provider_order_number' in wanted &&
    (wanted.provider_order_number || null) !==
      (isBlank(stored.provider_order_number) ? null : String(stored.provider_order_number).trim())
  ) {
    set('provider_order_number', wanted.provider_order_number);
  }
  if ('lines' in wanted && lineKey(wanted.lines) !== lineKey(stored.lines)) set('lines', wanted.lines);
  // the day asked: the stored one, or the one asked before it moved to a later route day
  const day = isBlank(item.estimated_delivery_date) ? null : String(item.estimated_delivery_date).trim();
  if (day && day !== ymd(stored.estimated_delivery_date) && day !== ymd(requestedDate)) {
    changed.push('estimated_delivery_date');
  }
  return { payload, changed };
}

async function updateOrder(item, stored, ctx) {
  const wanted = await wantedOf(item, ctx);
  const ref = stored.ref || {};
  const { payload, changed } = changesOf(wanted, stored, item, { requestedDate: ref.requestedDate });
  if (!changed.length) return { result: 'unchanged', ...orderOut(stored) };
  refuseIfNotPending(stored);

  if (changed.includes('refrigerated'))
    payload.delivery_type = (await deliveryTypeOf(wanted.refrigerated, ctx.lookups)).id;
  const route = wanted.route || (await ctx.lookups.routes()).find((r) => r.id === idOf(stored.route));
  const warnings = [];
  let requested;
  if (!wanted.route && (changed.includes('estimated_delivery_date') || changed.includes('delivery_point'))) {
    // a new day, or a point in another town: the route and day are assigned again
    const dateSent = changed.includes('estimated_delivery_date');
    const before = ymd(ref.requestedDate) || ymd(stored.estimated_delivery_date);
    requested = dateSent
      ? await requestedDayOf(item.estimated_delivery_date, ctx, { moving: true })
      : moment.max(moment(before, 'YYYY-MM-DD'), moment(tomorrow(), 'YYYY-MM-DD')).format('YYYY-MM-DD');
    const point = wanted.point || (await loadPoint(idOf(stored.contact)));
    const assigned = await assignedFor(point, requested, ctx);
    if (assigned.warning && dateSent) warnings.push(assigned.warning);
    if (assigned.route.id !== idOf(stored.route)) {
      payload.route = assigned.route.id;
      changed.push('route');
    }
    const at = changed.indexOf('estimated_delivery_date');
    if (assigned.date !== ymd(stored.estimated_delivery_date)) {
      payload.estimated_delivery_date = assigned.date;
      if (at < 0) changed.push('estimated_delivery_date');
    } else if (at >= 0) {
      changed.splice(at, 1);
    }
    if (!changed.length) {
      // another day asked that lands on the same route day: nothing to write
      if (!ctx.dryRun && ref.id) await refs.setRequestedDate(ref.id, requested);
      return { result: 'unchanged', ...orderOut(stored), warnings };
    }
  } else if (changed.includes('estimated_delivery_date')) {
    payload.estimated_delivery_date = await deliveryDateOf(item.estimated_delivery_date, route, ctx, {
      moving: true,
    });
  } else if (changed.includes('route')) {
    // the stored date has to be a day of the new route
    const day = ymd(stored.estimated_delivery_date);
    const closures = await loadRouteClosures(day, day);
    if (!routeRunsOn(route, day, closures)) {
      reject('DATE_NOT_ON_ROUTE', `La ruta ${route.name} no surt el ${dayText(day)}: envia també la data`, {
        field: 'estimated_delivery_date',
        next_route_day: await nextRouteDay(route, { after: today() }),
      });
    }
  }
  if (payload.contact) Object.assign(payload, contactSnapshot(wanted.point));

  await memberRules.memberOwnOrderUpdate(strapi, stored, payload, ctx.userId, ctx.permissions);
  if (payload.estimated_delivery_date) await orderRules.applyLateFlags(payload, ctx.user, stored);

  if (ctx.dryRun) {
    const repriced = 'price' in payload;
    const newRoute = payload.route
      ? (await ctx.lookups.routes()).find((r) => r.id === payload.route)
      : stored.route;
    const out = await dryRunOut(
      { ...stored, ...payload, route: newRoute, ...(repriced ? {} : { price: stored.price }) },
      stored,
    );
    return {
      result: 'updated',
      ...out,
      order_id: stored.id,
      changed,
      warnings: [...warnings, ...out.warnings],
    };
  }
  await strapi.service(ORDER).update(stored.documentId, { data: payload });
  if (requested !== undefined && ref.id) await refs.setRequestedDate(ref.id, requested);
  const order = await loadOrder(stored.id);
  return { result: 'updated', ...orderOut(order), changed, warnings: [...warnings, ...warningsOf(order)] };
}

/**
 * What a dry run answers for an order not written: its price from the rate,
 * without the multidelivery and volume discounts (they depend on her other
 * orders and are worked out when it is saved).
 */
async function dryRunOut(payload, previous = null) {
  const priced = { ...payload, multidelivery_discount: 0, volume_discount: 0 };
  if (!previous || priced.price === null || priced.price === undefined) {
    await fillMissingPrice(priced, previous && { ...previous, price: null });
  }
  const out = orderOut({ id: null, status: 'pending', ...priced });
  return {
    ...out,
    order_id: null,
    // the transfer between warehouses is worked out when the order is saved
    transfer: previous ? Boolean(previous.transfer) : null,
    warnings: [
      ...warningsOf(priced),
      {
        code: 'PRICE_ESTIMATE',
        message:
          'Preu estimat, sense els descomptes per multientrega i per volum, que es calculen en desar-la',
      },
    ],
  };
}

/** POST /orders/cancel, one order. */
async function cancelOrder(item, externalId, ctx) {
  const stored = await storedOrder(externalId, ctx);
  if (!stored) return { result: 'not_found', message: 'No tens cap comanda amb aquest external_id' };
  if (stored.status === 'cancelled') return { result: 'already_cancelled', ...orderOut(stored) };
  if (stored.status !== 'pending') {
    reject(
      'ORDER_LOCKED',
      `La comanda ja està ${LOCK_MESSAGES[stored.status] || stored.status} i no es pot anul·lar. Parla amb l'oficina.`,
      orderOut(stored),
    );
  }
  const payload = { status: 'cancelled' };
  await memberRules.memberOwnOrderUpdate(strapi, stored, payload, ctx.userId, ctx.permissions);
  if (ctx.dryRun) return { result: 'cancelled', ...orderOut({ ...stored, status: 'cancelled' }) };
  await strapi.service(ORDER).update(stored.documentId, { data: payload });
  return { result: 'cancelled', ...orderOut(await loadOrder(stored.id)) };
}

/** GET /orders?external_id=…: the state of her orders. */
async function lookupOrders(externalIds, userId) {
  const found = await refs.findRefs(userId, 'order', externalIds);
  const out = [];
  for (const externalId of externalIds) {
    const ref = found.get(externalId);
    const order = ref && ref.target ? await loadOrder(ref.target) : null;
    if (!order || idOf(order.owner) !== userId) {
      out.push({ external_id: externalId, found: false });
      continue;
    }
    out.push({
      external_id: externalId,
      found: true,
      ...orderOut(order),
      delivery_date: ymd(order.delivery_date),
      units: Number(order.units),
      kilograms: Number(order.kilograms),
      provider_order_number: order.provider_order_number || null,
    });
  }
  return out;
}

module.exports = { syncOrder, cancelOrder, lookupOrders, changesOf, linesOf, lineKey, orderOut };
