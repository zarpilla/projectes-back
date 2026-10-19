'use strict';
/* global strapi */ // strapi is injected by the framework at runtime.

/**
 * order controller (v5). Ported from v3 api/orders/controllers/orders.js (956 LOC).
 * Custom endpoints: table, infoAll, createCSV, invoice, pdfmultiple,
 * checkMultidelivery, collectionPointRoutes. Core create/update overridden to
 * enforce next-day cutoff + tracking user.
 *
 * Data-access migration: strapi.query -> strapi.db.query / Document Service;
 * strapi.connections.default.raw -> rawExecute (parameter-bound);
 * strapi.services.x -> strapi.service('api::x.x'); sanitizeEntity removed.
 */
const fs = require('fs');
const { resolvePdfLogo } = require('../../../services/pdf-logo');
const crypto = require('crypto');
const moment = require('moment');
const { orderLineConcept, invoiceConcept } = require('../services/invoice-line-concept');
const sharp = require('sharp');
const QRCode = require('qrcode');
const { PDFDocument } = require('pdf-lib');
const MicroInvoiceOrder = require('../../../../utils/microinvoice-order');
const { createCoreController } = require('@strapi/strapi').factories;
const {
  applyFinalPrice,
  applyFinalPriceToAll,
  orderDiscountedPrice,
  orderInvoiceLine,
} = require('../services/final-price');
const { adaptQuery, adaptCtxQuery, dbLimit } = require('../../../services/query-adapter');
const { statsDateRange } = require('../../../services/stats-date-range');
const { rawExecute } = require('../../../services/raw-sql');
const { getMe, frontUrlOf } = require('../../../services/me-settings');
const { numericId } = require('../../../middlewares/v3-compat');
const { processIncidences } = require('../services/order-incidences');
const { depositRefusal } = require('../services/deposit-guard');
const { addContactSnapshot } = require('../services/contact-snapshot');
const changeLog = require('../../../services/change-log');
const { orderTotals, TOTALS_SELECT } = require('../services/order-totals');
const { currentOrderVolumeDiscount } = require('../services/volume-discount');

// Whitelist of relations needed by OrdersTable.vue (omits emitted_invoice: ~96% of payload).
// collection_point and route_rate: the quick edit picks the rate with them; an
// order picked up at a farm through a collection point looked like a farm
// pickup without one and got no rate (issues/151)
const TABLE_POPULATE = ['route', 'owner', 'contact', 'pickup', 'delivery_type', 'contact_legal_form', 'route_rate'];
const TABLE_POPULATE_SELECT = { collection_point: { select: ['id'] } };

// The permissions that skip the delivery date rules: the logistics office and
// the entity's staff.
const DATE_RULES_EXEMPT = ['orders_admin', 'projects', 'admin'];

const orderPayloadOf = (body) =>
  body && typeof body === 'object' && body.data && typeof body.data === 'object' ? body.data : body || {};

async function exemptFromDateRules(user) {
  if (!user) return false;
  const row = await strapi.db
    .query('plugin::users-permissions.user')
    .findOne({ where: { id: user.id }, populate: { permissions: true } });
  return Boolean(
    row &&
    Array.isArray(row.permissions) &&
    row.permissions.some((p) => DATE_RULES_EXEMPT.includes(p.permission)),
  );
}

async function nextDayLimitHour() {
  try {
    const meSettings = await getMe();
    if (meSettings && meSettings.orders_options && meSettings.orders_options.next_day_limit_hour != null) {
      return meSettings.orders_options.next_day_limit_hour;
    }
  } catch {
    // fall back to the default
  }
  return 14;
}

/**
 * Why a member can't deliver an order on `date`, or null when she can: not
 * today nor in the past, and not tomorrow past the cutoff hour
 * (me.orders_options.next_day_limit_hour, default 14). The office and the
 * entity's staff are exempt.
 *
 * It read only the unwrapped (v3) body and ran only on create: what the front
 * sends (`{ data }`), a date change and the CSV import skipped it, and orders
 * for today or the past went through (issues/168).
 */
async function deliveryDateRefusal(date, user) {
  if (!date) return null;
  const day = moment(date);
  if (!day.isValid()) return null;
  const tomorrow = moment().add(1, 'day');
  if (!day.isBefore(tomorrow, 'day') && !day.isSame(tomorrow, 'day')) return null;
  if (await exemptFromDateRules(user)) return null;
  if (day.isBefore(tomorrow, 'day')) {
    return "No es pot crear la comanda: la data d'entrega ha de ser a partir de demà.";
  }
  const limit = await nextDayLimitHour();
  if (moment().hour() >= limit) {
    return `No es pot crear la comanda: s'ha superat l'hora límit (${limit}h) per a entregues del dia següent.`;
  }
  return null;
}

