'use strict';
/* global strapi */

const { logChanges } = require('../../../services/change-log');
const { OPERATIONS, REVERSE_CHARGES } = require('./vat-models');

/**
 * Models 303 i 390 (Beta), phase 2: classify documents' 0 % lines from the
 * «Per revisar» list. `items`: [{ kind, id, value, rate? }]
 * - emitted-invoices / received-incomes: `vat_operation` (E1, E2, E5, N1, N2,
 *   S2) or null to unclassify;
 * - received-invoices: `reverse_charge` (none, intracom, intracom_goods, isp) or null, and
 *   `reverse_charge_rate` (`rate`, 21 by default) when self-assessed.
 *
 * Written straight to the column: it's how the entity declares the operation,
 * not a change to the invoice, so an issued invoice (lines locked, VeriFactu)
 * can be classified too and nothing is regenerated or sent again. Each change
 * goes to the document's history.
 */

const KINDS = {
  'emitted-invoices': { uid: 'api::emitted-invoice.emitted-invoice', field: 'vat_operation', values: Object.keys(OPERATIONS) },
  'received-incomes': { uid: 'api::received-income.received-income', field: 'vat_operation', values: Object.keys(OPERATIONS) },
  'received-invoices': { uid: 'api::received-invoice.received-invoice', field: 'reverse_charge', values: REVERSE_CHARGES },
};

class VatClassifyError extends Error {}

/** Checks the items and returns the writes per kind: { kind: [{ id, data }] }. */
function classifyWrites(items) {
  if (!Array.isArray(items) || !items.length) throw new VatClassifyError('Cap document per classificar.');
  if (items.length > 2000) throw new VatClassifyError('Massa documents alhora (màxim 2000).');
  const writes = {};
  for (const item of items) {
    const kind = KINDS[item && item.kind];
    const id = Number(item && item.id);
    if (!kind || !Number.isInteger(id) || id <= 0) throw new VatClassifyError('Document no vàlid.');
    const value = item.value === undefined || item.value === '' ? null : item.value;
    if (value !== null && !kind.values.includes(value)) throw new VatClassifyError(`Valor no vàlid: ${value}`);
    const data = { [kind.field]: value };
    if (kind.field === 'reverse_charge' && value !== 'none' && value !== null) {
      const rate = item.rate === undefined || item.rate === null || item.rate === '' ? 21 : Number(item.rate);
      if (!Number.isFinite(rate) || rate < 0 || rate > 100) throw new VatClassifyError(`Tipus no vàlid: ${item.rate}`);
      data.reverse_charge_rate = rate;
    }
    (writes[item.kind] = writes[item.kind] || []).push({ id, data });
  }
  return writes;
}

async function classifyDocuments(items) {
  const writes = classifyWrites(items);
  let updated = 0;
  for (const [kindName, list] of Object.entries(writes)) {
    const { uid, field } = KINDS[kindName];
    const fields = field === 'reverse_charge' ? ['reverse_charge', 'reverse_charge_rate'] : [field];
    const { tableName } = strapi.db.metadata.get(uid);
    const before = await strapi.db.query(uid).findMany({ select: ['id', 'code', ...fields], where: { id: { $in: list.map((w) => w.id) } } });
    const byId = new Map(before.map((row) => [row.id, row]));
    const entries = [];
    for (const { id, data } of list) {
      const row = byId.get(id);
      if (!row) continue;
      // the attribute names are the column names
      await strapi.db.connection(tableName).where({ id }).update(data);
      updated++;
      entries.push({ row: { id, code: row.code }, changes: Object.entries(data).map(([key, to]) => ({ field: key, from: row[key], to })) });
    }
    await logChanges(uid, entries);
  }
  return { updated };
}

module.exports = { classifyDocuments, classifyWrites, VatClassifyError };
