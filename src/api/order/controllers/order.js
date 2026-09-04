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
const crypto = require('crypto');
const moment = require('moment');
const sharp = require('sharp');
const QRCode = require('qrcode');
const PDFMerge = require('pdf-merge');
const MicroInvoiceOrder = require('../../../../utils/microinvoice-order');
const { createCoreController } = require('@strapi/strapi').factories;
const { adaptQuery, adaptCtxQuery } = require('../../../services/query-adapter');
const { rawExecute } = require('../../../services/raw-sql');

// Whitelist of relations needed by OrdersTable.vue (omits emitted_invoice: ~96% of payload).
const TABLE_POPULATE = ['route', 'owner', 'contact', 'pickup', 'delivery_type', 'contact_legal_form'];

/**
 * Enforce the next-day cutoff: orders targeting tomorrow's delivery cannot be
 * created past the configured cutoff hour, unless the user has `orders_admin`.
 * Cutoff read from me.orders_options.next_day_limit_hour (default 14).
 */
const assertWithinNextDayCutoff = async (ctx) => {
  const { estimated_delivery_date } = ctx.request.body || {};
  if (!estimated_delivery_date) return true;

  const now = moment();
  const tomorrow = moment().add(1, 'day');
  if (!moment(estimated_delivery_date).isSame(tomorrow, 'day')) return true;

  // Admins (orders_admin) are exempt
  if (ctx.state.user) {
    const user = await strapi.db
      .query('plugin::users-permissions.user')
      .findOne({ where: { id: ctx.state.user.id }, populate: { permissions: true } });
    const isAdmin =
      user &&
      Array.isArray(user.permissions) &&
      user.permissions.some((p) => p.permission === 'orders_admin');
    if (isAdmin) return true;
  }

  let nextDayLimitHour = 14;
  try {
    const meSettings = await strapi.documents('api::me.me').findFirst();
    if (meSettings && meSettings.orders_options && meSettings.orders_options.next_day_limit_hour != null) {
      nextDayLimitHour = meSettings.orders_options.next_day_limit_hour;
    }
  } catch {
    // fall back to default 14
  }

  if (now.hour() >= nextDayLimitHour) {
    ctx.badRequest(
      `No es pot crear la comanda: s'ha superat l'hora límit (${nextDayLimitHour}h) per a entregues del dia següent.`,
    );
    return false;
  }
  return true;
};

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
      populate: TABLE_POPULATE.reduce((acc, p) => {
        acc[p] = true;
        return acc;
      }, {}),
      limit: opts.pagination?.limit,
      offset: opts.pagination?.start,
      orderBy: opts.sort,
    });
    return entities;
  },

  /**
   * GET /api/orders/infoall
   * Aggregated order info (counts, prices, routes) filtered by year/month.
   */
  async infoAll(ctx) {
    const { year, month, ...query } = ctx.query;
    if (year && !isNaN(year)) {
      query.estimated_delivery_date_gte = `${year}-01-01`;
      query.estimated_delivery_date_lte = `${year}-12-31`;
    }
    if (month && !isNaN(month)) {
      query.estimated_delivery_date_gte = `${year}-${String(month).padStart(2, '0')}-01`;
      const lastDay = moment(`${year}-${month}`, 'YYYY-MM').daysInMonth();
      query.estimated_delivery_date_lte = `${year}-${String(month).padStart(2, '0')}-${String(lastDay).padStart(2, '0')}`;
    }

    const opts = adaptQuery(query);
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
      limit: opts.pagination?.limit,
      offset: opts.pagination?.start,
      orderBy: opts.sort,
    });

    const ordersInfo = orders
      .filter((o) => o.status !== 'cancelled')
      .map((o) => {
        const date = o.estimated_delivery_date || o.delivery_date || o.route_date;
        return {
          id: o.id,
          count: 1,
          owner: o.owner ? o.owner.fullname || o.owner.username : '-',
          contact_id: o.contact ? o.contact.id : '-',
          contact: o.contact ? o.contact.name : '-',
          city: o.contact_city || '-',
          units: o.units || 0,
          kilograms: o.kilograms || 0,
          created_at: o.created_at,
          route: o.route ? o.route.short_name || o.route?.name : '-',
          refrigerated: o.refrigerated,
          fragile: o.fragile,
          route_rate: o.route_rate ? o.route_rate.name : '-',
          price:
            ((o.price || 0) - (o.volume_discount || 0)) *
            (1 - (o.multidelivery_discount || 0) / 100) *
            (1 - (o.contact_pickup_discount || 0) / 100),
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

    let filtered = ordersInfo;
    if (year) filtered = filtered.filter((o) => o.year === String(year));
    if (month) filtered = filtered.filter((o) => parseInt(o.month) === parseInt(month));
    return filtered;
  },

  /**
   * POST /api/orders/csv
   * Bulk order creation from CSV import with contact resolution.
   */
  async createCSV(ctx) {
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
   */
  async invoice(ctx) {
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
      limit: -1,
    });
    log('ORDERS_FETCHED', `${ordersEntities.length} orders loaded`);

    const uniqueOwners = [...new Set(ordersEntities.map((o) => o.owner?.id).filter(Boolean))];
    log('OWNERS_IDENTIFIED', `${uniqueOwners.length} unique owners`);

    const paymentMethods = await strapi.db.query('api::payment-method.payment-method').findMany({});
    const paymentMethod = paymentMethods.length > 0 ? paymentMethods[0].id : null;

    const allContacts = await strapi.db.query('api::contact.contact').findMany({ limit: -1 });
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
        const contactOrders = ordersEntities.filter((o) => o.owner?.id === owner);
        const firstDate = contactOrders[0]?.route_date || new Date();
        const monthName = moment(firstDate).locale('ca').format('MMMM');
        const yr = moment(firstDate).format('YYYY');
        const documentConcept = `Serveis logístics ${monthName} ${yr}`;

        const invoice = await strapi.service('api::emitted-invoice.emitted-invoice').create({
          data: {
            emitted: new Date(),
            serial: serials[0].id,
            contact: contact.id,
            verifactu: verifactuEnabled,
            payment_method: paymentMethod,
            document_concept: documentConcept,
            lines: contactOrders.map((o) => ({
              concept: `Comanda ${o.estimated_delivery_date} | ${o.id.toString().padStart(4, '0')} | ${o.route?.name}`,
              base: o.price - (o.volume_discount || 0),
              quantity: 1,
              price: o.price,
              vat: 21,
              irpf: 0,
              discount: (o.multidelivery_discount || 0) + (o.contact_pickup_discount || 0),
            })),
            projects: [project],
            publishedAt: new Date(),
          },
        });
        return { invoice, contact, contactOrders, owner };
      }),
    );
    log('INVOICES_CREATED', `${invoicesByOwner.length} invoices created`);

    // Bulk update order status via parameterized raw SQL (lifecycle bypass)
    for (const { invoice, contactOrders } of invoicesByOwner) {
      const ids = contactOrders.map((o) => o.id);
      if (ids.length === 0) continue;
      const placeholders = ids.map(() => '?').join(',');
      await rawExecute(
        strapi,
        `UPDATE orders SET emitted_invoice = ?, emitted_invoice_datetime = NOW(), status = 'invoiced', updated_at = NOW() WHERE id IN (${placeholders})`,
        [invoice.id, ...ids],
      );
    }

    // Update project phases with income lines
    for (const p of [project]) {
      const proj = projectCache[p];
      const phase = proj.project_phases[proj.project_phases.length - 1];
      for (const { invoice, contact, contactOrders } of invoicesByOwner) {
        let price = 0;
        for (const o of contactOrders) {
          price +=
            ((o.price || 0) - (o.volume_discount || 0)) *
            (1 - (o.multidelivery_discount || 0) / 100) *
            (1 - (o.contact_pickup_discount || 0) / 100);
        }
        if (!phase.incomes) phase.incomes = [];
        phase.incomes.push({
          concept: `Factura #${invoice.code}# - ${contact.trade_name || contact.name}`,
          quantity: 1,
          amount: price,
          total_amount: price,
          date: new Date(),
          income_type: 1,
          invoice: invoice.id,
          paid: true,
          date_estimate_document: new Date(),
          vat_pct: 21,
        });
      }
      await strapi.db.query('api::project.project').update({
        where: { id: p },
        data: { project_phases: proj.project_phases },
      });
    }
    log('COMPLETE', `Total time: ${Date.now() - startTime}ms`);

    return { orders: orderIds, invoices: invoicesByOwner.map((x) => x.invoice), timings };
  },

  /**
   * POST /api/orders/pdf
   * Generates a merged PDF of multiple order documents (QR codes, logos, box labels).
   */
  async pdfmultiple(ctx) {
    const { orders: orderIds } = ctx.request.body;
    const ordersEntities = await strapi.db.query('api::order.order').findMany({
      where: { id: { $in: orderIds } },
      populate: { owner: true, contact: true, route: true, pickup: true, contact_legal_form: true },
    });

    const me = await strapi.documents('api::me.me').findFirst();
    const config = await strapi.documents('api::config.config').findFirst();

    const qrWidth = 96;
    const logoWidth = 100;
    const logoUrl = `./public${me.logo?.url || ''}`;
    let logo = logoUrl;
    if (logoUrl.endsWith('.svg')) {
      logo = './public/uploads/invoice-logo.jpg';
      await sharp(logoUrl).png().toFile(logo);
    }

    const urls = [];
    for (const order of ordersEntities) {
      const qrCodeImage = await QRCode.toDataURL(`${config.front_url}order/view/${order.id}`);
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
            image: { path: logo, width: logoWidth, height: me.logo?.height ? me.logo.height / ratio : 100 },
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
          },
        },
      });

      if (!fs.existsSync('./public/uploads/orders')) {
        fs.mkdirSync('./public/uploads/orders', { recursive: true });
      }
      const hash = crypto
        .createHash('md5')
        .update(`${myInvoice.options.data.invoice.name}-${order.created_at}-${order.id}`)
        .digest('hex');
      const docName = `./public/uploads/orders/${order.id}-H${hash.substring(16)}.pdf`;
      await myInvoice.generate(docName);
      urls.push(docName);
    }

    await new Promise((resolve) => setTimeout(resolve, 0));
    const fileName =
      orderIds.length === 1 ? orderIds[0] : crypto.createHash('md5').update(orderIds.join('-')).digest('hex');
    const mergedPdf = await PDFMerge(urls, { output: 'Buffer' });
    const mergedPdfPath = `./public/uploads/orders/orders-${fileName}.pdf`;
    fs.writeFileSync(mergedPdfPath, mergedPdf);
    return { urls: mergedPdfPath.substring('./public'.length) };
  },

  /**
   * POST /api/orders/check-multidelivery
   * Returns the multidelivery discount if other orders exist for the same contact+date.
   */
  async checkMultidelivery(ctx) {
    const { id, date, contactId, ownerId } = ctx.request.body;
    const owner = await strapi.db.query('plugin::users-permissions.user').findOne({ where: { id: ownerId } });
    const ownerFactor = owner?.multidelivery_discount === false ? 0 : 1;
    const me = await strapi.documents('api::me.me').findFirst();

    const ordersOfDateAndContact = await strapi.db.query('api::order.order').findMany({
      where: {
        estimated_delivery_date: moment(date).format('YYYY-MM-DD'),
        contact: contactId,
      },
      limit: -1,
    });

    const others = id
      ? ordersOfDateAndContact.filter((o) => String(o.id) !== String(id) && o.status !== 'cancelled')
      : ordersOfDateAndContact;

    return {
      multidelivery_discount:
        others.length > 0 ? ownerFactor * (me.orders_options?.multidelivery_discount || 0) : 0,
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
        .findMany({ where: { city: cities[0].id }, populate: { route: true }, limit: -1 });
      if (!cityRoutes.length) return [];

      const routeIds = cityRoutes
        .map((cr) => (typeof cr.route === 'object' ? cr.route?.id : cr.route))
        .filter((rid) => rid != null && typeof rid === 'number');
      if (!routeIds.length) return [];

      const routes = await strapi.db
        .query('api::route.route')
        .findMany({ where: { id: { $in: routeIds }, active: true }, limit: -1 });
      return routes || [];
    } catch (error) {
      console.error('Error fetching collection point routes:', error);
      return ctx.badRequest('Error fetching collection point routes');
    }
  },

  /**
   * Override core create: enforce next-day cutoff + set tracking user.
   */
  async create(ctx) {
    if (!ctx.request.body._tracking_user && ctx.state.user) {
      ctx.request.body._tracking_user = ctx.state.user;
    }
    const allowed = await assertWithinNextDayCutoff(ctx);
    if (!allowed) return;
    return super.create(ctx);
  },

  /**
   * Override core update: set tracking user.
   */
  async update(ctx) {
    if (!ctx.request.body._tracking_user && ctx.state.user) {
      ctx.request.body._tracking_user = ctx.state.user;
    }
    return super.update(ctx);
  },
}));

/**
 * Computes finalPrice: base price with multidelivery + pickup discounts (percent)
 * and volume discount (fixed) — ported verbatim from the v3 afterFind hook.
 */
function applyFinalPrice(order) {
  let price = order.price || 0;
  price = price * (1 - (order.multidelivery_discount || 0) / 100);
  price = price * (1 - (order.contact_pickup_discount || 0) / 100);
  price = price - (order.volume_discount || 0);
  order.finalPrice = price;
}