module.exports = createCoreController('api::order.order', ({ strapi }) => ({
  /**
   * find override — ports the v3 afterFind hook (removed in v5): computes the
   * finalPrice field on every order (multidelivery + pickup discounts, volume).
   */
  async find(ctx) {
    adaptCtxQuery(ctx);
    const response = await super.find(ctx);
    const rows = response?.data;
    if (Array.isArray(rows)) {
      for (const entry of rows) {
        const attrs = entry?.attributes || entry;
        if (attrs) applyFinalPrice(attrs);
      }
    }
    return response;
  },

  /**
   * findOne override — same finalPrice computation for single-order reads.
   */
  async findOne(ctx) {
    const response = await super.findOne(ctx);
    const attrs = response?.data?.attributes || response?.data;
    if (attrs) applyFinalPrice(attrs);
    return response;
  },

  /**
   * GET /api/orders/table
   * Lightweight list with restricted populate (drops emitted_invoice).
   */
  async table(ctx) {
    const opts = adaptQuery(ctx.query);
    const entities = await strapi.db.query('api::order.order').findMany({
      where: opts.filters || {},
      populate: TABLE_POPULATE.reduce(
        (acc, p) => {
          acc[p] = true;
          return acc;
        },
        { ...TABLE_POPULATE_SELECT },
      ),
      limit: dbLimit(opts),
      offset: opts.pagination?.start,
      orderBy: opts.sort,
    });
    // The orders list reads this endpoint, and its Preu column renders
    // `finalPrice`. v3 got it from an afterFind hook that ran on every query;
    // without this the column showed "?" on every row.
    return applyFinalPriceToAll(entities);
  },

  /**
   * GET /api/orders/totals — the figures above the orders list over every
   * order matching the same filters as /orders/table, not one page (issues/177).
   */
  async totals(ctx) {
    const opts = adaptQuery(ctx.query);
    const rows = await strapi.db.query('api::order.order').findMany({
      where: opts.filters || {},
      select: TOTALS_SELECT,
      populate: { pickup: { select: ['id', 'pickup'] } },
    });
    return orderTotals(rows);
  },

  /**
   * GET /api/orders/infoall
   * Aggregated order info (counts, prices, routes) filtered by year/month.
   */
  async infoAll(ctx) {
    const { year, month, _group, ...query } = ctx.query;
    const range = statsDateRange(year, month);
    if (range) {
      query.estimated_delivery_date_gte = range.from;
      query.estimated_delivery_date_lte = range.to;
    }

    const opts = adaptQuery(query);
    // the period of an order, and whether it is in the asked year / month
    const dateOf = (o) => o.estimated_delivery_date || o.delivery_date || o.route_date;
    const inPeriod = (date) =>
      (!year || moment(date).format('YYYY') === String(year)) &&
      (!month || parseInt(moment(date).format('MM')) === parseInt(month));

    // _group=route: only the number of orders per route (the incidences report's
    // rate per 100 orders), without loading every order with its relations
    if (_group === 'route') {
      const light = await strapi.db.query('api::order.order').findMany({
        where: opts.filters || {},
        select: ['id', 'status', 'estimated_delivery_date', 'delivery_date', 'route_date'],
        populate: { route: { select: ['id', 'short_name', 'name'] } },
      });
      const counts = new Map();
      for (const o of light) {
        if (o.status === 'cancelled' || !inPeriod(dateOf(o))) continue;
        const route = o.route ? o.route.short_name || o.route.name : '-';
        counts.set(route, (counts.get(route) || 0) + 1);
      }
      return [...counts.entries()].map(([route, count]) => ({ route, count }));
    }

    const orders = await strapi.db.query('api::order.order').findMany({
      where: opts.filters || {},
      populate: {
        owner: true,
        contact: true,
        route: true,
        route_rate: true,
        pickup: true,
        delivery_type: true,
      },
      limit: dbLimit(opts),
      offset: opts.pagination?.start,
      orderBy: opts.sort,
    });

    const ordersInfo = orders
      .filter((o) => o.status !== 'cancelled')
      .map((o) => {
        const date = dateOf(o);
        return {
          id: o.id,
          count: 1,
          owner: o.owner ? o.owner.fullname || o.owner.username : '-',
          contact_id: o.contact ? o.contact.id : '-',
          contact: o.contact ? o.contact.name : '-',
          city: o.contact_city || '-',
          units: o.units || 0,
          kilograms: o.kilograms || 0,
          created_at: o.createdAt,
          route: o.route ? o.route.short_name || o.route?.name : '-',
          refrigerated: o.refrigerated,
          fragile: o.fragile,
          route_rate: o.route_rate ? o.route_rate.name : '-',
          // the invoice's amount (issues/145)
          price: orderDiscountedPrice(o),
          pickup: o.pickup ? o.pickup.name : '-',
          delivery_type: o.delivery_type ? o.delivery_type.name : '-',
          status: o.status,
          lastmile: o.last_mile ? 'Sí' : 'No',
          date,
          month: moment(date).format('MM'),
          year: moment(date).format('YYYY'),
          multidelivery: o.multidelivery_discount ? 'Sí' : 'No',
          pickup_discount: o.contact_pickup_discount ? 'Sí' : 'No',
        };
      });

    return ordersInfo.filter((o) => inPeriod(o.date));
  },

  /**
   * POST /api/orders/csv
   * Bulk order creation from CSV import with contact resolution.
   */
  async createCSV(ctx) {
    const refusal = await deliveryDateRefusal(ctx.request.body?.estimated_delivery_date, ctx.state.user);
    if (refusal) return ctx.badRequest(refusal);
    const order = { ...ctx.request.body };
    delete order.id;
    order.pickup = order.pickup?.id;
    order.delivery_type = order.delivery_type?.id;
    order.owner = order.owner?.id;
    order.route = order.route?.id;
    order.route_rate = order.route_rate?.id;
    order.status = 'pending';
    order.comments = order.notes;

    if (order.contact && order.contact.id) {
      order.contact = order.contact.id;
    } else if (order.contact) {
      // a delivery point needs a trade name (issues/215): the file's name stands in
      if (!order.contact.trade_name || !String(order.contact.trade_name).trim()) {
        order.contact.trade_name = order.contact.name;
      }
      for (const f of ['time_slot_1_ini', 'time_slot_1_end', 'time_slot_2_ini', 'time_slot_2_end']) {
        if (!order.contact[f]) order.contact[f] = null;
      }
      if (!order.contact.contact_nif) {
        order.contact.owner = order.owner;
        const created = await strapi.service('api::contact.contact').create({
          data: { ...order.contact, publishedAt: new Date() },
        });
        order.contact = created.id;
      } else {
        order.contact.contact_nif = order.contact.contact_nif.trim();
        const found = await strapi.db.query('api::contact.contact').findMany({
          where: { owner: order.owner, nif: order.contact.nif },
          limit: 1,
        });
        if (found.length > 0) {
          order.contact = found[0].id;
        } else {
          order.contact.owner = order.owner;
          const created = await strapi.service('api::contact.contact').create({
            data: { ...order.contact, publishedAt: new Date() },
          });
          order.contact = created.id;
        }
      }
    }
    for (const f of [
      'contact_time_slot_1_ini',
      'contact_time_slot_1_end',
      'contact_time_slot_2_ini',
      'contact_time_slot_2_end',
    ]) {
      if (!order[f]) order[f] = null;
    }

    const created = await strapi.service('api::order.order').create({
      data: { ...order, publishedAt: new Date() },
    });
    return created;
  },

  /**
   * POST /api/orders/invoice
   * Generates invoices for multiple orders grouped by owner, bulk-updates order
   * status via raw SQL (lifecycle bypass), and pushes income lines to project phases.
   *
   * Serialised through invoiceRunInFlight: a run that overlaps a previous run
   * on the same orders reads them before the first run has stamped them
   * 'invoiced', and would create a duplicate draft invoice for orders that
   * are already invoiced.
   */
  async invoice(ctx) {
    if (invoiceRunInFlight) {
      return ctx.send(
        {
          done: false,
          message: 'Ja hi ha una facturació en curs. Espera que acabi i torna-ho a provar.',
        },
        409,
      );
    }
    invoiceRunInFlight = true;
    try {
      return await invoiceRun(ctx);
    } finally {
      invoiceRunInFlight = false;
    }
  },

  /**
   * POST /api/orders/pdf
   * Generates a merged PDF of multiple order documents (QR codes, logos, box labels).
   */
  async pdfmultiple(ctx) {
    const { orders: orderIds } = ctx.request.body;
    const ordersEntities = await strapi.db.query('api::order.order').findMany({
      where: { id: { $in: orderIds } },
      // lines (component) and the transfer pickups feed the box labels and the
      // route chain below; v5 returns none of them without an explicit populate.
      populate: {
        owner: true,
        contact: true,
        route: true,
        pickup: true,
        contact_legal_form: true,
        lines: true,
        transfer_pickup_origin: true,
        transfer_pickup_destination: true,
      },
    });

    const me = await getMe();
    const frontUrl = frontUrlOf(me, await strapi.documents('api::config.config').findFirst());

    const qrWidth = 96;
    const logoWidth = 100;
    // null when there is no logo or its file is missing: the PDF is drawn without it
    const logo = await resolvePdfLogo(me, { sharp, log: strapi.log });

    const urls = [];
    for (const order of ordersEntities) {
      const qrCodeImage = await QRCode.toDataURL(`${frontUrl}order/view/${order.id}`);
      const contacts = await strapi.db.query('api::contact.contact').findMany({
        where: { users_permissions_user: order.owner?.id },
      });
      if (contacts.length === 0) {
        return ctx.send(
          {
            done: false,
            message: `ERROR. L'usuària ${order.owner?.username} no te cap contacte associat.`,
          },
          500,
        );
      }
      const provider = contacts[0];

      const invoiceHeader = [{ label: 'COMANDA', value: order.id.toString().padStart(4, '0') }];

      let more = order.contact?.notes
        ? order.contact.notes + '\n'
        : order.contact_notes
          ? order.contact_notes + '\n'
          : '';
      more += order.contact_legal_form?.name ? order.contact_legal_form.name + ' - ' : '';
      if (order.fragile) more += 'Fràgil - ';
      if (order.contact_time_slot_1_ini && order.contact_time_slot_1_end) {
        more += `De ${order.contact_time_slot_1_ini}h a ${order.contact_time_slot_1_end}h - `;
      }
      if (order.contact_time_slot_2_ini && order.contact_time_slot_2_end) {
        more += `De ${order.contact_time_slot_2_ini}h a ${order.contact_time_slot_2_end}h`;
      }
      if (more.endsWith(' - ')) more = more.substring(0, more.length - 3);
      order.comments = more + '\n' + (order.comments || '');

      const concept = `${order.route?.name?.trim() || ''}${order.estimated_delivery_date ? ' - ' + order.estimated_delivery_date : ''} - ${order.pickup?.name || ''} ${order.refrigerated ? 'Refrigerada' : ''} - ${order.units} ${order.units > 1 ? 'caixes' : 'caixa'} - ${order.kilograms} kg`;

      const legal = [];
      const parts = [];
      if (order.lines?.length > 0) {
        legal.push({ value: 'RECOLLIDA:', color: 'primary', weight: 'bold' });
        for (const line of order.lines) {
          if (line.units > 0) {
            for (let i = 0; i < line.units; i++) {
              parts.push({
                value: `CAIXA ${i + 1}/${line.units} - ${line.name} - ${line.nif}`,
                color: 'secondary',
              });
            }
          }
        }
      }

      // Movement chain
      const movements = [];
      if (order.pickup) {
        const a = order.pickup.alias || order.pickup.name;
        if (a) movements.push(a);
      }
      if (order.transfer_pickup_origin) {
        const a = order.transfer_pickup_origin.alias || order.transfer_pickup_origin.name;
        if (a && movements[movements.length - 1] !== a) movements.push(a);
      }
      if (order.transfer_pickup_destination) {
        const a = order.transfer_pickup_destination.alias || order.transfer_pickup_destination.name;
        if (a && movements[movements.length - 1] !== a) movements.push(a);
      }
      if (order.route) {
        const rn = order.route.short_name || order.route.name;
        if (rn) movements.push(rn);
      }
      const transferPickupText = movements.length > 1 ? movements.join(' -> ') : null;
      const isTransfer = order.transfer_pickup_origin || order.transfer_pickup_destination;
      const routeLabel = isTransfer ? 'RUTA (TRANSFER)' : 'RUTA';

      const ratio = me.logo?.width ? me.logo.width / logoWidth : 1;
      const myInvoice = new MicroInvoiceOrder({
        style: {
          header: {
            image: logo
              ? { path: logo, width: logoWidth, height: me.logo?.height ? me.logo.height / ratio : 100 }
              : null,
            qr: { path: qrCodeImage, width: qrWidth, height: qrWidth },
          },
        },
        data: {
          pages: order.units,
          invoice: {
            name: 'COMANDA',
            header: [...invoiceHeader],
            currency: 'EUR',
            customer: [
              { label: '', value: [order.estimated_delivery_date], fontSize: 20 },
              { label: '', value: [order.contact?.trade_name], fontSize: 28 },
              {
                label: '',
                value: [
                  order.contact?.address,
                  `${order.contact?.postcode || ''} ${order.contact?.city || ''}`,
                ],
                fontSize: 18,
              },
              {
                label: '',
                value: [
                  `${order.units} ${order.units > 1 ? 'caixes' : 'caixa'} - ${order.kilograms} kg${order.refrigerated ? ' - Refrigerada' : ''}`,
                ],
                fontSize: 16,
              },
            ],
            seller: [{ label: 'EMISSORA', value: [me.name, me.phone, me.email].filter(Boolean) }],
            provider: [{ label: 'PROVEÏDORA', value: [provider.name] }],
            transfer: transferPickupText ? [{ label: routeLabel, value: [transferPickupText] }] : null,
            notes: [{ label: 'NOTES', value: order.comments }],
            detalls: [],
            legal,
            details: { parts },
            // «Peu de les comandes» (Configuració general), under the issuer line
            footer: me.order_footer,
          },
        },
      });

      if (!fs.existsSync('./public/uploads/orders')) {
        fs.mkdirSync('./public/uploads/orders', { recursive: true });
      }
      const hash = crypto
        .createHash('md5')
        .update(`${myInvoice.options.data.invoice.name}-${order.createdAt}-${order.id}`)
        .digest('hex');
      const docName = `./public/uploads/orders/${order.id}-H${hash.substring(16)}.pdf`;
      await myInvoice.generate(docName);
      urls.push(docName);
    }

    const fileName =
      orderIds.length === 1 ? orderIds[0] : crypto.createHash('md5').update(orderIds.join('-')).digest('hex');
    // Merged in-process: pdf-merge shelled out to pdftk, which the Docker image
    // does not have (issues/036).
    const merged = await PDFDocument.create();
    for (const url of urls) {
      const doc = await PDFDocument.load(fs.readFileSync(url));
      const pages = await merged.copyPages(doc, doc.getPageIndices());
      for (const page of pages) merged.addPage(page);
    }
    const mergedPdf = await merged.save();
    const mergedPdfPath = `./public/uploads/orders/orders-${fileName}.pdf`;
    fs.writeFileSync(mergedPdfPath, mergedPdf);
    return { urls: mergedPdfPath.substring('./public'.length) };
  },

  /**
   * POST /api/orders/check-multidelivery
   * Returns the multidelivery discount if other orders exist for the same contact+date,
   * and, given the route, the volume discount the lifecycle will store (the form
   * previews it, issues/227); absent when the lifecycle keeps the stored one.
   */
  async checkMultidelivery(ctx) {
    const { id, date, contactId, ownerId, routeId, status } = ctx.request.body;
    const owner = await strapi.db.query('plugin::users-permissions.user').findOne({ where: { id: ownerId } });
    const ownerFactor = owner?.multidelivery_discount === false ? 0 : 1;
    const me = await getMe();

    const ordersOfDateAndContact = await strapi.db.query('api::order.order').findMany({
      where: {
        estimated_delivery_date: moment(date).format('YYYY-MM-DD'),
        contact: contactId,
      },
    });

    const others = id
      ? ordersOfDateAndContact.filter((o) => String(o.id) !== String(id) && o.status !== 'cancelled')
      : ordersOfDateAndContact;

    const volumeDiscount = await currentOrderVolumeDiscount(id, {
      route: routeId,
      owner: ownerId,
      estimated_delivery_date: date,
      status: status || 'pending',
    });

    return {
      multidelivery_discount:
        others.length > 0 ? ownerFactor * (me.orders_options?.multidelivery_discount || 0) : 0,
      ...(volumeDiscount === undefined ? {} : { volume_discount: volumeDiscount }),
    };
  },

  /**
   * GET /api/orders/collection-point-routes
   * Returns active routes serving the city of a collection-point contact.
   */
  async collectionPointRoutes(ctx) {
    const { collection_point } = ctx.query;
    if (!collection_point) {
      return ctx.badRequest('collection_point parameter is required');
    }
    try {
      const cpContact = await strapi.db
        .query('api::contact.contact')
        .findOne({ where: { id: collection_point } });
      if (!cpContact?.city) return [];

      const cities = await strapi.db
        .query('api::city.city')
        .findMany({ where: { name: cpContact.city }, limit: 1 });
      if (!cities.length) return [];

      const cityRoutes = await strapi.db
        .query('api::city-route.city-route')
        .findMany({ where: { city: cities[0].id }, populate: { route: true } });
      if (!cityRoutes.length) return [];

      const routeIds = cityRoutes
        .map((cr) => (typeof cr.route === 'object' ? cr.route?.id : cr.route))
        .filter((rid) => rid != null && typeof rid === 'number');
      if (!routeIds.length) return [];

      const routes = await strapi.db
        .query('api::route.route')
        .findMany({ where: { id: { $in: routeIds }, active: true } });
      return routes || [];
    } catch (error) {
      console.error('Error fetching collection point routes:', error);
      return ctx.badRequest('Error fetching collection point routes');
    }
  },

  /**
   * GET /api/orders/:id/history — who changed what on the order, newest first
   * (issues/119). Read from the change log, so it answers for a deleted order
   * too.
   */
  async history(ctx) {
    const id = Number(ctx.params.id);
    if (!Number.isInteger(id) || id <= 0) return ctx.badRequest('Invalid order id');
    const rows = await changeLog.historyOf('api::order.order', id);
    return rows.map(({ id: rowId, action, changes, snapshot, user_id, username, createdAt }) => ({
      id: rowId,
      action,
      changes,
      snapshot,
      user_id,
      username,
      createdAt,
    }));
  },

  /**
   * Override core create: enforce the delivery date rules + set tracking user.
   * An order sent without a state is pending: with none it counted in «Totes»
   * and in no state tab (issues/168). With one too: every order is created
   * pending (the user's decision, 2026-10-19, issues/186).
   */
  async create(ctx) {
    if (!ctx.request.body._tracking_user && ctx.state.user) {
      ctx.request.body._tracking_user = ctx.state.user;
    }
    const payload = orderPayloadOf(ctx.request.body);
    const refusal = await deliveryDateRefusal(payload.estimated_delivery_date, ctx.state.user);
    if (refusal) return ctx.badRequest(refusal);
    payload.status = 'pending';
    return super.create(ctx);
  },

  /**
   * Override core update: set tracking user, and handle the incidences the
   * order form submits inline.
   *
   * OrdersForm sends `incidences` as full objects to create or update, not as
   * relation ids. v5 validates relation payloads BEFORE any lifecycle runs, so
   * the write is rejected with 400 "Invalid relations" and beforeUpdate's
   * `delete data.incidences` never gets to run (v3 validated nothing, so the
   * lifecycle was early enough there). Pull the array off here and apply it
   * after the order itself has saved.
   */
  async update(ctx) {
    if (!ctx.request.body._tracking_user && ctx.state.user) {
      ctx.request.body._tracking_user = ctx.state.user;
    }

    const body = ctx.request.body || {};
    const payload = body.data && typeof body.data === 'object' ? body.data : body;
    // a delivered, invoiced or cancelled order can't be deposited (issues/149)
    const refusal = await depositRefusal(numericId(ctx), payload);
    if (refusal) return ctx.badRequest(refusal);

    // moving the delivery date follows the same rules as a new order (issues/168)
    if (payload.estimated_delivery_date) {
      const stored = await strapi.db
        .query('api::order.order')
        .findOne({ where: { id: numericId(ctx) }, select: ['id', 'estimated_delivery_date'] });
      if (!stored || !moment(stored.estimated_delivery_date).isSame(payload.estimated_delivery_date, 'day')) {
        const dateRefusal = await deliveryDateRefusal(payload.estimated_delivery_date, ctx.state.user);
        if (dateRefusal) return ctx.badRequest(dateRefusal.replace('crear', 'moure'));
      }
    }

    const incidences = Array.isArray(payload.incidences) ? payload.incidences : null;
    if (incidences) delete payload.incidences;

    // a new delivery point without its data (the quick edit): copy the
    // point's data onto the order (issues/157)
    await addContactSnapshot(payload, numericId(ctx));

    const response = await super.update(ctx);

    if (incidences && incidences.length) {
      // The route addresses the order by its numeric id; the compat middleware
      // rewrote the path to the documentId and kept the numeric one on state.
      const orderId = numericId(ctx);
      await processIncidences(orderId, incidences, ctx.state.user);
    }

    return response;
  },
}));

