'use strict';
/* global strapi */

/**
 * Automatic monthly invoicing (issues/430): reads the month, creates the
 * drafts, tells the members whose draft could not be made (Avisos), mails the
 * report «FACTURACIÓ AUTOMÀTICA» to the office (the incidences' address) and
 * records the run. The rules are in plan.js.
 *
 * - The cron (config/cron.js) calls maybeRun() every 10 minutes: the month's
 *   run starts once, on its day from 14:10 (a run of the month already
 *   recorded, whatever its result, is not repeated by the cron).
 * - The office can preview a month (nothing written) and run it by hand
 *   (Logística › Facturar); a run by hand takes what is still to invoice.
 * - Runs are serialised in the process, and the orders on any invoice are
 *   never taken, so two runs can't invoice an order twice.
 */
const moment = require('moment');
const { getMe } = require('../me-settings');
const { escapeHtml } = require('../email-body');
const { lateRules } = require('../late-order');
const { currentTimeZone } = require('../time-zone');
const { createOrderInvoices, invoicingProject, orderLine } = require('../../api/order/services/order-invoices');
const plan = require('./plan');
const quarters = require('./quarter-project');

const ORDER = 'api::order.order';
const RUN = 'api::auto-invoicing-run.auto-invoicing-run';
const NOTICE = 'api::member-notice.member-notice';

let running = false;

const splitEmails = (list) =>
  (list || '')
    .split(',')
    .map((e) => e.trim())
    .filter(Boolean);
const money = (n) => `${(Number(n) || 0).toFixed(2).replace('.', ',')} €`;
const ids = (list) => list.map((id) => String(id).padStart(4, '0')).join(', ');

/** The tenant's working days and the holidays for everyone around `month`. */
async function rulesFor(month) {
  const me = await getMe();
  const from = moment(`${month}-01`, 'YYYY-MM-DD').subtract(1, 'month').format('YYYY-MM-DD');
  const to = moment(`${month}-01`, 'YYYY-MM-DD').add(2, 'months').format('YYYY-MM-DD');
  const rows = await strapi.db.query('api::festive.festive').findMany({
    where: { date: { $gte: from, $lte: to } },
    select: ['id', 'date'],
    populate: { users_permissions_user: { select: ['id'] } },
  });
  const holidays = (rows || []).filter((f) => f && f.date && !f.users_permissions_user).map((f) => String(f.date).slice(0, 10));
  return lateRules((me && me.orders_options) || {}, currentTimeZone(), { holidays });
}

/** The month's run as it stands: its day, its project, the last runs. */
async function status(now = new Date()) {
  const month = moment(now).format('YYYY-MM');
  const rules = await rulesFor(month);
  const due = plan.dueRun(now, rules);
  const invoiceDay = plan.lastDayOf(due.month);
  const projects = await quarters.loadProjects();
  const found = await quarters.quarterProjectFor(due.month, projects);
  const project = found.project && found.project.auto_invoicing ? found.project : null;
  const runs = await strapi.db.query(RUN).findMany({
    orderBy: { id: 'desc' },
    limit: 6,
    populate: { user: { select: ['id', 'username', 'fullname'] } },
  });
  const done = runs.find((r) => r.month === due.month && r.trigger === 'cron');
  return {
    month: due.month,
    monthName: plan.monthName(due.month),
    runAt: due.at,
    invoiceDay,
    // the project the drafts go to: the quarter's, with the option on
    project: project ? { id: project.id, name: project.name } : null,
    // the quarter and its project with the option or not, its model, the name of a new one
    quarter: found.quarter,
    quarterProject: found.project,
    latestProject: found.latest,
    newProjectName: found.newName,
    otherProjects: found.others.filter((p) => p.auto_invoicing).map((p) => ({ id: p.id, name: p.name })),
    // any project with the option: the entity turned it on
    autoProjects: projects.filter((p) => p.auto_invoicing && !p.trashed).map((p) => ({ id: p.id, name: p.name })),
    cronDone: Boolean(done),
    runs: runs.map((r) => ({
      id: r.id,
      month: r.month,
      status: r.status,
      trigger: r.trigger,
      started_at: r.started_at,
      finished_at: r.finished_at,
      user: r.user ? r.user.fullname || r.user.username : null,
      report: r.report,
    })),
  };
}

