'use strict';
/* global strapi */

/**
 * emitted-invoice lifecycles (v5). Ported from v3 api/emitted-invoice/models/emitted-invoice.js.
 *
 * State machine: drafts start as code=ESBORRANY; converting to real assigns the
 * serie counter number (SERIE-000N) and locks core fields. Real invoices are
 * immutable (updatable=false) and cannot be deleted. Deletions bulk-unlink
 * orders via parameterized raw SQL (rawExecute — no lifecycle re-entry).
 *
 * afterUpdate enqueues VeriFactu-chain and FACe-queue items when the org
 * settings enable them, and regenerates the PDF on first render or on the
 * draft->real conversion.
 *
 * The v3 afterFindOne (face/verifactu status injection) moved to the
 * emitted-invoice controller's findOne override (v5 removed afterFindOne).
 */
const { scheduleFromEntityProjects } = require('../../../project/services/totalsRefreshScheduler');
const { rawExecute } = require('../../../../services/raw-sql');
const { getMe } = require('../../../../services/me-settings');
const { relationId } = require('../../../../services/relation-input');
// A plain Error from a lifecycle surfaces as a bare 500 'Internal Server Error',
// so the rule that rejected the write never reaches the user. ApplicationError
// answers 400 with the message, which the views already display.
const { errors: { ApplicationError } } = require('@strapi/utils');

