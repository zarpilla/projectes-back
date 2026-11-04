'use strict';
/* global strapi */

const moment = require('moment');
const { vatModels, documentSnapshot } = require('./vat-models');
const { file303, file390, AeatFileError } = require('./aeat-file');
const { getMe } = require('../../../services/me-settings');

/**
 * IVA › Models 303 i 390 (Beta), phase 3: loading the year, the returns
 * marked as filed (a snapshot of their boxes and documents, built here, never
 * taken from the client), the year's final prorrata and the AEAT files.
 */

const RETURN_UID = 'api::vat-return.vat-return';
const PERIODS = { 303: ['1T', '2T', '3T', '4T'], 390: ['0A'] };
const DECLARATION_TYPES = ['I', 'U', 'C', 'D', 'N'];

class VatReturnError extends Error {}

/** The year's documents, classifications and filed returns, as vatModels takes them. */
async function loadVatModelsData(year) {
  const where = { emitted: { $gte: `${year}-01-01`, $lte: `${year}-12-31` } };
  const select = ['id', 'code', 'emitted', 'total_base', 'total_vat'];
  const contact = { select: ['id', 'name', 'nif', 'country'] };
  // other years' classified documents, for the proposals (same contact)
  const classified = (uid, field) =>
    strapi.db.query(uid).findMany({
      select: ['id', 'emitted', field],
      where: { [field]: { $notNull: true }, $not: where },
      populate: { contact: { select: ['id'] } },
    });
  const [emittedInvoices, receivedIncomes, receivedInvoices, receivedExpenses, years, oldEmitted, oldIncomes, oldReceived, returns] = await Promise.all([
    strapi.db.query('api::emitted-invoice.emitted-invoice').findMany({
      select: [...select, 'state', 'vat_operation'],
      where,
      populate: { lines: true, contact, serial: { select: ['id', 'rectificative'] } },
    }),
    strapi.db.query('api::received-income.received-income').findMany({
      select: [...select, 'vat_operation'],
      where,
      populate: { lines: true, contact },
    }),
    strapi.db.query('api::received-invoice.received-invoice').findMany({
      select: [...select, 'reverse_charge', 'reverse_charge_rate'],
      where,
      populate: { lines: { populate: { expense_type: { select: ['id', 'capital_goods'] } } }, contact },
    }),
    strapi.db.query('api::received-expense.received-expense').findMany({ select, where }),
    strapi.db.query('api::year.year').findMany({ select: ['id', 'year', 'deductible_vat_pct', 'final_deductible_vat_pct'] }),
    classified('api::emitted-invoice.emitted-invoice', 'vat_operation'),
    classified('api::received-income.received-income', 'vat_operation'),
    classified('api::received-invoice.received-invoice', 'reverse_charge'),
    strapi.db.query(RETURN_UID).findMany({
      where: { $or: [{ year }, { year: year - 1, model: '303', period: '4T' }] },
    }),
  ]);
  return {
    emittedInvoices,
    receivedIncomes,
    receivedInvoices,
    receivedExpenses,
    years,
    history: { issued: [...oldEmitted, ...oldIncomes], received: oldReceived },
    returns,
  };
}

async function computeVatModels(year) {
  return vatModels(await loadVatModelsData(year), year);
}

function checkPeriod(model, year, period) {
  if (!PERIODS[model]) throw new VatReturnError(`Model no vàlid: ${model}`);
  if (!PERIODS[model].includes(period)) throw new VatReturnError(`Període no vàlid: ${period}`);
  if (!Number.isInteger(year) || year < 2000 || year > 2100) throw new VatReturnError(`Any no vàlid: ${year}`);
}

/** What a filed return keeps: its boxes, its documents and its result, as they are now. */
function snapshotOf(result, model, period) {
  if (model === '390') {
    return { boxes: result.model390.boxes, documents: documentSnapshot(result.rows), result: result.model390.boxes['86'] };
  }
  const quarter = Number(period[0]);
  const q = result.quarters[quarter - 1];
  return { boxes: q.boxes, documents: documentSnapshot(result.rows.filter((r) => r.quarter === quarter)), result: q.boxes['71'] };
}

/**
 * Marks a return as filed (again: a second time replaces the snapshot).
 * @param {object} p { model, year, period, declaration_type, filed_date, receipt, notes }
 */
