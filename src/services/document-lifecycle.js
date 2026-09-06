'use strict';
/* global strapi */

/**
 * Shared v5 lifecycles for "document" entities — ported from the identical v3
 * model files (diet, ticket, emitted-grant, received-grant, received-invoice,
 * received-expense, received-income).
 *
 * Common behavior:
 *   - beforeCreate/beforeUpdate: serie-based code numbering (SERIE-000N) and
 *     totals calculation (from lines when present, else from base fields)
 *   - beforeUpdate: updatable guard (updatable_admin bypass, reset after use)
 *   - beforeDelete: updatable guard
 *   - afterCreate/afterUpdate/beforeDelete: mark linked projects dirty for the
 *     totals-refresh queue (P4.10 scheduler)
 *
 * Options:
 *   - withPaymentMethod: default payment_method (first in DB) and derive
 *     bank_account from it (received-* documents)
 *   - withContactInfo: denormalize contact fields into contact_info
 *     (received-* documents)
 *   - skipTotalsOnInternal: skip totals recalc when the internal admin flag is
 *     set on update (received-* use the v3 `_internal` convention; in v5 the
 *     flag is `updatable_admin`-style passthrough data, kept as `_internal`)
 *
 * @param {object} opts
 * @param {string} opts.uid       v5 UID, e.g. 'api::diet.diet'
 * @param {string} opts.entity    label for error messages, e.g. 'diet'
 * @param {boolean} opts.hasLines true when totals are computed from a lines component
 * @param {boolean} [opts.withPaymentMethod=false]
 * @param {boolean} [opts.withContactInfo=false]
 * @param {boolean} [opts.skipTotalsOnInternal=false]
 */
const { scheduleFromEntityProjects } = require('../api/project/services/totalsRefreshScheduler');
const { relationId } = require('./relation-input');
// A plain Error from a lifecycle surfaces as a bare 500 'Internal Server Error',
// so the rule that rejected the write never reaches the user. ApplicationError
// answers 400 with the message, which the views already display.
const { errors: { ApplicationError } } = require('@strapi/utils');

function createDocumentLifecycles({
  uid,
  entity,
  hasLines,
  withPaymentMethod = false,
  withContactInfo = false,
  skipTotalsOnInternal = false,
}) {
  return {
    async beforeCreate(event) {
      const data = event.params.data;
      if (withPaymentMethod) await applyPaymentMethod(data, null);
      if (withContactInfo) await fillContactInfo(data);
      await calculateTotals(data);
    },
    async afterCreate(event) {
      scheduleFromEntityProjects(event.result);
    },
    async beforeUpdate(event) {
      const data = event.params.data;
      const existing = await strapi.db.query(uid).findOne({ where: event.params.where });
      if (existing && existing.updatable === false && !(data.updatable_admin === true)) {
        throw new ApplicationError(`${entity} NOT updatable`);
      }
      if (withPaymentMethod && existing) {
        await applyPaymentMethod(data, existing.payment_method);
      }
      if (withContactInfo) await fillContactInfo(data);

      const skipTotals = skipTotalsOnInternal && data._internal === true;
      if (!skipTotals) {
        data.updatable_admin = false;
        await calculateTotals(data);
      }
    },
    async afterUpdate(event) {
      scheduleFromEntityProjects(event.result);
      scheduleFromEntityProjects(event.params.data);
    },
    async beforeDelete(event) {
      const existing = await strapi.db.query(uid).findOne({ where: event.params.where });
      if (existing && existing.updatable === false) {
        throw new ApplicationError(`${entity} NOT updatable`);
      }
      scheduleFromEntityProjects(existing);
    },
  };

  // Default payment_method to the first one in DB; derive bank_account from it.
  async function applyPaymentMethod(data, previousPaymentMethod) {
    if (!relationId(data.payment_method) && previousPaymentMethod == null) {
      const first = await strapi.db
        .query('api::payment-method.payment-method')
        .findOne({ populate: { bank_account: true } });
      if (first) {
        data.payment_method = first.id;
      }
    }
    const paymentMethodId = relationId(data.payment_method);
    if (paymentMethodId) {
      const paymentMethod = await strapi.db
        .query('api::payment-method.payment-method')
        .findOne({ where: { id: paymentMethodId }, populate: { bank_account: true } });
      if (paymentMethod && paymentMethod.bank_account) {
        data.bank_account = paymentMethod.bank_account.id || paymentMethod.bank_account;
      }
    }
  }

  // Denormalize contact fields into contact_info (v3 filled it on every write).
  async function fillContactInfo(data) {
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

  async function calculateTotals(data) {
    if (hasLines) {
      data.total_base = 0;
      data.total_vat = 0;
      data.total_irpf = 0;
      data.total = 0;
    }

    // Serie-based code numbering: SERIE-000N
    if (!data.code) {
      const serialId = relationId(data.serial);
      const serial = await strapi.db.query('api::serie.serie').findOne({ where: { id: serialId } });
      if (serial) {
        if (!data.number) {
          const existing = await strapi.db.query(uid).findMany({
            where: { serial: serialId },
          });
          data.number = existing.length + 1;
        }
        const zeroPad = (num, places) => String(num).padStart(places, '0');
        const places = serial.leadingZeros || 1;
        data.code = `${serial.name}-${zeroPad(data.number, places)}`;
      }
    }

    if (hasLines && data.lines) {
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
    } else if (!hasLines) {
      data.total = (data.total_base || 0) + (data.total_vat || 0) - (data.total_irpf || 0);
    }
  }
}

module.exports = { createDocumentLifecycles };
