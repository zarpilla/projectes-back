'use strict';
/* global strapi */

/**
 * Tresoreria › Moviments bancaris: change the date of pending movements
 * (issues/370).
 *
 * Only what hasn't been paid or collected yet moves:
 *   - an expected project line («Despesa esperada» / «Ingrés esperat»: a
 *     phase line without a document) → its «Previsió pag.» (`date`);
 *   - an unpaid document → the date the treasury reads for it, and the
 *     «Previsió pag.» of the project lines it is assigned to:
 *       · emitted invoices and other incomes: «Previsió cobrament»
 *         (`estimated_payment`). The «Venciment» of an issued invoice is
 *         printed on it and was sent to the client, so it stays;
 *       · received invoices and other expenses: «Venciment» (`paybefore`).
 * A paid line or document, or one with a payment date, is refused, and then
 * nothing is changed.
 *
 * Documents are written straight to their table: a date for the forecast
 * must not regenerate the PDF, queue FACe or Verifactu, or hit the guard of
 * issued invoices (their lifecycles). Phase lines go through the query layer,
 * whose lifecycles mark the projects' totals to be recomputed.
 */

const moment = require('moment');

const KINDS = {
  'phase-income': { uid: 'api::phase-income.phase-income', line: true },
  'phase-expense': { uid: 'api::phase-expense.phase-expense', line: true },
  'emitted-invoices': {
    uid: 'api::emitted-invoice.emitted-invoice',
    field: 'estimated_payment',
    lines: { uid: 'api::phase-income.phase-income', relation: 'invoice' },
  },
  'received-incomes': {
    uid: 'api::received-income.received-income',
    field: 'estimated_payment',
    lines: { uid: 'api::phase-income.phase-income', relation: 'income' },
  },
  'received-invoices': {
    uid: 'api::received-invoice.received-invoice',
    field: 'paybefore',
    lines: { uid: 'api::phase-expense.phase-expense', relation: 'invoice' },
  },
  'received-expenses': {
    uid: 'api::received-expense.received-expense',
    field: 'paybefore',
    lines: { uid: 'api::phase-expense.phase-expense', relation: 'expense' },
  },
};

class MovementDateError extends Error {}

const isValidDate = (d) => typeof d === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(d) && moment(d, 'YYYY-MM-DD', true).isValid();

// the last change of each movement wins; checks kind, id and date
function normalize(changes) {
  if (!Array.isArray(changes) || !changes.length) throw new MovementDateError('No hi ha cap canvi de data');
  const byKey = new Map();
  for (const c of changes) {
    const kind = c && c.kind;
    const id = Number(c && c.id);
    if (!KINDS[kind] || !Number.isInteger(id) || id <= 0) throw new MovementDateError('Moviment desconegut');
    if (!isValidDate(c.date)) throw new MovementDateError(`Data no vàlida: ${c.date}`);
    byKey.set(`${kind}:${id}`, { kind, id, date: c.date });
  }
  return [...byKey.values()];
}

const describe = (row, fallback) => (row && (row.code || row.concept)) || fallback;

/**
 * @param {{kind: string, id: number, date: string}[]} changes date as YYYY-MM-DD
 * @returns {{ updated: number, lines: number }} movements and project lines changed
 */
async function updateMovementDates(changes) {
  const list = normalize(changes);

  // every movement is checked before anything is written
  const loaded = [];
  for (const c of list) {
    const k = KINDS[c.kind];
    const row = await strapi.db.query(k.uid).findOne({ where: { id: c.id } });
    if (!row) throw new MovementDateError('Moviment no trobat');
    if (k.line) {
      // an assigned line is paid by its document: that one is the movement
      if (row.paid) {
        throw new MovementDateError(`«${describe(row, c.id)}» ja té un document assignat: canvia la data del document`);
      }
    } else if (row.paid || row.paid_date) {
      throw new MovementDateError(`«${describe(row, c.id)}» ja està pagat o cobrat: no se'n pot canviar la data`);
    }
    loaded.push({ c, k });
  }

  let lines = 0;
  for (const { c, k } of loaded) {
    if (k.line) {
      await strapi.db.query(k.uid).update({ where: { id: c.id }, data: { date: c.date } });
      lines++;
      continue;
    }
    const { tableName } = strapi.db.metadata.get(k.uid);
    await strapi.db.connection(tableName).where({ id: c.id }).update({ [k.field]: c.date });
    const assigned = await strapi.db
      .query(k.lines.uid)
      .findMany({ where: { [k.lines.relation]: { id: c.id } }, select: ['id', 'date'] });
    for (const line of assigned) {
      if (String(line.date || '').substring(0, 10) === c.date) continue;
      await strapi.db.query(k.lines.uid).update({ where: { id: line.id }, data: { date: c.date } });
      lines++;
    }
  }
  return { updated: list.length, lines };
}

module.exports = { updateMovementDates, MovementDateError, KINDS };