async function fileReturn(p, user) {
  const model = String(p.model);
  const year = Number(p.year);
  const period = String(p.period);
  checkPeriod(model, year, period);
  const declarationType = p.declaration_type ? String(p.declaration_type) : null;
  if (model === '303' && !DECLARATION_TYPES.includes(declarationType)) throw new VatReturnError(`Tipus de declaració no vàlid: ${declarationType}`);
  if (declarationType === 'D' && model === '303' && period !== '4T') throw new VatReturnError('Només es pot demanar la devolució al 4T.');
  const filedDate = p.filed_date ? moment(p.filed_date, 'YYYY-MM-DD', true) : moment();
  if (!filedDate.isValid()) throw new VatReturnError(`Data no vàlida: ${p.filed_date}`);

  // the snapshot without this return itself, so a second filing takes the documents as they are now
  const data = await loadVatModelsData(year);
  data.returns = data.returns.filter((r) => !(r.model === model && Number(r.year) === year && r.period === period));
  const snapshot = snapshotOf(vatModels(data, year), model, period);
  const row = {
    model,
    year,
    period,
    declaration_type: declarationType,
    filed_date: filedDate.format('YYYY-MM-DD'),
    receipt: p.receipt ? String(p.receipt).slice(0, 255) : null,
    notes: p.notes ? String(p.notes) : null,
    filed_by: user && user.id ? user.id : null,
    ...snapshot,
  };
  const existing = await strapi.db.query(RETURN_UID).findOne({ where: { model, year, period } });
  return existing
    ? strapi.db.query(RETURN_UID).update({ where: { id: existing.id }, data: row })
    : strapi.db.query(RETURN_UID).create({ data: row });
}

async function unfileReturn(id) {
  const existing = await strapi.db.query(RETURN_UID).findOne({ where: { id: Number(id) } });
  if (!existing) throw new VatReturnError('Declaració no trobada.');
  await strapi.db.query(RETURN_UID).delete({ where: { id: existing.id } });
  return { id: existing.id };
}

/** The year's final prorrata (null clears it): box 44 of the last quarter and the 390. */
async function setFinalProrrata(year, pct) {
  year = Number(year);
  const value = pct === null || pct === '' || pct === undefined ? null : Number(pct);
  if (value !== null && (!Number.isFinite(value) || value < 0 || value > 100)) throw new VatReturnError(`Percentatge no vàlid: ${pct}`);
  const row = await strapi.db.query('api::year.year').findOne({ where: { year } });
  if (!row) throw new VatReturnError(`L'any ${year} no és a Configuració › Anys.`);
  await strapi.db.query('api::year.year').update({ where: { id: row.id }, data: { final_deductible_vat_pct: value } });
  return { year, final_deductible_vat_pct: value };
}

/**
 * The AEAT file of a return, from the boxes as they are now (or as filed).
 * @param {object} p { model, year, period, declaration_type, iban }
 */
async function buildFile(p) {
  const model = String(p.model);
  const year = Number(p.year);
  const period = model === '390' ? '0A' : String(p.period);
  checkPeriod(model, year, period);
  const [result, me, verifactu] = await Promise.all([
    computeVatModels(year),
    getMe([]),
    strapi.db.query('api::verifactu.verifactu').findOne({ select: ['software_version', 'software_developerIrsId'] }),
  ]);
  const software = { version: '0001', nif: (verifactu && verifactu.software_developerIrsId) || '' };
  if (model === '390') {
    return { name: `390_${year}.txt`, content: file390({ year, boxes: result.model390.boxes, me, software }) };
  }
  const q = result.quarters[Number(period[0]) - 1];
  const declarationType = p.declaration_type || q.declaration_type;
  const prorrata = result.prorrata && (result.deductible_pct < 100 || result.final_deductible_pct !== null)
    ? { total: result.prorrata.total, with_right: result.prorrata.with_right, pct: result.final_deductible_pct !== null ? result.final_deductible_pct : result.deductible_pct }
    : null;
  const content = file303({
    year,
    period,
    boxes: q.boxes,
    declarationType,
    me,
    annual: result.annual,
    prorrata,
    iban: p.iban || '',
    software,
  });
  return { name: `303_${year}_${period}.txt`, content };
}

module.exports = { loadVatModelsData, computeVatModels, fileReturn, unfileReturn, setFinalProrrata, buildFile, VatReturnError, AeatFileError };