module.exports = {
  async beforeCreate(event) {
    const data = event.params.data;
    data.state = 'draft';
    data.code = 'ESBORRANY';

    if (!data.payment_method) {
      const firstPaymentMethod = await strapi.db
        .query('api::payment-method.payment-method')
        .findOne({ populate: { bank_account: true } });
      if (firstPaymentMethod) {
        data.payment_method = firstPaymentMethod.id;
      }
    }
    const createPaymentMethodId = relationId(data.payment_method);
    if (createPaymentMethodId) {
      const paymentMethod = await strapi.db
        .query('api::payment-method.payment-method')
        .findOne({ where: { id: createPaymentMethodId }, populate: { bank_account: true } });
      if (paymentMethod && paymentMethod.bank_account) {
        data.bank_account = paymentMethod.bank_account.id || paymentMethod.bank_account;
      }
    }

    await fillContactInfo(data);
    await calculateTotals(data);
  },

  async afterCreate(event) {
    await regeneratePdf(event.result.id);
    scheduleFromEntityProjects(event.result);
  },

  async beforeUpdate(event) {
    const data = event.params.data;
    const invoice = await strapi.db
      .query('api::emitted-invoice.emitted-invoice')
      .findOne({ where: event.params.where });

    if (invoice && invoice.updatable === false && !(data.updatable_admin === true)) {
      throw new ApplicationError('emitted-invoice NOT updatable');
    }

    cleanupUserFields(data);

    const paymentMethodId = relationId(data.payment_method);
    if (paymentMethodId && invoice && paymentMethodId !== relationId(invoice.payment_method)) {
      const paymentMethod = await strapi.db
        .query('api::payment-method.payment-method')
        .findOne({ where: { id: paymentMethodId }, populate: { bank_account: true } });
      if (paymentMethod && paymentMethod.bank_account) {
        data.bank_account = paymentMethod.bank_account.id || paymentMethod.bank_account;
      }
    }

    await fillContactInfo(data);

    // Real invoices: lock the core fields to their stored values.
    if (invoice && invoice.state === 'real') {
      data.lines = invoice.lines;
      data.contact = invoice.contact;
      data.emitted = invoice.emitted;
      data.serial = invoice.serial;
      if (invoice.user_real) data.user_real = invoice.user_real;
      if (invoice.user_draft) data.user_draft = invoice.user_draft;
      data.comments = invoice.comments;
      data.code = invoice.code;
    }

    if (!data._internal) {
      data.updatable_admin = false;
      await handleState(data, invoice);
      await calculateTotals(data);
    } else {
      delete data.user_real;
    }

    cleanupUserFields(data);
  },

  async afterUpdate(event) {
    const data = event.params.data;

    // VeriFactu chain enqueue
    const verifactu = await strapi.documents('api::verifactu.verifactu').findFirst();
    const invoice = await strapi.db
      .query('api::emitted-invoice.emitted-invoice')
      // `contact` gates the FACe enqueue below and `user_real` is stamped on the
      // VeriFactu chain row. v3 got both from its automatic first-level populate;
      // without this `invoice.contact` is undefined, so `contact` stays null and
      // the FACe queue item is never created at all.
      .findOne({ where: event.params.where, populate: { contact: true, user_real: true } });

    if (
      verifactu &&
      (verifactu.mode === 'test' || verifactu.mode === 'real') &&
      invoice &&
      invoice.verifactu &&
      invoice.state === 'real'
    ) {
      const chains = await strapi.db
        .query('api::verifactu-chain.verifactu-chain')
        .findMany({ where: { emitted_invoice: invoice.id } });
      if (chains.length === 0) {
        const chain = {
          emitted_invoice: invoice.id,
          invoice_json: JSON.stringify(invoice),
          state: 'pending',
          mode: verifactu.mode,
          publishedAt: new Date(),
        };
        // v3 fell back to `users_permissions_user: 0` when the invoice had no
        // user_real, and stored the 0 harmlessly because Strapi 3 created no
        // foreign keys. v5 puts the relation in a link table WITH a constraint,
        // so writing 0 fails with "a foreign key constraint fails" — which
        // aborted the whole chain insert and left the invoice reading MISSING.
        // Leave the relation unset instead.
        const userId = relationId(invoice.user_real);
        if (userId) {
          chain.users_permissions_user = userId;
        }
        await strapi.db.query('api::verifactu-chain.verifactu-chain').create({ data: chain });
      }
    }

    // FACe queue enqueue
    const me = await getMe();
    const faceEnabled = me && (me.face === 'test' || me.face === 'real');
    let contact = null;
    if (invoice && invoice.contact) {
      const contactId = relationId(invoice.contact);
      if (contactId) {
        contact = await strapi.db.query('api::contact.contact').findOne({ where: { id: contactId } });
      }
    }
    if (
      faceEnabled &&
      invoice &&
      invoice.state === 'real' &&
      invoice.face !== true &&
      contact &&
      contact.face === true
    ) {
      const mode = me && me.face === 'real' ? 'real' : 'test';
      const queue = await strapi.db
        .query('api::face-queue.face-queue')
        .findMany({ where: { emitted_invoice: invoice.id }, limit: 1 });
      if (!queue || queue.length === 0) {
        await strapi.db.query('api::face-queue.face-queue').create({
          data: {
            emitted_invoice: invoice.id,
            mode,
            status: 'pending',
            publishedAt: new Date(),
          },
        });
      }
    }

    // Regenerate PDF: first render OR the draft->real conversion.
    const shouldRegeneratePdf =
      (invoice && !invoice.pdf) ||
      (invoice && invoice.state === 'real' && data.state === 'real' && data.code === 'ESBORRANY');
    if (invoice && shouldRegeneratePdf) {
      try {
        await regeneratePdf(event.params.where.id);
      } catch (err) {
        console.error('Error generating PDF after update:', err);
      }
    }

    scheduleFromEntityProjects(event.result);
    scheduleFromEntityProjects(data);
  },

  async beforeDelete(event) {
    const invoice = await strapi.db
      .query('api::emitted-invoice.emitted-invoice')
      .findOne({ where: event.params.where });
    if (invoice && invoice.state === 'real') {
      throw new ApplicationError('Cannot delete a real invoice');
    }
    // Bulk-unlink orders via raw SQL (no lifecycle re-entry) — parameter-bound.
    const orders = await strapi.db
      .query('api::order.order')
      .findMany({ where: { emitted_invoice: event.params.where.id } });
    if (orders && orders.length > 0) {
      const orderIds = orders.map((o) => o.id);
      const placeholders = orderIds.map(() => '?').join(',');
      // v3 cleared an FK column here; in v5 the relation is a link table row.
      await rawExecute(
        strapi,
        `UPDATE orders SET status = 'delivered', updated_at = NOW() WHERE id IN (${placeholders})`,
        orderIds,
      );
      await rawExecute(
        strapi,
        `DELETE FROM orders_emitted_invoice_lnk WHERE order_id IN (${placeholders})`,
        orderIds,
      );
    }
    scheduleFromEntityProjects(invoice);
  },
};

// Regenerate the invoice PDF via the controller action (v5: strapi.controller).
async function regeneratePdf(id) {
  await strapi.controller('api::emitted-invoice.emitted-invoice').pdf({
    params: { id, doc: 'emitted-invoice' },
  });
}

function cleanupUserFields(data) {
  for (const f of ['user_real', 'user_draft']) {
    if (f in data && (data[f] === '' || data[f] === null || data[f] === undefined)) {
      delete data[f];
    }
  }
}

