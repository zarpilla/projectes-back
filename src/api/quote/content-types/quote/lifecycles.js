'use strict';
/* global strapi */
const { relationId } = require('../../../../services/relation-input');
const { computeQuoteTotals, resolveComponentLines } = require('../../../../services/document-lifecycle');

const UID = 'api::quote.quote';

/**
 * quote lifecycles (v5). Ported from v3 api/quote/models/quote.js.
 * contact_info denormalization + serie numbering + line totals (irpf forced 0).
 * The v3 afterFindOne pdf default moves to the quote controller's findOne override
 * (v5 removed afterFindOne).
 */
module.exports = {
  async beforeCreate(event) {
    await fillContactInfo(event.params.data);
    await calculateTotals(event.params.data, false);
  },
  async beforeUpdate(event) {
    await fillContactInfo(event.params.data);
    await calculateTotals(event.params.data, true);
  },
};

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

async function calculateTotals(data, isUpdate) {
  if (data._internal) return;

  // An update that doesn't send the lines (accepting the quote, …) keeps the
  // stored totals rather than zeroing them (issues/022).
  const touchesLines = !(isUpdate && data.lines === undefined);
  if (touchesLines) {
    data.total_base = 0;
    data.total_vat = 0;
    data.total_irpf = 0;
    data.total = 0;
  }

  if (!data.code) {
    const serialId = relationId(data.serial);
    // v3's query layer answered `{ id: undefined }` with null; v5 hands the
    // undefined binding straight to knex, which throws "Undefined binding(s)
    // detected when compiling WHERE".
    const serial = serialId
      ? await strapi.db.query('api::serie.serie').findOne({ where: { id: serialId } })
      : null;
    if (serial) {
      if (!data.number) {
        const quotes = await strapi.db
          .query('api::quote.quote')
          .findMany({ where: { serial: serialId } });
        data.number = quotes.length + 1;
      }
      const zeroPad = (num, places) => String(num).padStart(places, '0');
      const places = serial.leadingZeros || 1;
      data.code = `${serial.name}-${zeroPad(data.number, places)}`;
    }
  }

  if (data.lines) {
    // v5 leaves bare `{ id }` references here: read the values back (issues/022)
    Object.assign(data, computeQuoteTotals(await resolveComponentLines(UID, data.lines)));
  }
}
