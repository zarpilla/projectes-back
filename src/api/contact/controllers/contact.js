'use strict';

/**
 * contact controller (v5). Ported from v3 api/contacts/controllers/contacts.js.
 * Custom endpoints: basic, orders, withorders, unify.
 *
 * Data-access migration: strapi.query -> strapi.db.query; sanitizeEntity removed.
 */
const { createCoreController } = require('@strapi/strapi').factories;
const { adaptCtxQuery, dbLimit } = require('../../../services/query-adapter');
const { adaptQuery } = require('../../../services/query-adapter');
const { BASIC_POPULATE } = require('../services/contact-populate');
const {
  FOR_ORDERS_FIELDS,
  FOR_ORDERS_POPULATE,
  SOCIES_POPULATE,
} = require('../services/for-orders');

module.exports = createCoreController('api::contact.contact', ({ strapi }) => ({
  // v3 query-param compatibility (P9): translate _limit/_start/_sort/_q/_where
  // and flat field operators to native v5 params before core handling.
  // v5-native queries pass through untouched.
  async find(ctx) {
    adaptCtxQuery(ctx);
    return super.find(ctx);
  },

  /**
   * GET /api/contacts/basic
   * Contacts minus the heavy relation collections.
   */
  async basic(ctx) {
    const opts = adaptQuery(ctx.query);
    const contacts = await strapi.db.query('api::contact.contact').findMany({
      where: opts.filters || {},
      // v3 returned every single-valued relation as an FK column, so the
      // frontend got them for free; v5 omits a relation entirely unless it is
      // populated, and `{ projects: false }` populates NOTHING. ContactsTable
      // renders `row.sector.name`, `row.owner.fullname` and builds its type
      // column from `contact_types`, so all of those came out empty -- the
      // Sector column showed "-" on every row.
      //
      // The heavy collections this endpoint exists to avoid (projects,
      // projectes, collection_points) stay unpopulated.
      populate: BASIC_POPULATE,
      limit: dbLimit(opts),
      offset: opts.pagination?.start,
      orderBy: opts.sort,
    });
    return contacts.map(({ projects, projectes, ...item }) => item);
  },

  /**
   * GET /api/contacts/for-orders
   * The contact list the orders page needs, and nothing more.
   *
   * `?socies=1` narrows to contacts linked to a user and adds the two
   * relations the collection-point lookup walks.
   */
  async forOrders(ctx) {
    const socies = ctx.query.socies === '1' || ctx.query.socies === 'true';
    return strapi.db.query('api::contact.contact').findMany({
      select: FOR_ORDERS_FIELDS,
      where: socies ? { users_permissions_user: { $notNull: true } } : {},
      populate: socies ? SOCIES_POPULATE : FOR_ORDERS_POPULATE,
      orderBy: { trade_name: 'asc' },
    });
  },

  /**
   * GET /api/contacts/orders
   * Aggregates order counts and route names per contact.
   */
  async orders(ctx) {
    const oneYearAgo = new Date();
    oneYearAgo.setFullYear(oneYearAgo.getFullYear() - 1);

    const contactsWithOwner = await strapi.db.query('api::contact.contact').findMany({
      where: { owner: { $notNull: true } },
    });

    const orders = await strapi.db.query('api::order.order').findMany({
      where: { estimated_delivery_date: { $gte: oneYearAgo } },
      // `owner` has to be populated. v3 returned it as an FK column, so
      // `order.owner` was the user id; v5 leaves an unpopulated relation
      // undefined, the branch below never ran, and every contact came back
      // with an empty `owners` -- the Sòcies column showed "-" for all of
      // them. `routes` further down is matched on contact.city, a scalar,
      // which is why that column kept working and this one did not.
      populate: { contact: true, owner: true },
    });

    for (const order of orders) {
      if (order.contact) {
        const contact = contactsWithOwner.find((c) => c.id === order.contact.id);
        if (contact) {
          contact.num_orders = (contact.num_orders || 0) + 1;
          // Populated, so this is the user row itself rather than an id. Taking
          // the name from it also drops a findMany over the whole user table.
          const owner = order.owner;
          if (owner) {
            contact.owners = contact.owners || [];
            if (!contact.owners.find((o) => o.id === owner.id)) {
              contact.owners.push({ id: owner.id, name: owner.username || 'Unknown' });
            }
          }
        } else {
          console.warn(`Order ${order.id} has contact ${order.contact.id} which is not in contactsWithOwner`);
        }
      }
    }

    const cityRoutes = await strapi.db.query('api::city-route.city-route').findMany({
      populate: { city: true, route: true },
    });

    for (const contact of contactsWithOwner) {
      contact.routes = cityRoutes
        .filter((r) => r.city && r.city.name === contact.city)
        .map((r) => r.route?.name)
        .filter(Boolean);
    }

    return contactsWithOwner.map((c) => ({
      id: c.id,
      trade_name: c.trade_name,
      num_orders: c.num_orders || 0,
      routes: c.routes || [],
      routes_flattened: c.routes ? c.routes.join(', ') : '',
      owners: c.owners || [],
      owners_flattened: c.owners ? c.owners.map((o) => o.name).join(', ') : '',
    }));
  },

  /**
   * GET /api/contacts/withorders
   * Contacts that have orders owned by the current user, with order counts.
   */
  async withorders(ctx) {
    const where = { owner: ctx.state.user.id };
    if (ctx.query.contact_id) {
      where.contact = ctx.query.contact_id;
    }
    const orders = await strapi.db.query('api::order.order').findMany({
      where,
      // ContactsTable pushes any contact from here that the /basic list did
      // not already contain, so these rows are rendered by the same columns
      // and need the same relations.
      populate: { contact: { populate: BASIC_POPULATE } },
    });

    const contacts = [];
    for (const order of orders) {
      if (!order.contact) continue;
      let contact = contacts.find((c) => c.id === order.contact.id);
      if (!contact) {
        contact = { ...order.contact, num_orders: 1 };
        contacts.push(contact);
      } else {
        contact.num_orders = (contact.num_orders || 0) + 1;
      }
      contact.can_edit = contact.can_edit || ['delivered', 'invoiced'].includes(order.status);
    }
    return contacts;
  },

  /**
   * POST /api/contacts/unify
   * Merges two contacts: moves all orders from source to target.
   */
  async unify(ctx) {
    const { sourceContactId, targetContactId } = ctx.request.body;
    if (!sourceContactId || !targetContactId) {
      return ctx.badRequest('Both sourceContactId and targetContactId are required');
    }
    if (sourceContactId === targetContactId) {
      return ctx.badRequest('Source and target contacts cannot be the same');
    }

    try {
      const sourceContact = await strapi.db
        .query('api::contact.contact')
        .findOne({ where: { id: sourceContactId } });
      const targetContact = await strapi.db
        .query('api::contact.contact')
        .findOne({ where: { id: targetContactId } });
      if (!sourceContact) return ctx.notFound('Source contact not found');
      if (!targetContact) return ctx.notFound('Target contact not found');

      const orders = await strapi.db
        .query('api::order.order')
        .findMany({ where: { contact: sourceContactId } });

      let movedCount = 0;
      for (const order of orders) {
        await strapi.db.query('api::order.order').update({
          where: { id: order.id },
          data: { contact: targetContactId },
        });
        movedCount++;
      }

      console.log(
        `[UNIFY CONTACTS] User ${ctx.state.user.id} moved ${movedCount} orders from contact ${sourceContactId} to ${targetContactId}`,
      );

      return {
        success: true,
        movedOrders: movedCount,
        sourceContactId,
        targetContactId,
        message: `Successfully moved ${movedCount} orders from contact ${sourceContactId} to ${targetContactId}`,
      };
    } catch (error) {
      console.error('Error unifying contacts:', error);
      return ctx.badRequest('Error unifying contacts', { error: error.message });
    }
  },
}));
