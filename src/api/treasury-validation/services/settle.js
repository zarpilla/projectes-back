'use strict';
/* global strapi */

/**
 * Tresoreria: validating a pending document line marks the document as
 * collected or paid (issues/415), and so does accepting a bank movement in
 * «Conciliació» (issues/413).
 *
 * `settleDocument` pays what is still pending of an emitted invoice, other
 * income, received invoice or other expense on `date`, and validates it:
 *   - a document without partial payments gets `paid` and `paid_date`;
 *   - one with partial payments (issues/412), or paid only in part (an
 *     `amount` below what is pending, from a bank movement), gets a new partial
 *     payment, validated on its own (`payment-<id>`); `paid` / `paid_date`
 *     follow from the list, as in the document form.
 * A date can't be in the future. When the document was expected later than
 * `date`, its expected date («Previsió cobrament» / «Venciment») and the
 * project lines assigned to it move to `date`, as «Moviments bancaris» does
 * (issues/370), so the project, the document and Tresoreria agree.
 *
 * Documents are written straight to their table, like the movement dates: a
 * document that is not «Modificable» can still be marked paid (decided on
 * issues/415), and marking an issued invoice paid must not draw its PDF again
 * or queue FACe / VeriFactu. The change goes to the document's «Historial».
 *
 * The validation keeps what it changed (`settlement`), so unvalidating it
 * (`unsettle`) puts the document back, but only while the document is still
 * as the validation left it: a document changed by hand since then keeps the
 * change and only loses its validation.
 */

const moment = require('moment');
const changeLog = require('../../../services/change-log');
const { KINDS } = require('../../treasury/services/movement-dates');
const { storedPayments, sumPayments, newPaymentId, round2 } = require('../../../services/partial-payments');
const { scheduleFromEntityProjects } = require('../../project/services/totalsRefreshScheduler');

const VALIDATION = 'api::treasury-validation.treasury-validation';
const CENT = 0.005;
const DOCUMENT_KINDS = ['emitted-invoices', 'received-incomes', 'received-invoices', 'received-expenses'];
const INCOME_KINDS = ['emitted-invoices', 'received-incomes'];

class SettleError extends Error {}

const day = (d) => (d ? String(d).substring(0, 10) : null);
const isValidDate = (d) => typeof d === 'string' && moment(d, 'YYYY-MM-DD', true).isValid();

// the date Tresoreria shows for the unpaid document (controllers/treasury.js)
const expectedDate = (doc, kind) =>
  day(INCOME_KINDS.includes(kind) ? doc.estimated_payment || doc.paybefore || doc.emitted : doc.paybefore || doc.emitted);

const describe = (doc) => doc.code || doc.concept || `#${doc.id}`;

const loadDocument = (k, id) =>
  strapi.db.query(k.uid).findOne({ where: { id }, populate: { project: true, projects: true } });

async function writeDocument(k, doc, data) {
  const fields = Object.keys(data);
  const { tableName } = strapi.db.metadata.get(k.uid);
  const before = changeLog.isTracked(k.uid)
    ? await changeLog.rowWith(k.uid, { id: doc.id }, fields).catch(() => null)
    : null;
  await strapi.db.connection(tableName).where({ id: doc.id }).update(data);
  await changeLog.logRawUpdate(k.uid, before, fields);
}

/**
 * What is still pending of a document (signed like its total), or 0.
 * @returns {{ total: number, list: object[], pending: number }}
 */
function pendingOf(doc) {
  const list = storedPayments(doc);
  const total = round2(Number(doc.total) || 0);
  if (!list.length) return { total, list, pending: doc.paid ? 0 : total };
  const pending = round2(total - sumPayments(list));
  return { total, list, pending: Math.abs(pending) > CENT ? pending : 0 };
}

/**
 * @param {object} p
 * @param {string} p.entity_type one of DOCUMENT_KINDS
 * @param {number} p.entity_id
 * @param {string} p.date YYYY-MM-DD, not after today
 * @param {number} [p.amount] part of what is pending (signed like the total); all of it when left out
 * @param {number} [p.userId] who validates
 * @param {number} [p.bankMovementId] the bank movement it is reconciled with (issues/413)
 * @param {string} [p.today] YYYY-MM-DD, for tests
 * @returns {Promise<{ validation_key: string, paid: boolean, partial_payment_id: string|null }>}
 */
