'use strict';
/* global strapi */
const { relationId } = require('../../../../services/relation-input');

/**
 * quote lifecycles (v5). Ported from v3 api/quote/models/quote.js.
 * contact_info denormalization + serie numbering + line totals (irpf forced 0).
 * The v3 afterFindOne pdf default moves to the quote controller's findOne override
 * (v5 removed afterFindOne).
 */
module.exports = {
  async beforeCreate(event) {
    await fillContactInfo(event.params.data);
    await calculateTotals(event.params.data);
  },
  async beforeUpdate(event) {
    await fillContactInfo(event.params.data);
    await calculateTotals(event.params.data);
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

async function calculateTotals(data) {
  if (data._internal) return;

  data.total_base = 0;
  data.total_vat = 0;
  data.total_irpf = 0;
  data.total = 0;

  if (!data.code) {
    const serialId = relationId(data.serial);
    const serial = await strapi.db.query('api::serie.serie').findOne({ where: { id: serialId } });
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
    let total_base = 0;
    let total_vat = 0;
    data.lines.forEach((i) => {
      let base = (i.base ? i.base : 0) * (i.quantity ? i.quantity : 0);
      if (i.discount) {
        base = base * (1 - i.discount / 100.0);
      }
      const vat = (base * (i.vat ? i.vat : 0)) / 100.0;
      total_base += base;
      total_vat += vat;
    });
    data.total_base = total_base;
    data.total_vat = total_vat;
    data.total_irpf = 0; // quotes never carry irpf (v3 behavior)
    data.total = data.total_base + data.total_vat;
  }
}
