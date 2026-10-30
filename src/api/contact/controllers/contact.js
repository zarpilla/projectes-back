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
  forOrdersWhere,
} = require('../services/for-orders');
const { contactsWithOrders } = require('../services/with-orders');
const { contactsOrdersSummary } = require('../services/orders-summary');
const { contactSnapshot, loadContact } = require('../../order/services/contact-snapshot');
const { findNifMatches } = require('../services/nif-matches');

const ORDER = 'api::order.order';

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
   * relations the collection-point lookup walks. `?owned=1` narrows to the
   * delivery points (contacts with an owner), the list of the order form.
   */
  async forOrders(ctx) {
    const socies = ctx.query.socies === '1' || ctx.query.socies === 'true';
    return strapi.db.query('api::contact.contact').findMany({
      select: FOR_ORDERS_FIELDS,
      where: forOrdersWhere(ctx.query),
      populate: socies ? SOCIES_POPULATE : FOR_ORDERS_POPULATE,
      orderBy: { trade_name: 'asc' },
    });
  },

  /**
   * GET /api/contacts/orders
   * Delivery points with their orders of the last year, members and routes.
   * Grouped queries, nothing loaded order by order (services/orders-summary).
   */
  async orders(ctx) {
    return contactsOrdersSummary(strapi);
  },

  /**
   * GET /api/contacts/withorders
   * Contacts that have orders owned by the current user, with order counts.
   * One grouped query, then each contact once (issues/326, services/with-orders).
   */
  async withorders(ctx) {
    // ContactsTable pushes any contact from here that the /basic list did
    // not already contain, so these rows are rendered by the same columns
    // and need the same relations.
    return contactsWithOrders(strapi, ctx.state.user.id, ctx.query.contact_id, BASIC_POPULATE);
  },

  /**
   * GET /api/contacts/nif-matches?nif=B12345678&exclude=12
   * The other contacts with this NIF (delivery points left out), for the
   * warning of the contact form.
   */
  async nifMatches(ctx) {
    return findNifMatches(strapi, ctx.query.nif, ctx.query.exclude);
  },

  /**
   * POST /api/contacts/unify
   * Merges two contacts: moves all orders from source to target, with the
   * target's data (contact_*). The source is left for the caller to delete.
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
      const targetContact = await loadContact(targetContactId);
      if (!sourceContact) return ctx.notFound('Source contact not found');
      if (!targetContact) return ctx.notFound('Target contact not found');

      const orders = await strapi.db
        .query('api::order.order')
        .findMany({ where: { contact: sourceContactId } });

      const snapshot = contactSnapshot(targetContact);
      let movedCount = 0;
      for (const order of orders) {
        // in the order's history through the change log's subscriber (issues/119)
        await strapi.db.query(ORDER).update({
          where: { id: order.id },
          // the moved order carries the target point's data (issues/157)
          data: { contact: targetContactId, ...snapshot },
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
