'use strict';
/* global strapi */

/**
 * emitted-invoice controller (v5). Ported from v3 api/emitted-invoice/controllers/emitted-invoice.js (738 LOC).
 * Custom endpoints: findBasic, pdf, sendInvoiceByEmail, payVat, payVatIds, pendingProvider.
 *
 * Data-access migration: strapi.query -> strapi.db.query / Document Service;
 * strapi.connections.default.raw -> rawExecute (parameter-bound, R11 fix);
 * strapi.plugins['email'].services.email.send -> strapi.plugin('email').service('email').send.
 */
const _ = require('lodash');
const fs = require('fs');
const crypto = require('crypto');
const moment = require('moment');
const sharp = require('sharp');
const MicroInvoice = require('../../../../utils/microinvoice');
const { resolvePdfLogo } = require('../../../services/pdf-logo');
const { createCoreController } = require('@strapi/strapi').factories;
const { adaptCtxQuery, dbLimit, wantsNoRows } = require('../../../services/query-adapter');
const { adaptQuery } = require('../../../services/query-adapter');
const { rawExecute } = require('../../../services/raw-sql');
const { getMe } = require('../../../services/me-settings');
const { buildEmailBody } = require('../../../services/email-body');
const changeLog = require('../../../services/change-log');
const { relationId } = require('../../../services/relation-input');
const { toLocalDay } = require('../../../services/date-fields');

// Map v3 entity slug -> DB table name for the raw UPDATE in payEntity.
const ENTITY_TABLE = {
  'emitted-invoice': 'emitted_invoices',
  'received-invoice': 'received_invoices',
  'received-income': 'received_incomes',
  'received-expense': 'received_expenses',
};

const formatCurrency = (val) => {
  if (!val) return '-';
  return val
    .toFixed(2)
    .replace(/\d(?=(\d{3})+\.)/g, '$&;')
    .replace(/\./g, ',')
    .replace(/;/g, '.');
};

// Unit price: up to the 4 decimals the lines keep, at least 2 (33,3333 · 12,50)
// with thousands dots; it was always printed with 2 (issues/243, issues/270).
const formatUnitPrice = (val) => {
  const number = Number(val) || 0;
  if (!number) return '-';
  let [integer, decimals] = Math.abs(number).toFixed(4).split('.');
  decimals = decimals.replace(/0+$/, '').padEnd(2, '0');
  integer = integer.replace(/\B(?=(\d{3})+(?!\d))/g, '.');
  return `${number < 0 ? '-' : ''}${integer},${decimals}`;
};

// Quantities and percentages with a Catalan decimal comma: «1,5», «12,5%» (issues/243).
const formatNumber = (val) => String(Number(val) || 0).replace('.', ',');

// Line amounts rounded to cents as the totals (computeLineTotals) round them,
// so the lines and the discount add up to the totals printed (issues/243).
const round2 = (v) => Math.round((v + Number.EPSILON) * 100) / 100;
const lineAmounts = (line) => {
  const gross = round2(line.quantity * line.base);
  const base = round2(line.quantity * line.base * (1 - (line.discount || 0) / 100));
  const vat = round2((base * (line.vat || 0)) / 100);
  const irpf = round2((base * (line.irpf || 0)) / 100);
  return { gross, discount: round2(gross - base), base, vat, irpf, total: round2(base + vat - irpf) };
};

const getEntityInfo = async (entityUid) => {
  const documents = await strapi.db.query(entityUid).findMany({
    where: { vat_paid_date: { $null: true } },
  });
  return { documents, total_vat: _.sumBy(documents, 'total_vat') };
};

const getYearsInfo = async () => {
  return strapi.db.query('api::year.year').findMany({});
};

/**
 * Pay VAT on a set of documents. Uses parameter-bound rawExecute (R11 fix —
 * the v3 string-interpolation SQL injection is gone).
 */
const VAT_FIELDS = ['vat_paid_date', 'deductible_vat_pct'];

