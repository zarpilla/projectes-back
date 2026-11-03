'use strict';

/**
 * Partial collections and payments (issues/412): a document (emitted invoice,
 * other income, received invoice, other expense) collected or paid in several
 * goes. `partial_payments` is a JSON list of `{ id, date, amount }`; `id` is
 * stable, so Tresoreria can validate each one on its own (sub_type
 * `payment-<id>`).
 *
 * With at least one entry, `paid` and `paid_date` follow from the list: paid
 * once the entries add up to the total, on the date of the last one. Until
 * then `paid_date` stays empty, as every reader of it means «fully paid».
 * Without entries the document keeps its own `paid` / `paid_date`, as before.
 *
 * The entries can't add up to more than the total (decided on issues/412).
 */

const crypto = require('crypto');
const { errors: { ApplicationError } } = require('@strapi/utils');

const round2 = (v) => Math.round((v + Number.EPSILON) * 100) / 100;
const CENT = 0.005;
const DAY = /^\d{4}-\d{2}-\d{2}$/;
const SUB_TYPE = /^payment-[A-Za-z0-9_-]{1,32}$/;

const newId = () => crypto.randomBytes(6).toString('hex');

/** The stored list, always an array (null, a JSON string or junk give []). */
function storedPayments(doc) {
  let list = doc && doc.partial_payments;
  if (typeof list === 'string') {
    try {
      list = JSON.parse(list);
    } catch (e) {
      list = null;
    }
  }
  return Array.isArray(list) ? list : [];
}

/**
 * The list as sent by the form, checked and tidied: each entry with a day
 * «YYYY-MM-DD», a non-zero amount rounded to cents and an id (kept when it
 * has one). Throws ApplicationError (400) on a bad entry.
 */
function normalizePayments(list) {
  if (list === null || list === undefined) return [];
  if (!Array.isArray(list)) throw new ApplicationError('Els cobraments/pagaments parcials han de ser una llista');
  return list.map((p) => {
    const date = p && typeof p.date === 'string' ? p.date.substring(0, 10) : null;
    if (!date || !DAY.test(date)) throw new ApplicationError('Cada cobrament/pagament parcial necessita una data');
    const amount = round2(Number(p.amount));
    if (!Number.isFinite(amount) || amount === 0) {
      throw new ApplicationError('Cada cobrament/pagament parcial necessita un import');
    }
    const id = p.id && SUB_TYPE.test(`payment-${p.id}`) ? String(p.id) : newId();
    return { id, date, amount };
  });
}

const sumPayments = (list) => round2(list.reduce((s, p) => s + Number(p.amount || 0), 0));

/**
 * In a document lifecycle, after its totals are known: checks the list against
 * the total and sets `paid` / `paid_date` from it. `data` is the write,
 * `existing` the stored row (null on create). A write that doesn't send the
 * list still checks the stored one when the total changes.
 */
function applyPartialPayments(data, existing = null) {
  const sent = data.partial_payments !== undefined;
  const list = sent ? normalizePayments(data.partial_payments) : storedPayments(existing);
  if (sent) data.partial_payments = list.length ? list : null;
  if (!list.length) return data;

  const total = round2(Number(data.total !== undefined ? data.total : existing && existing.total) || 0);
  const sum = sumPayments(list);
  if (list.some((p) => Math.sign(p.amount) !== Math.sign(total)) || Math.abs(sum) > Math.abs(total) + CENT) {
    throw new ApplicationError(
      `Els cobraments/pagaments parcials (${sum.toFixed(2)} €) no poden superar el total del document (${total.toFixed(2)} €)`,
    );
  }
  const paid = Math.abs(sum) >= Math.abs(total) - CENT;
  data.paid = paid;
  data.paid_date = paid ? list.map((p) => p.date).sort().pop() : null;
  return data;
}

/**
 * How Tresoreria splits a document: its partial payments in date order and
 * what is still pending. null when it has none (one movement, as before).
 */
function splitPayments(doc) {
  const list = storedPayments(doc);
  if (!list.length) return null;
  const payments = [...list].sort((a, b) => (a.date < b.date ? -1 : a.date > b.date ? 1 : 0));
  const total = round2(Number(doc.total) || 0);
  const pending = round2(total - sumPayments(payments));
  return { payments, pending: Math.abs(pending) > CENT ? pending : 0 };
}

const isPaymentSubType = (subType) => typeof subType === 'string' && SUB_TYPE.test(subType);

module.exports = {
  applyPartialPayments,
  normalizePayments,
  splitPayments,
  storedPayments,
  sumPayments,
  isPaymentSubType,
};