// Guards order.invoice against overlapping runs (one process per tenant in
// fork mode, so a module-level flag covers every request).
let invoiceRunInFlight = false;

/**
 * POST /api/orders/invoice — actual run, reached only through order.invoice,
 * which serialises access. Function declaration: hoisted above the factory.
 */
async function invoiceRun(ctx) {
  const { orders: orderIds, project } = ctx.request.body;
  const startTime = Date.now();
  const timings = {};
  const log = (stage, msg = '') => {
    const elapsed = Date.now() - startTime;
    console.log(`[INVOICE][${elapsed}ms] ${stage}: ${msg}`);
    timings[stage] = elapsed;
  };
  log('START', `Processing ${orderIds.length} orders`);

  const year = new Date().getFullYear();
  const serials = await strapi.db.query('api::serie.serie').findMany({ where: { name: year } });
  if (serials.length === 0) {
    return ctx.send({ done: false, message: `ERROR. No hi ha sèrie per a l'any ${year}` }, 500);
  }
  log('SERIAL_LOADED', `Found serial: ${serials[0].id}`);

  const verifactu = await strapi.documents('api::verifactu.verifactu').findFirst();
  const verifactuEnabled = verifactu?.mode === 'test' || verifactu?.mode === 'real';
  log('VERIFACTU_LOADED');

  const ordersEntities = await strapi.db.query('api::order.order').findMany({
    where: { id: { $in: orderIds } },
    // v3's strapi.query().find() auto-populated first-level relations, so
    // `o.owner.id` and `o.route.name` just worked. v5 omits an unpopulated
    // relation entirely: without this every order had `owner === undefined`,
    // uniqueOwners came out empty, and the endpoint cheerfully created zero
    // invoices — the per-owner loop that would have raised an error never ran.
    populate: { owner: true, route: true, emitted_invoice: true },
  });
  log('ORDERS_FETCHED', `${ordersEntities.length} orders loaded`);

  // Never re-invoice. An order that is already invoiced, or still linked to
  // any invoice, must not enter a new draft: re-running this endpoint on the
  // same selection created a duplicate draft and silently stole the orders'
  // link from the first draft; deleting the duplicate later then reset the
  // shared orders back to 'delivered' (2026-09-30 incident).
  const invoiceable = ordersEntities.filter((o) => o.status !== 'invoiced' && !o.emitted_invoice);
  const skipped = ordersEntities.filter((o) => o.status === 'invoiced' || o.emitted_invoice).map((o) => o.id);
  log('INVOICEABLE', `${invoiceable.length} of ${ordersEntities.length} orders invoiceable`);

  if (invoiceable.length === 0) {
    return ctx.send(
      {
        done: false,
        message: "Les comandes seleccionades ja estan facturades. No s'ha creat cap factura.",
      },
      409,
    );
  }

  const uniqueOwners = [...new Set(invoiceable.map((o) => o.owner?.id).filter(Boolean))];
  log('OWNERS_IDENTIFIED', `${uniqueOwners.length} unique owners`);

  const paymentMethods = await strapi.db.query('api::payment-method.payment-method').findMany({});
  const paymentMethod = paymentMethods.length > 0 ? paymentMethods[0].id : null;

  // `users_permissions_user` is the field the owner lookup below matches on,
  // so it has to be populated for the same reason as the orders above.
  const allContacts = await strapi.db.query('api::contact.contact').findMany({
    populate: { users_permissions_user: true },
  });
  log('CONTACTS_FETCHED', `${allContacts.length} contacts fetched`);

  const contactsByOwnerId = {};
  for (const owner of uniqueOwners) {
    const ownerContacts = allContacts.filter((c) => c.users_permissions_user?.id === owner);
    if (ownerContacts.length === 0) {
      return ctx.send({ done: false, message: `ERROR. No hi ha contactes per a l'usuari ${owner}` }, 500);
    }
    contactsByOwnerId[owner] = ownerContacts[0];
  }
  log('CONTACTS_MAPPED');

  // Cache project data with phases
  const projectCache = {};
  for (const p of [project]) {
    const projectData = await strapi.db.query('api::project.project').findOne({
      where: { id: p },
      populate: {
        project_phases: { populate: { incomes: { populate: { invoice: true, income: true } } } },
      },
    });
    if (!projectData?.project_phases?.length) {
      return ctx.send(
        { done: false, message: `ERROR. No hi ha fases per al projecte ${projectData?.name}` },
        500,
      );
    }
    const phase = projectData.project_phases[projectData.project_phases.length - 1];
    if (!phase.incomes) {
      return ctx.send(
        { done: false, message: `ERROR. No hi ha incomes per a la fase del projecte ${projectData.name}` },
        500,
      );
    }
    projectCache[p] = projectData;
  }
  log('PROJECTS_CACHED');

  // Create invoices per owner in parallel
  log('INVOICE_CREATION_START', `Creating ${uniqueOwners.length} invoices`);
  const invoicesByOwner = await Promise.all(
    uniqueOwners.map(async (owner) => {
      const contact = contactsByOwnerId[owner];
      const contactOrders = invoiceable.filter((o) => o.owner?.id === owner);
      const documentConcept = invoiceConcept(contactOrders);

      const invoice = await strapi.service('api::emitted-invoice.emitted-invoice').create({
        data: {
          emitted: new Date(),
          serial: serials[0].id,
          contact: contact.id,
          verifactu: verifactuEnabled,
          payment_method: paymentMethod,
          document_concept: documentConcept,
          lines: contactOrders.map((o) => ({
            concept: orderLineConcept(o),
            // base and discount from the shared formula (issues/145)
            ...orderInvoiceLine(o),
            quantity: 1,
            price: o.price,
            vat: 21,
            irpf: 0,
          })),
          projects: [project],
          publishedAt: new Date(),
        },
      });
      return { invoice, contact, contactOrders, owner };
    }),
  );
  log('INVOICES_CREATED', `${invoicesByOwner.length} invoices created`);

  // Bulk update order status via parameterized raw SQL (lifecycle bypass).
  // `emitted_invoice` was an FK column on `orders` in v3; in v5 the relation
  // lives in orders_emitted_invoice_lnk and the column no longer exists, so
  // the link has to be rewritten separately from the scalar columns.
  for (const { invoice, contactOrders } of invoicesByOwner) {
    const ids = contactOrders.map((o) => o.id);
    if (ids.length === 0) continue;
    const placeholders = ids.map(() => '?').join(',');
    await rawExecute(
      strapi,
      `UPDATE orders SET emitted_invoice_datetime = NOW(), status = 'invoiced', updated_at = NOW() WHERE id IN (${placeholders})`,
      ids,
    );
    await rawExecute(
      strapi,
      `DELETE FROM orders_emitted_invoice_lnk WHERE order_id IN (${placeholders})`,
      ids,
    );
    await rawExecute(
      strapi,
      `INSERT INTO orders_emitted_invoice_lnk (order_id, emitted_invoice_id) VALUES ${ids
        .map(() => '(?, ?)')
        .join(', ')}`,
      ids.flatMap((id) => [id, invoice.id]),
    );
    // the raw UPDATE skips the change log's middleware (issues/119)
    const invoicedAt = new Date();
    await changeLog.logChanges(
      'api::order.order',
      contactOrders.map((o) => ({
        row: { id: o.id },
        changes: [
          { field: 'status', from: o.status, to: 'invoiced' },
          { field: 'emitted_invoice', from: o.emitted_invoice, to: invoice },
          { field: 'emitted_invoice_datetime', from: o.emitted_invoice_datetime, to: invoicedAt },
        ],
      })),
    );
  }

  // One income line per invoice on the project's last phase. v3 pushed the
  // lines into the populated phase and saved the project, and its project
  // lifecycle wrote them out; in v5 phase incomes are their own collection and
  // that nested update silently wrote nothing, so every draft from this run
  // reached the project without its income line. Create the rows directly.
  //
  // The amount is the invoice's own base, not a recomputation from the
  // orders: v3 compounded the multidelivery and pickup discounts here while
  // the invoice lines add them, so the income drifted from what was billed.
  for (const p of [project]) {
    const proj = projectCache[p];
    const phase = proj.project_phases[proj.project_phases.length - 1];
    for (const { invoice, contact } of invoicesByOwner) {
      const amount = Number(invoice.total_base) || 0;
      await strapi.db.query('api::phase-income.phase-income').create({
        data: {
          concept: `Factura #${invoice.code}# - ${contact.trade_name || contact.name}`,
          quantity: 1,
          amount,
          total_amount: amount,
          date: new Date(),
          income_type: 1,
          invoice: invoice.id,
          paid: false, // pending until the invoice is paid (issues/153)
          date_estimate_document: new Date(),
          vat_pct: 21,
          project_phase: phase.id,
        },
      });
    }
  }
  log('COMPLETE', `Total time: ${Date.now() - startTime}ms`);

  return { orders: orderIds, invoices: invoicesByOwner.map((x) => x.invoice), skipped, timings };
}