const payEntity = async (documents, entitySlug, vatPaidDate, deductibleVatPct, years) => {
  const table = ENTITY_TABLE[entitySlug];
  if (!table) throw new Error(`Unknown entity: ${entitySlug}`);
  let totalVat = 0;
  for (const doc of documents) {
    const emittedYear = doc.emitted?.substring(0, 4);
    const isDeductible = entitySlug !== 'received-income' && entitySlug !== 'emitted-invoice';
    const deductibleVatPctYear = isDeductible
      ? years.find((y) => String(y.year) === String(emittedYear))?.deductible_vat_pct || deductibleVatPct
      : 100;

    // The raw UPDATE skips the document service, so the change log is fed
    // here, reading only the two fields it writes (not the lines, issues/161).
    const uid = ENTITY_UID[entitySlug];
    const before = changeLog.isTracked(uid)
      ? await changeLog.rowWith(uid, { id: doc.id }, VAT_FIELDS).catch(() => null)
      : null;
    await rawExecute(strapi, `UPDATE ${table} SET vat_paid_date = ?, deductible_vat_pct = ? WHERE id = ?`, [
      vatPaidDate,
      deductibleVatPctYear,
      doc.id,
    ]);
    await changeLog.logRawUpdate(uid, before, VAT_FIELDS);
    totalVat += (doc.total_vat * deductibleVatPctYear) / 100.0;
  }
  return totalVat;
};

const ENTITY_UID = {
  'emitted-invoice': 'api::emitted-invoice.emitted-invoice',
  'received-income': 'api::received-income.received-income',
  'received-invoice': 'api::received-invoice.received-invoice',
  'received-expense': 'api::received-expense.received-expense',
};

/**
 * After the email went out: the invoice is sent today, and its history says
 * who sent it to which address (issues/161). Raw UPDATE like payEntity: an
 * issued invoice is not updatable, and a document-service save would rerun
 * the VeriFactu/FACe enqueue of afterUpdate. Never fails the send.
 */
async function markSent(invoice, to) {
  const uid = 'api::emitted-invoice.emitted-invoice';
  try {
    const sentDate = toLocalDay(new Date());
    await rawExecute(strapi, 'UPDATE emitted_invoices SET sent = ?, sent_date = ? WHERE id = ?', [
      true,
      sentDate,
      invoice.id,
    ]);
    const changes = [
      { field: 'sent', from: Boolean(invoice.sent), to: true },
      { field: 'sent_date', from: invoice.sent_date || null, to: sentDate },
    ].filter((c) => c.from !== c.to);
    await changeLog.logEvent(uid, {
      action: 'email',
      row: { id: invoice.id, code: invoice.code },
      changes: changes.length ? changes : null,
      details: { to },
    });
  } catch (error) {
    strapi.log.error(`[send-email] invoice ${invoice.id} sent, but not marked as sent: ${error.message}`);
  }
}