/**
 * Draft -> real conversion ("Emetre factura").
 *
 * @param {object} data    the incoming payload
 * @param {object} [stored] the row as currently persisted (update only)
 *
 * The trigger is the STORED state, not the code the client happens to be
 * holding. v3 keyed off `data.code === 'ESBORRANY'`, which wedges the invoice
 * if the conversion ever fails after the client has already updated its own
 * copy: the form then sends the assigned code back, no branch matches, and the
 * button silently does nothing for good. Anything not yet real that is asked to
 * become real is a conversion.
 */
async function handleState(data, stored) {
  if (data._internal) return;

  const becomingReal = data.state === 'real' && (!stored || stored.state !== 'real');
  if (becomingReal || (data.code === 'ESBORRANY' && data.state === 'real')) {
    data.user_real = data.user_last;
    const serialId = relationId(data.serial) || (stored && relationId(stored.serial));
    // v5 passes an undefined binding straight to knex and throws; v3 answered null.
    const serial = serialId
      ? await strapi.db.query('api::serie.serie').findOne({ where: { id: serialId } })
      : null;
    if (serial) {
      const existingNumber = data.number || (stored && stored.number);
      if (existingNumber) {
        data.number = existingNumber;
      } else {
        const nextNumber = serial.emitted_invoice_number + 1;
        await strapi.db
          .query('api::serie.serie')
          .update({ where: { id: serialId }, data: { emitted_invoice_number: nextNumber } });
        data.number = nextNumber;
      }
      const zeroPad = (num, places) => String(num).padStart(places, '0');
      const places = serial.leadingZeros || 1;
      data.code = `${serial.name}-${zeroPad(data.number, places)}`;
    }
  } else if ((data.state === 'draft' || !data.state) && !(stored && stored.state === 'real')) {
    // Never walk a real invoice back to draft: a partial save that simply omits
    // `state` would otherwise reset its code to ESBORRANY and lose the number.
    data.state = 'draft';
    data.code = 'ESBORRANY';
  }
}

/**
 * Returns the invoice lines with their VALUES.
 *
 * v5 inserts the component rows before the db lifecycle runs and replaces the
 * payload's objects with bare references — `{ id, __pivot }` — so `data.lines`
 * no longer carries `base`, `quantity` or `vat` by the time beforeCreate sees
 * it. v3 handed the model the raw objects, which is why the same arithmetic
 * worked there and silently produced 0.00 totals on every invoice here.
 *
 * The component rows are already persisted at this point, so read them back.
 */
async function resolveLines(lines) {
  if (!Array.isArray(lines) || lines.length === 0) return [];
  const refs = lines.filter((l) => l && l.id !== undefined && l.base === undefined);
  if (refs.length === 0) return lines;
  const rows = await strapi.db
    .query('invoice-line.invoice-line')
    .findMany({ where: { id: { $in: refs.map((l) => l.id) } } });
  const byId = new Map(rows.map((r) => [r.id, r]));
  // Keep any line that already carried its values (a caller passing raw objects).
  return lines.map((l) => (l && l.base === undefined && byId.has(l.id) ? byId.get(l.id) : l));
}

async function calculateTotals(data) {
  if (data._internal) return;
  if (data.lines) {
    const lines = await resolveLines(data.lines);
    let total_base = 0;
    let total_vat = 0;
    let total_irpf = 0;
    lines.forEach((i) => {
      let base = (i.base ? i.base : 0) * (i.quantity ? i.quantity : 0);
      if (i.discount) {
        base = base * (1 - i.discount / 100.0);
      }
      const vat = (base * (i.vat ? i.vat : 0)) / 100.0;
      const irpf = (base * (i.irpf ? i.irpf : 0)) / 100.0;
      total_base += base;
      total_vat += vat;
      total_irpf += irpf;
    });
    data.total_base = total_base;
    data.total_vat = total_vat;
    data.total_irpf = total_irpf;
    data.total = data.total_base + data.total_vat - data.total_irpf;
  }
}

async function fillContactInfo(data) {
  if (data.contact_info === null || data.contact_info === undefined || data.state === 'draft') {
    if (data.contact) {
      const contactId = relationId(data.contact);
      if (contactId) {
        const contact = await strapi.db.query('api::contact.contact').findOne({ where: { id: contactId } });
        if (contact) {
          data.contact_info = {
            name: contact.name || null,
            nif: contact.nif || null,
            address: contact.address || null,
            postcode: contact.postcode || null,
            city: contact.city || null,
            state: contact.state || null,
            country: contact.country || null,
          };
        }
      }
    }
  }
}
