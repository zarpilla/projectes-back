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
      populate: { projects: false },
      limit: dbLimit(opts),
      offset: opts.pagination?.start,
      orderBy: opts.sort,
    });
    return contacts.map(({ projects, projectes, ...item }) => item);
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
      populate: { contact: true },
    });

    const owners = await strapi.db.query('plugin::users-permissions.user').findMany({});

    for (const order of orders) {
      if (order.contact) {
        const contact = contactsWithOwner.find((c) => c.id === order.contact.id);
        if (contact) {
          contact.num_orders = (contact.num_orders || 0) + 1;
          if (order.owner) {
            contact.owners = contact.owners || [];
            if (!contact.owners.find((o) => o.id === order.owner)) {
              const owner = owners.find((o) => o.id === order.owner);
              contact.owners.push({ id: order.owner, name: owner?.username || 'Unknown' });
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
      populate: { contact: true },
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
