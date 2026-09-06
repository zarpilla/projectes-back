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
const { createCoreController } = require('@strapi/strapi').factories;
const { adaptCtxQuery, dbLimit } = require('../../../services/query-adapter');
const { adaptQuery } = require('../../../services/query-adapter');
const { rawExecute } = require('../../../services/raw-sql');
const { getMe } = require('../../../services/me-settings');

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

    await rawExecute(strapi, `UPDATE ${table} SET vat_paid_date = ?, deductible_vat_pct = ? WHERE id = ?`, [
      vatPaidDate,
      deductibleVatPctYear,
      doc.id,
    ]);
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

  async findBasic(ctx) {
    const opts = adaptQuery(ctx.query);
    return strapi.db.query('api::emitted-invoice.emitted-invoice').findMany({
      where: opts.filters || {},
      populate: { contact: true, projects: true, document_type: true },
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
      populate: { contact: true, document_type: true, payment_method: true, lines: true },
    });
    const me = await getMe();

    const logoUrl = me.logo ? `./public${me.logo.url}` : null;
    let logo = logoUrl;
    if (logoUrl && logoUrl.endsWith('.svg')) {
      logo = './public/uploads/invoice-logo.jpg';
      await sharp(logoUrl).png().toFile(logo);
    }

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
    const showQuantity = invoice.lines?.find((l) => l.quantity > 1) !== undefined;
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
      if (showQuantity) part.push({ value: line.quantity, width: 0.07 * cr });
      if (showQuantity) part.push({ value: line.base, width: 0.09 * cr, price: true });
      part.push({ value: line.quantity * line.base, price: true, width: 0.18 * cr });
      if (showDiscount)
        part.push({
          value: `${formatCurrency((line.quantity * line.base * line.discount) / 100)} ${euro} (${line.discount}%)`,
          width: 0.1 * cr,
        });
      if (showVat)
        part.push({
          value:
            line.vat > 0
              ? `${formatCurrency((line.quantity * line.base * (1 - line.discount / 100) * line.vat) / 100)} ${euro} (${line.vat}%)`
              : `0 ${euro} (0%)`,
          width: 0.1 * cr,
        });
      if (showIrpf)
        part.push({
          value: `${formatCurrency((-1 * line.quantity * line.base * line.irpf) / 100)} ${euro} (${line.irpf}%)`,
          width: 0.1 * cr,
        });
      part.push({
        value:
          line.quantity * line.base * (1 - line.discount / 100) -
          (line.quantity * line.base * (1 - line.discount / 100) * line.irpf) / 100 +
          (line.quantity * line.base * (1 - line.discount / 100) * line.vat) / 100,
        price: true,
        width: 0.1 * cr,
      });
      parts.push(part);
    }

    const total = [];
    if (invoice.lines?.some((l) => l.discount > 0)) {
      total.push({
        label: 'Base sense descompte',
        value: invoice.lines.reduce((s, l) => s + l.quantity * l.base, 0),
        price: true,
      });
      total.push({
        label: 'Descompte',
        value: invoice.lines.reduce((s, l) => s + (l.quantity * l.base * l.discount) / 100, 0),
        price: true,
      });
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

    const myInvoice = new MicroInvoice({
      style: {
        header: {
          image: { path: logo, width: logoWidth, height: height / ratio },
          qr: qr ? { path: qr, verifactu: true, width: qrWidth, height: qrWidth } : null,
        },
      },
      data: {
        invoice: {
          name:
            invoice.document_type?.name ||
            (doc === 'quote' ? (invoice.proforma ? 'Factura Proforma' : 'Pressupost') : 'Factura'),
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
            text: me.invoice_template
              .replace('{invoice_code}', invoice.code)
              .replace('{contact_name}', invoice.contact.contact_person || invoice.contact.name),
            attachments,
          });
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
   * Returns unpaid, sent invoices for the current user's provider contacts.
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

      return { invoices: invoices.filter((i) => i.paid !== true && i.sent) };
    } catch (error) {
      console.log('error', error);
      return { invoices: 0 };
    }
  },
}));
