'use strict';
/* global strapi */

/**
 * contact lifecycles (v5). Ported from v3 api/contacts/models/contacts.js.
 * Blocks deletion when the contact is referenced anywhere.
 */
module.exports = {
  async beforeDelete(event) {
    const { where } = event.params;
    const id = where.id;

    const refs = await Promise.all([
      strapi.db.query('api::project.project').findOne({ where: { clients: id } }),
      strapi.db.query('api::project.project').findOne({ where: { intercooperations: id } }),
      strapi.db.query('api::order.order').findOne({ where: { contact: id } }),
      strapi.db.query('api::emitted-invoice.emitted-invoice').findOne({ where: { contact: id } }),
      strapi.db.query('api::received-income.received-income').findOne({ where: { contact: id } }),
      strapi.db.query('api::received-invoice.received-invoice').findOne({ where: { contact: id } }),
      strapi.db.query('api::received-expense.received-expense').findOne({ where: { contact: id } }),
      strapi.db.query('api::project.project').findOne({ where: { grantable_leader: id } }),
      strapi.db.query('api::quote.quote').findOne({ where: { contact: id } }),
    ]);

    if (refs.some(Boolean)) {
      throw new Error('You cannot delete this contact');
    }
  },
};