/** The contact each member is invoiced to: her first contact, as «Facturar» does. */
async function contactsByOwner() {
  const contacts = await strapi.db.query('api::contact.contact').findMany({
    select: ['id', 'name', 'trade_name'],
    populate: { users_permissions_user: { select: ['id'] } },
    orderBy: { id: 'asc' },
  });
  const map = new Map();
  for (const c of contacts) {
    const userId = c.users_permissions_user && c.users_permissions_user.id;
    if (userId && !map.has(userId)) map.set(userId, c);
  }
  return map;
}

/** The month's plan and the setup it needs, without writing anything. */
async function prepare(month) {
  const invoiceDay = plan.lastDayOf(month);
  const fatal = [];
  const found = await quarters.quarterProjectFor(month);
  const project = found.project && found.project.auto_invoicing ? found.project : null;
  const others = found.others.filter((p) => p.auto_invoicing);
  if (!found.project) {
    fatal.push(
      `No hi ha cap projecte de logística per al ${found.quarter.label}. ` +
        `Crea'l a Logística › Facturar («${found.newName}»).`,
    );
  } else if (!project) {
    fatal.push(
      `El projecte del ${found.quarter.label}, «${found.project.name}», no té «Habilitar facturació automàtica». Activa-ho al projecte.`,
    );
  }
  const year = invoiceDay.slice(0, 4);
  const serials = await strapi.db.query('api::serie.serie').findMany({ where: { name: year } });
  if (!serials.length) fatal.push(`No hi ha sèrie de factures per a l'any ${year}.`);
  let target = null;
  if (project) {
    target = await invoicingProject(project.id);
    if (target.error) fatal.push(target.error);
  }

  const orders = await strapi.db.query(ORDER).findMany({
    where: { estimated_delivery_date: { $lte: invoiceDay }, status: { $notIn: ['cancelled', 'invoiced'] } },
    populate: {
      owner: { select: ['id', 'username', 'fullname', 'email'] },
      route: { select: ['id', 'name'] },
      emitted_invoice: { select: ['id'] },
    },
  });
  const contacts = await contactsByOwner();
  const monthPlan = plan.planMonth({ month, orders, contactOf: (ownerId) => contacts.get(ownerId) || null });
  return { month, invoiceDay, project, others, serial: serials[0] || null, target, fatal, plan: monthPlan };
}

/** The orders expected in the month, not cancelled: what the invoices must add up to. */
async function expectedOrders(month) {
  const first = `${month}-01`;
  return strapi.db.query(ORDER).findMany({
    where: { estimated_delivery_date: { $gte: first, $lte: plan.lastDayOf(month) }, status: { $ne: 'cancelled' } },
    select: ['id', 'status', 'price', 'volume_discount', 'multidelivery_discount', 'contact_pickup_discount', 'late_order', 'late_surcharge'],
    populate: { emitted_invoice: { select: ['id'] } },
  });
}

/** The report of a run (also of a preview): JSON for the screen and the mail. */
function reportOf(prepared, { created = [], reconciliation = null, preview = false }) {
  const createdBy = new Map(created.map((c) => [c.owner, c.invoice]));
  const members = prepared.plan.owners.map((o) => {
    const invoice = createdBy.get(o.ownerId);
    return {
      owner: o.ownerId,
      name: o.ownerName,
      orders: o.current.length + Object.values(o.previous).reduce((n, l) => n + l.length, 0),
      current: o.current.length,
      previous: Object.fromEntries(Object.entries(o.previous).map(([k, l]) => [k, l.map((x) => x.id)])),
      amount: o.amount,
      blockers: o.blockers,
      warnings: o.warnings,
      invoice: invoice ? { id: invoice.id, total: invoice.total } : null,
      status: o.blockers.length ? 'blocked' : preview ? 'ready' : invoice ? 'created' : 'skipped',
    };
  });
  return {
    month: prepared.month,
    monthName: plan.monthName(prepared.month),
    invoiceDay: prepared.invoiceDay,
    project: prepared.project ? { id: prepared.project.id, name: prepared.project.name } : null,
    fatal: prepared.fatal,
    members,
    drafts: members.filter((m) => m.status === 'created' || m.status === 'ready').length,
    blocked: members.filter((m) => m.status === 'blocked').length,
    withWarnings: members.filter((m) => m.warnings.length).length,
    reconciliation,
    preview,
  };
}

