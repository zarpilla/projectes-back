'use strict';
/* global strapi */

/**
 * Whether an order can be marked as deposited (issues/149). The «Dipòsits»
 * scanner and the order screens set `deposit_date`; an order that is already
 * delivered, invoiced or cancelled is past the deposit, so the API refuses it,
 * and refuses moving the date of its deposit too (issues/163). Clearing a
 * deposit, or saving an order with the deposit date it already has, is left
 * alone.
 */
const NOT_DEPOSITABLE = {
  delivered: 'lliurada',
  invoiced: 'facturada',
  cancelled: 'anul·lada',
};

const sameInstant = (a, b) => new Date(a).getTime() === new Date(b).getTime();

/** The reason the update can't deposit the order, or null when it can. */
async function depositRefusal(orderId, payload) {
  if (!payload || !payload.deposit_date || orderId === undefined || orderId === null) return null;
  const id = Number(orderId);
  if (!Number.isInteger(id)) return null;
  const order = await strapi.db
    .query('api::order.order')
    .findOne({ where: { id }, select: ['id', 'status', 'deposit_date'] });
  if (!order) return null;
  const label = NOT_DEPOSITABLE[order.status];
  if (!label) return null;
  if (!order.deposit_date) return `La comanda ${id} està ${label}: no es pot dipositar`;
  if (sameInstant(order.deposit_date, payload.deposit_date)) return null;
  return `La comanda ${id} està ${label}: no es pot canviar la data del dipòsit`;
}

/**
 * Whether a transfer can be started or ended on an order (issues/222). The
 * «Transferències» scanner, Operacions and the order screens set
 * `transfer_start_date` / `transfer_end_date`; a cancelled or invoiced order
 * is out of the logistics, so the API refuses both moves, and refuses moving
 * their dates, like the deposit. A delivered order keeps them: a transfer left
 * open can still be closed. Clearing a move, or saving an order with the dates
 * it already has, is left alone.
 */
const NOT_TRANSFERABLE = {
  invoiced: 'facturada',
  cancelled: 'anul·lada',
};

const TRANSFER_MOVES = {
  transfer_start_date: 'iniciar la transferència',
  transfer_end_date: 'finalitzar la transferència',
};

/** The reason the update can't move the transfer of the order, or null when it can. */
async function transferRefusal(orderId, payload) {
  if (!payload || orderId === undefined || orderId === null) return null;
  const sent = Object.keys(TRANSFER_MOVES).filter((field) => payload[field]);
  if (!sent.length) return null;
  const id = Number(orderId);
  if (!Number.isInteger(id)) return null;
  const order = await strapi.db
    .query('api::order.order')
    .findOne({ where: { id }, select: ['id', 'status', ...Object.keys(TRANSFER_MOVES)] });
  if (!order) return null;
  const label = NOT_TRANSFERABLE[order.status];
  if (!label) return null;
  const moved = sent.find((field) => !order[field] || !sameInstant(order[field], payload[field]));
  if (!moved) return null;
  return `La comanda ${id} està ${label}: no es pot ${TRANSFER_MOVES[moved]}`;
}

module.exports = { depositRefusal, transferRefusal, NOT_DEPOSITABLE, NOT_TRANSFERABLE };