module.exports = createCoreController('api::emitted-invoice.emitted-invoice', ({ strapi }) => ({
  // v3 query-param compatibility (P9): translate _limit/_start/_sort/_q/_where
  // and flat field operators to native v5 params before core handling.
  // v5-native queries pass through untouched.
  async find(ctx) {
    adaptCtxQuery(ctx);
    return super.find(ctx);
  },

  /**
   * findOne override — ports the v3 afterFindOne hook (removed in v5): injects
   * the FACe queue status and VeriFactu chain state onto the invoice response
   * when the corresponding integration is enabled.
   */
  async findOne(ctx) {
    const response = await super.findOne(ctx);
    const invoice = response?.data?.attributes || response?.data;
    if (!invoice || !invoice.id) return response;

    const me = await getMe();
    if (me && (me.face === 'test' || me.face === 'real')) {
      const faceQueue = await strapi.db
        .query('api::face-queue.face-queue')
        .findOne({ where: { mode: me.face, emitted_invoice: invoice.id } });
      invoice.face_queue = faceQueue ? faceQueue.status : 'missing';
    }

    const verifactu = await strapi.documents('api::verifactu.verifactu').findFirst();
    if (verifactu && (verifactu.mode === 'test' || verifactu.mode === 'real')) {
      const chain = await strapi.db
        .query('api::verifactu-chain.verifactu-chain')
        .findOne({ where: { mode: verifactu.mode, emitted_invoice: invoice.id } });
      invoice.verifactu_chain = chain ? chain.state : 'missing';
    }

    return response;
  },

  /**
   * PUT /api/emitted-invoices/:id/payment-method  body: { payment_method }
   *
   * issues/001: the payment method stays editable after emission, because the
   * payment sometimes reaches a different bank than expected. Only the payment
   * method and the bank account derived from it change, also on an invoice
   * marked not updatable. Every other field keeps its lock.
   * The write goes through the document service, so the change log records it.
   * The PDF is not regenerated: it stays as it was issued to the client.
   */
  async updatePaymentMethod(ctx) {
    const uid = 'api::emitted-invoice.emitted-invoice';
    const { id } = ctx.params;
    const body = ctx.request.body || {};
    const paymentMethodId = relationId(body.data ? body.data.payment_method : body.payment_method);
    if (!paymentMethodId) return ctx.badRequest('payment_method is required');

    const where = /^\d+$/.test(String(id)) ? { id: Number(id) } : { documentId: id };
    const invoice = await strapi.db.query(uid).findOne({ where, populate: { payment_method: true } });
    if (!invoice) return ctx.notFound('emitted-invoice not found');

    const paymentMethod = await strapi.db
      .query('api::payment-method.payment-method')
      .findOne({ where: { id: paymentMethodId }, populate: { bank_account: true } });
    if (!paymentMethod) return ctx.badRequest('payment_method not found');

    if (relationId(invoice.payment_method) !== paymentMethod.id) {
      const data = {
        payment_method: paymentMethod.id,
        // Treasury groups invoices by bank_account: a method without one must
        // not leave the old method's bank behind.
        bank_account: relationId(paymentMethod.bank_account) || null,
        // One-shot pass through the updatable guard; beforeUpdate resets it.
        updatable_admin: true,
      };
      if (ctx.state && ctx.state.user) data.user_last = ctx.state.user.id;
      await strapi.documents(uid).update({ documentId: invoice.documentId, data });
    }

    return strapi.db
      .query(uid)
      .findOne({ where: { id: invoice.id }, populate: { payment_method: true, bank_account: true } });
  },

  async findBasic(ctx) {
    const opts = adaptQuery(ctx.query);
    // issues/260: `_limit=0` = no rows, as in v3 (db.query ignores limit 0)
    if (wantsNoRows(opts)) return [];
    return strapi.db.query('api::emitted-invoice.emitted-invoice').findMany({
      where: opts.filters || {},
      // issues/013: v3 auto-populated components; v5 does not. The lists read
      // lines[0].concept (Concepte column, Excel export) and contact_info.
      populate: { contact: true, projects: true, document_type: true, lines: true, contact_info: true },
      limit: dbLimit(opts),
      offset: opts.pagination?.start,
      orderBy: opts.sort,
    });
  },

  /**
   * GET /api/emitted-invoices/pdf/:doc/:id
   * Generates (or regenerates) the PDF for an invoice/quote/expense document.
   * doc = emitted-invoice | received-invoice | received-expense | received-income | quote
   */
  async pdf(ctx) {
    const { id, doc } = ctx.params;
    const docUid =
      doc === 'quote'
        ? 'api::quote.quote'
        : doc === 'received-income'
          ? 'api::received-income.received-income'
          : doc === 'received-expense'
            ? 'api::received-expense.received-expense'
            : doc === 'received-invoice'
              ? 'api::received-invoice.received-invoice'
              : 'api::emitted-invoice.emitted-invoice';

    const invoice = await strapi.db.query(docUid).findOne({
      where: { id },
      // contact_info: the client as saved with the document, which the PDF prints
      populate: {
        contact: true,
        contact_info: true,
        document_type: true,
        payment_method: true,
        lines: true,
        // whether it is a rectificative (only emitted invoices have them)
        ...(docUid === 'api::emitted-invoice.emitted-invoice' ? { serial: true, rectified_invoice: true } : {}),
      },
    });
    const me = await getMe();

    // null when there is no logo or its file is missing: the PDF is drawn without it
    const logo = await resolvePdfLogo(me, { sharp, log: strapi.log });

    const width = me.logo ? me.logo.width : 150;
    const height = me.logo ? me.logo.height : 150;
    const logoWidth = 150;
    const qrWidth = 65;
    const ratio = width / logoWidth;
    const qr = invoice.qr;

    const invoiceHeader = [
      { label: 'Número', value: invoice.code },
      { label: 'Data', value: moment(invoice.emitted, 'YYYY-MM-DD').format('DD-MM-YYYY') },
    ];
    if (invoice.paybefore) {
      invoiceHeader.push({
        label: 'Venciment',
        value: moment(invoice.paybefore, 'YYYY-MM-DD').format('DD-MM-YYYY'),
      });
    } else if (invoice.paid && invoice.paid_date && doc === 'received-expense') {
      invoiceHeader.push({
        label: 'Pagada',
        value: moment(invoice.paid_date, 'YYYY-MM-DD').format('DD-MM-YYYY'),
      });
    }

    const showDate = invoice.lines?.find((l) => l.date) !== undefined;
    // any quantity but 1: a rectificative's −3 hid the Q. and Base columns (issues/213)
    const showQuantity = invoice.lines?.find((l) => l.quantity && l.base && Number(l.quantity) !== 1) !== undefined;
    const showVat = true;
    const showIrpf = invoice.lines?.find((l) => l.irpf > 0) !== undefined;
    const showDiscount = invoice.lines?.find((l) => l.discount > 0) !== undefined;
    const euro = 'EUR';

    let conceptWidth = 0.35;
    const totalExtra =
      (showDate ? 1 : 0) +
      (showQuantity ? 2 : 0) +
      (showVat ? 1 : 0) +
      (showIrpf ? 1 : 0) +
      (showDiscount ? 1 : 0);
    if (totalExtra >= 4) conceptWidth = 0.25;
    else if (totalExtra >= 3) conceptWidth = 0.3;
    const columnsWidth =
      conceptWidth +
      (showDate ? 0.1 : 0) +
      (showQuantity ? 0.16 : 0) +
      0.19 +
      (showVat ? 0.1 : 0) +
      (showIrpf ? 0.1 : 0) +
      (showDiscount ? 0.1 : 0) +
      0.1;
    const cr = 1 / columnsWidth;

    const detailsHeader = [{ value: 'Concepte', width: conceptWidth * cr }];
    if (showDate) detailsHeader.push({ value: 'Data', width: 0.12 * cr });
    if (showQuantity) {
      detailsHeader.push({ value: 'Q.', width: 0.07 * cr });
      detailsHeader.push({ value: 'Base', width: 0.09 * cr });
    }
    detailsHeader.push({ value: 'Base imposable', width: 0.18 * cr });
    if (showDiscount) detailsHeader.push({ value: 'Descompte', width: 0.1 * cr });
    if (showVat) detailsHeader.push({ value: 'IVA', width: 0.1 * cr });
    if (showIrpf) detailsHeader.push({ value: 'IRPF', width: 0.1 * cr });
    detailsHeader.push({ value: 'Subtotal', width: 0.1 * cr });

    const parts = [];
    for (const line of invoice.lines || []) {
      if (!line.quantity || !line.base) continue;
      const part = [];
      let concept = line.concept || '';
      if (line.comments) concept += '\n\n' + line.comments;
      part.push({ value: concept, width: conceptWidth * cr });
      if (showDate) part.push({ value: line.date, width: 0.12 * cr });
      const amounts = lineAmounts(line);
      if (showQuantity) part.push({ value: formatNumber(line.quantity), width: 0.07 * cr });
      if (showQuantity) part.push({ value: formatUnitPrice(line.base), width: 0.09 * cr, price: true });
      part.push({ value: amounts.gross, price: true, width: 0.18 * cr });
      if (showDiscount)
        part.push({
          value: `${formatCurrency(amounts.discount)} ${euro} (${formatNumber(line.discount)}%)`,
          width: 0.1 * cr,
        });
      if (showVat)
        part.push({
          value:
            line.vat > 0 ? `${formatCurrency(amounts.vat)} ${euro} (${formatNumber(line.vat)}%)` : `0 ${euro} (0%)`,
          width: 0.1 * cr,
        });
      if (showIrpf)
        part.push({
          value: `${formatCurrency(-1 * amounts.irpf)} ${euro} (${formatNumber(line.irpf)}%)`,
          width: 0.1 * cr,
        });
      part.push({ value: amounts.total, price: true, width: 0.1 * cr });
      parts.push(part);
    }

    const total = [];
    if (invoice.lines?.some((l) => l.discount > 0)) {
      // As the form: the discount is what takes the base without discount down
      // to the (rounded) taxable base (issues/243).
      const withoutDiscount = round2(
        invoice.lines.filter((l) => l.quantity && l.base).reduce((s, l) => s + lineAmounts(l).gross, 0),
      );
      total.push({ label: 'Base sense descompte', value: withoutDiscount, price: true });
      total.push({ label: 'Descompte', value: round2(withoutDiscount - (invoice.total_base || 0)), price: true });
    }
    total.push({ label: 'Base imposable', value: invoice.total_base, price: true });
    if (showVat) total.push({ label: 'IVA', value: invoice.total_vat, price: true });
    if (showIrpf) total.push({ label: 'IRPF', value: -1 * invoice.total_irpf, price: true });
    total.push({ label: 'TOTAL', value: invoice.total, price: true });

    const legal = [];
    if (invoice.comments) legal.push({ value: invoice.comments, color: 'secondary' });
    if (invoice?.payment_method?.invoice_text && doc === 'emitted-invoice') {
      legal.push({ value: invoice.payment_method.invoice_text, weight: 'bold', color: 'primary' });
    }
    if (me.invoice_footer && doc === 'emitted-invoice')
      legal.push({ value: me.invoice_footer, color: 'secondary' });
    else if (me.quote_footer && doc === 'quote') legal.push({ value: me.quote_footer, color: 'secondary' });

    // A rectificative must say so (RD 1619/2012, art. 15): «Factura» stayed (issues/213)
    let name =
      invoice.document_type?.name ||
      (doc === 'quote' ? (invoice.proforma ? 'Factura Proforma' : 'Pressupost') : 'Factura');
    const rectificative = invoice.serial?.rectificative || invoice.rectified_invoice;
    if (docUid === 'api::emitted-invoice.emitted-invoice' && rectificative && !/rectificativa/i.test(name)) {
      name = `${name} rectificativa`;
    }

    const myInvoice = new MicroInvoice({
      style: {
        header: {
          image: logo ? { path: logo, width: logoWidth, height: height / ratio } : null,
          qr: qr ? { path: qr, verifactu: true, width: qrWidth, height: qrWidth } : null,
        },
      },
      data: {
        invoice: {
          name,
          header: invoiceHeader,
          currency: 'EUR',
          customer: [
            {
              label: doc !== 'emitted-invoice' && doc !== 'quote' ? 'PROVEÏDOR/A' : 'CLIENT/A',
              value: [
                invoice.contact_info?.name || invoice.contact?.name,
                invoice.contact_info?.nif || invoice.contact?.nif,
                invoice.contact_info?.address || invoice.contact?.address,
                invoice.contact_info?.postcode && invoice.contact_info?.city
                  ? `${invoice.contact_info.postcode} ${invoice.contact_info.city}`
                  : `${invoice.contact?.postcode || ''} ${invoice.contact?.city || ''}`,
              ],
            },
          ],
          seller: [
            {
              label: doc !== 'emitted-invoice' && doc !== 'quote' ? 'CLIENT/A' : 'PROVEÏDOR/A',
              value: [me.name, me.nif, me.address, `${me.postcode} ${me.city}`, me.email].filter(Boolean),
            },
          ],
          legal,
          details: { header: detailsHeader, parts, total },
        },
      },
    });

    if (!fs.existsSync('./public/uploads/documents')) {
      fs.mkdirSync('./public/uploads/documents', { recursive: true });
    }
    const hash = crypto
      .createHash('md5')
      .update(`${myInvoice.options.data.invoice.name}-${invoice.code}-${id}`)
      .digest('hex');
    const docName = `./public/uploads/documents/${myInvoice.options.data.invoice.name}-${invoice.contact?.name}-${invoice.code}-H${hash.substring(16)}.pdf`;
    await myInvoice.generate(docName);

    // Update the document's pdf path. `strapi.db.query().update()` still runs the
    // content type's lifecycles in v5, so this needs the v3 `_internal` flag the
    // lifecycles check: without it a payload carrying only `pdf` looks like a
    // real edit, and quote's beforeUpdate then recomputes the totals from an
    // absent `lines` (zeroing them) and re-derives `code` from an absent
    // `serial` — which is what made every quote PDF answer 500.
    await strapi.db.query(docUid).update({
      where: { id: invoice.id },
      data: { pdf: docName.substring('./public'.length), _internal: true },
    });

    return { url: docName.substring('./public'.length) };
  },

  /**
   * GET /api/emitted-invoices/send-email/:id
   * Sends the invoice PDF by email to the contact's email address.
   */
  async sendInvoiceByEmail(ctx) {
    const { id } = ctx.params;
    try {
      const invoice = await strapi.db
        .query('api::emitted-invoice.emitted-invoice')
        .findOne({ where: { id }, populate: { contact: true } });

      if (invoice && invoice.contact?.contact_email && invoice.pdf) {
        const me = await getMe();
        const attachments = [
          {
            filename: `Factura-${invoice.code}.pdf`,
            content: fs.readFileSync(`./public${invoice.pdf}`).toString('base64'),
            encoding: 'base64',
          },
        ];
        await strapi
          .plugin('email')
          .service('email')
          .send({
            to: invoice.contact.contact_email,
            from: me.invoice_email,
            bcc: me.invoice_email,
            subject: me.invoice_subject.replace('{invoice_code}', invoice.code),
            ...buildEmailBody(me.invoice_template, {
              invoice_code: invoice.code,
              contact_name: invoice.contact.contact_person || invoice.contact.name,
            }),
            attachments,
          });
        await markSent(invoice, invoice.contact.contact_email);
        return { done: true };
      }
      // Diagnose what's missing
      if (!invoice) return ctx.send({ done: false, msg: 'Could not sent email' }, 500);
      if (!invoice.contact) return ctx.send({ done: false, msg: 'Could not sent email. No contact' }, 500);
      if (!invoice.contact.contact_email)
        return ctx.send({ done: false, msg: 'Could not sent email. No Contact email' }, 500);
      if (!invoice.pdf) return ctx.send({ done: false, msg: 'Could not sent email. No pdf' }, 500);
      return ctx.send({ done: false, msg: 'Could not sent email' }, 500);
    } catch (error) {
      console.log('error', JSON.stringify(error));
      return ctx.send({ done: false, msg: 'Error sending email' }, 500);
    }
  },

  /**
   * POST /api/emitted-invoices/pay-vat-ids
   * Pay VAT on specific emitted/received documents by id, creating a treasury entry.
   */
  async payVatIds(ctx) {
    const { emittedInvoices, receivedIncomes, receivedInvoices, receivedExpenses, vat_paid_date } =
      ctx.request.body;

    const eInvoiceInfo = await getEntityInfo(ENTITY_UID['emitted-invoice']);
    const incomeInfo = await getEntityInfo(ENTITY_UID['received-income']);
    const rInvoiceInfo = await getEntityInfo(ENTITY_UID['received-invoice']);
    const expenseInfo = await getEntityInfo(ENTITY_UID['received-expense']);
    const me = await getMe();
    const bankAccountVat = me.bank_account_vat;
    const years = await getYearsInfo();

    if (me.options?.deductible_vat_pct) {
      let totalVat = 0;
      totalVat += await payEntity(
        eInvoiceInfo.documents.filter((d) => emittedInvoices.includes(d.id)),
        'emitted-invoice',
        vat_paid_date,
        100,
        years,
      );
      totalVat += await payEntity(
        incomeInfo.documents.filter((d) => receivedIncomes.includes(d.id)),
        'received-income',
        vat_paid_date,
        me.options.deductible_vat_pct,
        years,
      );
      totalVat -= await payEntity(
        rInvoiceInfo.documents.filter((d) => receivedInvoices.includes(d.id)),
        'received-invoice',
        vat_paid_date,
        me.options.deductible_vat_pct,
        years,
      );
      totalVat -= await payEntity(
        expenseInfo.documents.filter((d) => receivedExpenses.includes(d.id)),
        'received-expense',
        vat_paid_date,
        me.options.deductible_vat_pct,
        years,
      );

      if (totalVat !== 0) {
        await strapi.service('api::treasury.treasury').create({
          data: {
            comment: 'IVA Saldat',
            total: -1 * totalVat,
            date: vat_paid_date,
            bank_account: bankAccountVat,
            publishedAt: new Date(),
          },
        });
      }
    }
    return {
      done: true,
      emittedInvoices: eInvoiceInfo.documents,
      receivedIncomes: incomeInfo.documents,
      receivedInvoices: rInvoiceInfo.documents,
      receivedExpenses: expenseInfo.documents,
    };
  },

  /**
   * POST /api/emitted-invoices/pay-vat
   * Pay VAT on ALL unpaid documents (no id selection).
   */
  async payVat(ctx) {
    const eInvoiceInfo = await getEntityInfo(ENTITY_UID['emitted-invoice']);
    const incomeInfo = await getEntityInfo(ENTITY_UID['received-income']);
    const rInvoiceInfo = await getEntityInfo(ENTITY_UID['received-invoice']);
    const expenseInfo = await getEntityInfo(ENTITY_UID['received-expense']);
    const me = await getMe();
    const bankAccountVat = me.bank_account_vat;
    const years = await getYearsInfo();

    if (me.options?.deductible_vat_pct) {
      const vatPaidDate = new Date();
      let totalVat = 0;
      totalVat += await payEntity(eInvoiceInfo.documents, 'emitted-invoice', vatPaidDate, 100, years);
      totalVat += await payEntity(
        incomeInfo.documents,
        'received-income',
        vatPaidDate,
        me.options.deductible_vat_pct,
        years,
      );
      totalVat -= await payEntity(
        rInvoiceInfo.documents,
        'received-invoice',
        vatPaidDate,
        me.options.deductible_vat_pct,
        years,
      );
      totalVat -= await payEntity(
        expenseInfo.documents,
        'received-expense',
        vatPaidDate,
        me.options.deductible_vat_pct,
        years,
      );

      if (totalVat !== 0) {
        await strapi.service('api::treasury.treasury').create({
          data: {
            comment: 'IVA Saldat',
            total: -1 * totalVat,
            date: vatPaidDate,
            bank_account: bankAccountVat,
            publishedAt: new Date(),
          },
        });
      }
    }
    return {
      done: true,
      emittedInvoices: eInvoiceInfo.documents,
      receivedIncomes: incomeInfo.documents,
      receivedInvoices: rInvoiceInfo.documents,
      receivedExpenses: expenseInfo.documents,
    };
  },

  /**
   * GET /api/emitted-invoices/pending-provider
   * Returns unpaid (no paid date), sent, issued invoices for the current user's provider contacts.
   */
  async pendingProvider(ctx) {
    try {
      const user = ctx.state.user;
      const providers = await strapi.db
        .query('api::contact.contact')
        .findMany({ where: { users_permissions_user: user.id } });
      const providerIds = providers.map((p) => p.id);
      if (!providerIds.length) return { invoices: [] };

      const invoices = await strapi.db
        .query('api::emitted-invoice.emitted-invoice')
        .findMany({ where: { contact: { $in: providerIds } } });

      // one rule for «paid», the one her «Factures» list uses: the paid date
      // (`paid` could be NULL on a paid invoice); drafts are not hers yet
      // (issues/155)
      return { invoices: invoices.filter((i) => !i.paid_date && i.sent && i.state !== 'draft') };
    } catch (error) {
      console.log('error', error);
      return { invoices: 0 };
    }
  },
}));