async function settleDocument({ entity_type, entity_id, date, amount, userId, bankMovementId, today }) {
  if (!DOCUMENT_KINDS.includes(entity_type)) throw new SettleError('Només es poden marcar com a cobrats o pagats els documents');
  const id = Number(entity_id);
  if (!Number.isInteger(id) || id <= 0) throw new SettleError('Document desconegut');
  if (!isValidDate(date)) throw new SettleError(`Data no vàlida: ${date}`);
  if (date > (today || moment().format('YYYY-MM-DD'))) {
    throw new SettleError('La data de cobrament o pagament no pot ser futura');
  }

  const k = KINDS[entity_type];
  const doc = await loadDocument(k, id);
  if (!doc) throw new SettleError('Document no trobat');
  if (entity_type === 'emitted-invoices' && doc.state === 'draft') {
    throw new SettleError(`«${describe(doc)}» és un esborrany: emet la factura abans de marcar-la com a cobrada`);
  }
  const { total, list, pending } = pendingOf(doc);
  if (!pending) throw new SettleError(`«${describe(doc)}» ja està cobrat o pagat`);

  let part = pending;
  if (amount !== undefined && amount !== null) {
    part = round2(Number(amount));
    if (!Number.isFinite(part) || part === 0 || Math.sign(part) !== Math.sign(pending) || Math.abs(part) > Math.abs(pending) + CENT) {
      throw new SettleError(
        `L'import (${Number(amount).toFixed(2)} €) no pot superar el que queda pendent de «${describe(doc)}» (${pending.toFixed(2)} €)`,
      );
    }
    if (Math.abs(pending - part) <= CENT) part = pending;
  }

  const data = {};
  let paymentId = null;
  if (!list.length && part === pending) {
    data.paid = true;
    data.paid_date = date;
  } else {
    paymentId = newPaymentId();
    const next = [...list, { id: paymentId, date, amount: part }];
    const paid = Math.abs(sumPayments(next)) >= Math.abs(total) - CENT;
    data.partial_payments = JSON.stringify(next);
    data.paid = paid;
    data.paid_date = paid ? next.map((p) => p.date).sort().pop() : null;
  }

  // expected later than it was paid: the expected date and the project lines move
  const fieldsBefore = {};
  const linesBefore = [];
  const expected = expectedDate(doc, entity_type);
  if (data.paid && expected && expected > date) {
    for (const f of k.fields) {
      fieldsBefore[f] = day(doc[f]);
      data[f] = date;
    }
    const assigned = await strapi.db
      .query(k.lines.uid)
      .findMany({ where: { [k.lines.relation]: { id } }, select: ['id', 'date'] });
    for (const line of assigned) {
      if (day(line.date) === date) continue;
      linesBefore.push({ id: line.id, date: day(line.date) });
      await strapi.db.query(k.lines.uid).update({ where: { id: line.id }, data: { date } });
    }
  }

  await writeDocument(k, doc, data);
  await scheduleFromEntityProjects(doc);

  const sub_type = paymentId ? `payment-${paymentId}` : null;
  await strapi.db.query(VALIDATION).create({
    data: {
      entity_type,
      entity_id: id,
      sub_type,
      validated_by: userId || null,
      bank_movement: bankMovementId || null,
      settlement: {
        date,
        payment_id: paymentId,
        paid: Boolean(doc.paid),
        paid_date: day(doc.paid_date),
        fields: fieldsBefore,
        lines: linesBefore,
      },
      publishedAt: new Date(),
    },
  });

  return {
    validation_key: sub_type ? `${entity_type}:${id}:${sub_type}` : `${entity_type}:${id}`,
    paid: data.paid,
    partial_payment_id: paymentId,
  };
}

/**
 * Puts back what a validation's `settlement` changed, while the document is
 * still as it left it. Doesn't delete the validation.
 * @returns {Promise<boolean>} whether the document was put back
 */
async function unsettle(validation) {
  const s = validation && validation.settlement;
  if (!s || !DOCUMENT_KINDS.includes(validation.entity_type)) return false;
  const k = KINDS[validation.entity_type];
  const doc = await loadDocument(k, validation.entity_id);
  if (!doc) return false;

  const data = {};
  if (s.payment_id) {
    const list = storedPayments(doc);
    const mine = list.find((p) => p.id === s.payment_id);
    if (!mine) return false;
    const rest = list.filter((p) => p.id !== s.payment_id);
    if (rest.length) {
      const total = round2(Number(doc.total) || 0);
      const paid = Math.abs(sumPayments(rest)) >= Math.abs(total) - CENT;
      data.partial_payments = JSON.stringify(rest);
      data.paid = paid;
      data.paid_date = paid ? rest.map((p) => p.date).sort().pop() : null;
    } else {
      data.partial_payments = null;
      data.paid = s.paid;
      data.paid_date = s.paid_date;
    }
  } else {
    if (!doc.paid || day(doc.paid_date) !== s.date) return false;
    data.paid = s.paid;
    data.paid_date = s.paid_date;
  }

  for (const [f, before] of Object.entries(s.fields || {})) {
    if (day(doc[f]) === s.date) data[f] = before;
  }
  for (const line of s.lines || []) {
    const row = await strapi.db.query(k.lines.uid).findOne({ where: { id: line.id }, select: ['id', 'date'] });
    if (row && day(row.date) === s.date) {
      await strapi.db.query(k.lines.uid).update({ where: { id: line.id }, data: { date: line.date } });
    }
  }

  await writeDocument(k, doc, data);
  await scheduleFromEntityProjects(doc);
  return true;
}

module.exports = { settleDocument, unsettle, pendingOf, SettleError, DOCUMENT_KINDS };
