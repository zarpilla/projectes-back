'use strict';
/* global strapi */
// A plain Error from a lifecycle surfaces as a bare 500 'Internal Server Error',
// so the rule that rejected the write never reaches the user. ApplicationError
// answers 400 with the message, which the views already display.
const { errors: { ApplicationError, ValidationError } } = require('@strapi/utils');
const { relationId } = require('../../../../services/relation-input');

const blank = (value) => value === undefined || value === null || String(value).trim() === '';

/**
 * «Nom comercial» is required for a delivery point (a contact with an owner):
 * the order form lists the points by it, and one without it blanked every order
 * form (the user's decision, 2026-10-19, issues/215). Refused when a point is
 * created without it or a write empties it. A legacy point without it (36 in
 * production) still saves when the write leaves it empty as it was: the forms
 * send it back with the rest.
 */
async function checkTradeName(data, where = null) {
  if (!blank(data.trade_name) || (where && !('trade_name' in data))) return;
  let stored = null;
  if (where) {
    stored = await strapi.db
      .query('api::contact.contact')
      .findOne({ where, select: ['id', 'trade_name'], populate: { owner: { select: ['id'] } } });
    if (!stored || blank(stored.trade_name)) return;
  }
  const owner = 'owner' in data ? relationId(data.owner) : stored && relationId(stored.owner);
  if (owner) throw new ValidationError("El nom comercial és obligatori als punts d'entrega");
}

module.exports = {
  async beforeCreate(event) {
    await checkTradeName(event.params.data || {});
  },

  async beforeUpdate(event) {
    await checkTradeName(event.params.data || {}, event.params.where);
  },

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
      throw new ApplicationError('You cannot delete this contact');
    }
  },
};
