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

module.exports = {
  async beforeCreate(event) {
    const data = event.data;
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
    if (data.payment_method) {
      const paymentMethod = await strapi.db
        .query('api::payment-method.payment-method')
        .findOne({ where: { id: data.payment_method }, populate: { bank_account: true } });
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
    const data = event.data;
    const invoice = await strapi.db
      .query('api::emitted-invoice.emitted-invoice')
      .findOne({ where: event.params.where });

    if (invoice && invoice.updatable === false && !(data.updatable_admin === true)) {
      throw new Error('emitted-invoice NOT updatable');
    }

    cleanupUserFields(data);

    if (data.payment_method && invoice && data.payment_method !== invoice.payment_method) {
      const paymentMethod = await strapi.db
        .query('api::payment-method.payment-method')
        .findOne({ where: { id: data.payment_method }, populate: { bank_account: true } });
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
      await handleState(data);
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
      .findOne({ where: event.params.where });

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
        const user =
          invoice.user_real && typeof invoice.user_real === 'object'
            ? invoice.user_real && invoice.user_real.id
              ? invoice.user_real.id
              : 0
            : invoice.user_real;
        await strapi.db.query('api::verifactu-chain.verifactu-chain').create({
          data: {
            emitted_invoice: invoice.id,
            users_permissions_user: user,
            invoice_json: JSON.stringify(invoice),
            state: 'pending',
            mode: verifactu.mode,
            publishedAt: new Date(),
          },
        });
      }
    }

    // FACe queue enqueue
    const me = await strapi.documents('api::me.me').findFirst();
    const faceEnabled = me && (me.face === 'test' || me.face === 'real');
    let contact = null;
    if (invoice && invoice.contact) {
      const contactId = typeof invoice.contact === 'object' ? invoice.contact.id : invoice.contact;
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
      throw new Error('Cannot delete a real invoice');
    }
    // Bulk-unlink orders via raw SQL (no lifecycle re-entry) — parameter-bound.
    const orders = await strapi.db
      .query('api::order.order')
      .findMany({ where: { emitted_invoice: event.params.where.id } });
    if (orders && orders.length > 0) {
      const orderIds = orders.map((o) => o.id);
      const placeholders = orderIds.map(() => '?').join(',');
      await rawExecute(
        strapi,
        `UPDATE orders SET emitted_invoice = NULL, status = 'delivered', updated_at = NOW() WHERE id IN (${placeholders})`,
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

async function handleState(data) {
  if (data._internal) return;

  if (data.code === 'ESBORRANY' && data.state === 'real') {
    data.user_real = data.user_last;
    const serial = await strapi.db.query('api::serie.serie').findOne({ where: { id: data.serial } });
    if (serial) {
      if (!data.number) {
        const nextNumber = serial.emitted_invoice_number + 1;
        await strapi.db
          .query('api::serie.serie')
          .update({ where: { id: data.serial }, data: { emitted_invoice_number: nextNumber } });
        data.number = nextNumber;
      }
      const zeroPad = (num, places) => String(num).padStart(places, '0');
      const places = serial.leadingZeros || 1;
      data.code = `${serial.name}-${zeroPad(data.number, places)}`;
    }
  } else if (data.state === 'draft' || !data.state) {
    data.state = 'draft';
    data.code = 'ESBORRANY';
  }
}

async function calculateTotals(data) {
  if (data._internal) return;
  if (data.lines) {
    let total_base = 0;
    let total_vat = 0;
    let total_irpf = 0;
    data.lines.forEach((i) => {
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
      const contactId = typeof data.contact === 'object' ? data.contact.id : data.contact;
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