/** The mail to the office: subject in capitals, everything to sort out. */
async function mailReport(report, me) {
  const to = splitEmails(me && me.contact_form_email);
  if (!to.length) {
    strapi.log.warn('[auto-invoicing] contact_form_email not set: the report is not mailed');
    return false;
  }
  const t = (v) => escapeHtml(v === undefined || v === null ? '' : String(v));
  const rows = [];
  if (report.fatal.length) {
    rows.push(`<p><b>No s'ha generat cap esborrany:</b></p><ul>${report.fatal.map((f) => `<li>${t(f)}</li>`).join('')}</ul>`);
  }
  rows.push(
    `<p>Mes: <b>${t(report.monthName)}</b> · data de les factures: ${t(moment(report.invoiceDay).format('DD/MM/YYYY'))}` +
      (report.project ? ` · projecte: <b>${t(report.project.name)}</b>` : '') + '</p>',
  );
  rows.push(
    `<p>Esborranys creats: <b>${report.drafts}</b> · sòcies sense esborrany: <b>${report.blocked}</b> · ` +
      `esborranys per revisar: <b>${report.withWarnings}</b></p>`,
  );
  const r = report.reconciliation;
  if (r) {
    rows.push(
      `<p><b>Quadrament amb Comandes (ruta prevista ${t(plan.ofName(report.monthName))}):</b> ${r.expected.count} comandes, ${money(r.expected.amount)}. ` +
        `Facturades ara: ${r.invoicedNow.count} (${money(r.invoicedNow.amount)}); abans: ${r.invoicedBefore.count} (${money(r.invoicedBefore.amount)}). ` +
        (r.ok
          ? '<b>Quadra.</b>'
          : `<b>No quadra:</b> en falten ${r.missing.count} (${money(r.missing.amount)}): ${t(ids(r.missing.orders))}.`) +
        '</p>',
    );
  }
  const problems = report.members.filter((m) => m.blockers.length || m.warnings.length);
  if (problems.length) {
    rows.push('<p><b>Incidències per sòcia:</b></p><ul>');
    for (const m of problems) {
      const items = [
        ...m.blockers.map((b) => `<li><b>Sense esborrany</b> — ${t(b.text)}: ${t(ids(b.orders))}</li>`),
        ...m.warnings.map((w) => `<li>Per revisar — ${t(w.text)}: ${t(ids(w.orders))}</li>`),
      ];
      rows.push(`<li>${t(m.name)}<ul>${items.join('')}</ul></li>`);
    }
    rows.push('</ul>');
  } else if (!report.fatal.length) {
    rows.push("<p>Cap incidència: s'han generat tots els esborranys.</p>");
  }
  rows.push("<p>Els esborranys són a Ingressos: cal revisar-los i emetre'ls. Les sòcies no els veuen com a pendents de pagar fins que s'emeten.</p>");
  const subject = `FACTURACIÓ AUTOMÀTICA - ${report.monthName.toUpperCase()}`;
  const from = strapi.config.get('plugin.email.config.settings.defaultFrom', '') || process.env.EMAIL_FROM || '';
  await strapi.plugin('email').service('email').send({ to, from, subject, html: rows.join('\n') });
  return true;
}

/** Avisos: a member whose draft could not be made is told why and which orders. */
async function noticeBlocked(report) {
  for (const m of report.members.filter((x) => x.status === 'blocked' && x.owner)) {
    const lines = m.blockers.map((b) => `${b.text}: ${ids(b.orders)}`);
    await strapi.db.query(NOTICE).create({
      data: {
        user: m.owner,
        kind: 'auto-invoicing',
        title: `No s'ha pogut generar la factura ${plan.ofName(report.monthName)}`,
        text:
          `La facturació automàtica ${plan.ofName(report.monthName)} no ha pogut generar la teva factura:\n` +
          `${lines.join('\n')}\n` +
          "L'oficina ho revisarà i et farà la factura.",
        orders: m.blockers.flatMap((b) => b.orders),
        read: false,
      },
    });
  }
}

