'use strict';
/* global strapi */

/**
 * The draft invoices of a set of orders, one per member: «Facturar» (POST
 * /orders/invoice) and the automatic monthly run (issues/430) create them the
 * same way. Lifted from the order controller's invoiceRun.
 *
 * Each group gives its member, her contact, her orders and the invoice's
 * lines (by default one per order). The orders are stamped «invoiced» and
 * linked to their invoice with raw SQL (no order lifecycle), the change log
 * records it, and each invoice gets its income line on the project's last
 * phase.
 */
const { rawExecute } = require('../../../services/raw-sql');
const changeLog = require('../../../services/change-log');
const { orderInvoiceLine } = require('./final-price');
const { orderLineConcept, invoiceConcept, invoicePdfConcept } = require('./invoice-line-concept');

/** An order's invoice line: base and discount from the shared formula (issues/145). */
function orderLine(order) {
  return {
    concept: orderLineConcept(order),
    ...orderInvoiceLine(order),
    quantity: 1,
    price: order.price,
    vat: 21,
    irpf: 0,
  };
}

/**
 * The project with its phases and their incomes, or `{ error }` when it has no
 * phase to take the income lines.
 */
async function invoicingProject(projectId) {
  const project = await strapi.db.query('api::project.project').findOne({
    where: { id: projectId },
    populate: { project_phases: { populate: { incomes: { populate: { invoice: true, income: true } } } } },
  });
  if (!project?.project_phases?.length) {
    return { error: `ERROR. No hi ha fases per al projecte ${project?.name}` };
  }
  const phase = project.project_phases[project.project_phases.length - 1];
  if (!phase.incomes) {
    return { error: `ERROR. No hi ha incomes per a la fase del projecte ${project.name}` };
  }
  return { project, phase };
}

/**
 * Creates the drafts. `groups`: [{ owner, contact, orders, lines?, note? }].
 * `emitted`: the invoice date (a Date or YYYY-MM-DD). Returns
 * [{ invoice, contact, contactOrders, owner }].
 */
async function createOrderInvoices({ groups, project, phase, serialId, verifactuEnabled, paymentMethod, pdfConceptText, emitted, log = () => {} }) {
  const invoicesByOwner = await Promise.all(
    groups.map(async ({ owner, contact, orders, lines, note }) => {
      const invoice = await strapi.service('api::emitted-invoice.emitted-invoice').create({
        data: {
          emitted,
          serial: serialId,
          contact: contact.id,
          verifactu: verifactuEnabled,
          payment_method: paymentMethod,
          document_concept: invoiceConcept(orders),
          concept: invoicePdfConcept(orders, pdfConceptText),
          lines: lines || orders.map(orderLine),
          ...(note ? { comments_internal: note } : {}),
          projects: [project.id],
          publishedAt: new Date(),
        },
      });
      return { invoice, contact, contactOrders: orders, owner };
    }),
  );
  log('INVOICES_CREATED', `${invoicesByOwner.length} invoices created`);

  // Bulk update order status via parameterized raw SQL (lifecycle bypass).
  // `emitted_invoice` was an FK column on `orders` in v3; in v5 the relation
  // lives in orders_emitted_invoice_lnk and the column no longer exists, so
  // the link has to be rewritten separately from the scalar columns.
  for (const { invoice, contactOrders } of invoicesByOwner) {
    const ids = contactOrders.map((o) => o.id);
    if (ids.length === 0) continue;
    const placeholders = ids.map(() => '?').join(',');
    await rawExecute(
      strapi,
      `UPDATE orders SET emitted_invoice_datetime = NOW(), status = 'invoiced', updated_at = NOW() WHERE id IN (${placeholders})`,
      ids,
    );
    await rawExecute(strapi, `DELETE FROM orders_emitted_invoice_lnk WHERE order_id IN (${placeholders})`, ids);
    await rawExecute(
      strapi,
      `INSERT INTO orders_emitted_invoice_lnk (order_id, emitted_invoice_id) VALUES ${ids.map(() => '(?, ?)').join(', ')}`,
      ids.flatMap((id) => [id, invoice.id]),
    );
    // the raw UPDATE skips the change log's middleware (issues/119)
    const invoicedAt = new Date();
    await changeLog.logChanges(
      'api::order.order',
      contactOrders.map((o) => ({
        row: { id: o.id },
        changes: [
          { field: 'status', from: o.status, to: 'invoiced' },
          { field: 'emitted_invoice', from: o.emitted_invoice, to: invoice },
          { field: 'emitted_invoice_datetime', from: o.emitted_invoice_datetime, to: invoicedAt },
        ],
      })),
    );
  }

  // One income line per invoice on the project's last phase. v3 pushed the
  // lines into the populated phase and saved the project, and its project
  // lifecycle wrote them out; in v5 phase incomes are their own collection and
  // that nested update silently wrote nothing, so every draft from this run
  // reached the project without its income line. Create the rows directly.
  //
  // The amount is the invoice's own base, not a recomputation from the
  // orders: v3 compounded the multidelivery and pickup discounts here while
  // the invoice lines add them, so the income drifted from what was billed.
  // dated as the invoice (the monthly run dates it the month's last day)
  const incomeDate = emitted || new Date();
  for (const { invoice, contact } of invoicesByOwner) {
    const amount = Number(invoice.total_base) || 0;
    await strapi.db.query('api::phase-income.phase-income').create({
      data: {
        concept: `Factura #${invoice.code}# - ${contact.trade_name || contact.name}`,
        quantity: 1,
        amount,
        total_amount: amount,
        date: incomeDate,
        income_type: 1,
        invoice: invoice.id,
        paid: false, // pending until the invoice is paid (issues/153)
        date_estimate_document: incomeDate,
        vat_pct: 21,
        project_phase: phase.id,
      },
    });
  }
  return invoicesByOwner;
}

module.exports = { createOrderInvoices, invoicingProject, orderLine };
