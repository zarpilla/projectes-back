'use strict';
/* global strapi */

/**
 * Whether an order can be marked as deposited (issues/149). The «Dipòsits»
 * scanner and the order screens set `deposit_date`; an order that is already
 * delivered, invoiced or cancelled is past the deposit, so the API refuses it.
 * Clearing a deposit, or saving an order that was already deposited, is left
 * alone.
 */
const NOT_DEPOSITABLE = {
  delivered: 'lliurada',
  invoiced: 'facturada',
  cancelled: 'anul·lada',
};

/** The reason the update can't deposit the order, or null when it can. */
async function depositRefusal(orderId, payload) {
  if (!payload || !payload.deposit_date || orderId === undefined || orderId === null) return null;
  const id = Number(orderId);
  if (!Number.isInteger(id)) return null;
  const order = await strapi.db
    .query('api::order.order')
    .findOne({ where: { id }, select: ['id', 'status', 'deposit_date'] });
  if (!order || order.deposit_date) return null;
  const label = NOT_DEPOSITABLE[order.status];
  return label ? `La comanda ${id} està ${label}: no es pot dipositar` : null;
}

module.exports = { depositRefusal, NOT_DEPOSITABLE };