/**
 * The month's run. `preview`: the report only. Returns the report; a run is
 * recorded (auto-invoicing-run) and mailed, a preview is not.
 */
async function run({ month, trigger = 'manual', user = null, preview = false } = {}) {
  if (!preview && running) {
    const error = new Error('Ja hi ha una facturació automàtica en curs.');
    error.status = 409;
    throw error;
  }
  if (!preview) running = true;
  let record = null;
  try {
    const prepared = await prepare(month);
    if (preview) {
      const expected = await expectedOrders(month);
      const ready = prepared.plan.owners.filter((o) => !o.blockers.length).flatMap((o) => [...o.current, ...Object.values(o.previous).flat()]);
      return reportOf(prepared, { preview: true, reconciliation: plan.reconcile({ expected, invoicedIds: ready.map((o) => o.id) }) });
    }
    record = await strapi.db.query(RUN).create({
      data: { month, trigger, status: 'running', started_at: new Date(), ...(user ? { user: user.id } : {}) },
    });

    let created = [];
    if (!prepared.fatal.length) {
      const me = await getMe({ orders_options: true });
      const verifactu = await strapi.documents('api::verifactu.verifactu').findFirst();
      const paymentMethods = await strapi.db.query('api::payment-method.payment-method').findMany({});
      const groups = prepared.plan.owners
        .filter((o) => !o.blockers.length)
        .map((o) => ({
          owner: o.ownerId,
          contact: o.contact,
          orders: [...o.current, ...Object.values(o.previous).flat()],
          lines: plan.draftLines(o, orderLine),
          note: plan.draftNote(o),
        }));
      if (groups.length) {
        created = await createOrderInvoices({
          groups,
          project: prepared.target.project,
          phase: prepared.target.phase,
          serialId: prepared.serial.id,
          verifactuEnabled: verifactu?.mode === 'test' || verifactu?.mode === 'real',
          paymentMethod: paymentMethods.length ? paymentMethods[0].id : null,
          pdfConceptText: me?.orders_options?.invoice_concept,
          emitted: prepared.invoiceDay,
        });
      }
    }
    const expected = await expectedOrders(month);
    const invoicedIds = created.flatMap((c) => c.contactOrders.map((o) => o.id));
    const report = reportOf(prepared, { created, reconciliation: plan.reconcile({ expected, invoicedIds }) });
    await noticeBlocked(report);
    const status = report.fatal.length ? 'failed' : report.blocked || !report.reconciliation.ok ? 'partial' : 'done';
    let mailed = false;
    try {
      mailed = await mailReport(report, await getMe());
    } catch (e) {
      strapi.log.error(`[auto-invoicing] the report mail failed: ${e.message}`);
    }
    report.mailed = mailed;
    await strapi.db.query(RUN).update({ where: { id: record.id }, data: { status, finished_at: new Date(), report } });
    strapi.log.info(`[auto-invoicing] ${month}: ${status}, ${report.drafts} drafts, ${report.blocked} blocked`);
    return report;
  } catch (error) {
    if (record) {
      await strapi.db.query(RUN).update({
        where: { id: record.id },
        data: { status: 'failed', finished_at: new Date(), report: { fatal: [error.message] } },
      });
    }
    throw error;
  } finally {
    if (!preview) running = false;
  }
}

/** The cron's call: the month's run when it is due and the cron has not run it yet. */
async function maybeRun(now = new Date()) {
  // an entity that never turned it on (no project with the option) is left alone;
  // one that did is told when the quarter's project is missing or without it
  const enabled = await strapi.db.query('api::project.project').count({ where: { auto_invoicing: true, $or: [{ trashed: false }, { trashed: null }] } });
  if (!enabled) return null;
  const rules = await rulesFor(moment(now).format('YYYY-MM'));
  const due = plan.dueRun(now, rules);
  if (!due.due) return null;
  const already = await strapi.db.query(RUN).findOne({ where: { month: due.month, trigger: 'cron' } });
  if (already) return null;
  return run({ month: due.month, trigger: 'cron' });
}

module.exports = { maybeRun, run, status, prepare, reportOf, mailReport, noticeBlocked };
