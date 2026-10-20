'use strict';

/**
 * issues/298 (2026-10-20, review 9): the albarà PDF printed the time slots
 * and the kilos as stored, «De 9.5h a 13.5h - De 18h a 20h» and «3 caixes -
 * 13.8 kg», instead of «De 9:30 a 13:30» and «13,8 kg».
 */

const fs = require('fs');
const os = require('os');
const path = require('path');

const { hourText, timeSlotText, kilogramsText, loadText } = require('../src/api/order/services/slip-text');

describe('slip texts (issues/298)', () => {
  it('writes decimal hours as H:MM', () => {
    expect(hourText(9.5)).toBe('9:30');
    expect(hourText('13.50')).toBe('13:30');
    expect(hourText(18)).toBe('18:00');
    expect(hourText(8.25)).toBe('8:15');
    expect(timeSlotText(9.5, 13.5)).toBe('De 9:30 a 13:30');
    expect(timeSlotText(null, 13.5)).toBeNull();
  });

  it('writes kilos with a decimal comma', () => {
    expect(kilogramsText(13.8)).toBe('13,8');
    expect(kilogramsText('13.80')).toBe('13,8');
    expect(kilogramsText(5)).toBe('5');
    expect(kilogramsText(0.125)).toBe('0,13');
    expect(loadText({ units: 3, kilograms: 13.8 })).toBe('3 caixes - 13,8 kg');
    expect(loadText({ units: 1, kilograms: 2 })).toBe('1 caixa - 2 kg');
  });
});

describe('order.pdfmultiple prints them (issues/298)', () => {
  const cwd = process.cwd();
  let tmp;
  let texts;

  beforeEach(() => {
    jest.resetModules();
    texts = [];
    const PDFKit = require('pdfkit');
    const text = PDFKit.prototype.text;
    jest.spyOn(PDFKit.prototype, 'text').mockImplementation(function (value, ...rest) {
      texts.push(String(value));
      return text.call(this, value, ...rest);
    });
    tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'order-slip-'));
    process.chdir(tmp);

    const ct = { uid: 'api::order.order', modelName: 'order', apiName: 'order', kind: 'collectionType', attributes: {} };
    const order = {
      id: 24897,
      createdAt: '2026-10-01T08:00:00.000Z',
      units: 3,
      kilograms: '13.80',
      estimated_delivery_date: '2026-10-20',
      contact_time_slot_1_ini: '9.50',
      contact_time_slot_1_end: '13.50',
      contact_time_slot_2_ini: '18.00',
      contact_time_slot_2_end: '20.00',
      owner: { id: 7, username: 'productora' },
      contact: { trade_name: 'Botiga', address: 'Carrer Major 1', postcode: '08001', city: 'Barcelona' },
      route: { name: 'R1' },
      pickup: { name: 'Magatzem' },
    };
    global.strapi = {
      contentType: () => ct,
      contentTypes: { 'api::order.order': ct },
      log: { warn: () => {}, info: () => {} },
      documents: (uid) => ({
        findFirst: async () => (uid === 'api::me.me' ? { name: 'La Diligència' } : { front_url: 'https://example.org/' }),
      }),
      db: {
        query: (uid) => ({
          findMany: async () => {
            if (uid === 'api::contact.contact') return [{ id: 9, name: 'Productora SCCL' }];
            if (uid === 'api::order.order') return [order];
            return [];
          },
        }),
      },
    };
  });

  afterEach(() => {
    process.chdir(cwd);
    fs.rmSync(tmp, { recursive: true, force: true });
    delete global.strapi;
    jest.restoreAllMocks();
  });

  // a PDF with its QR: slow when the whole suite runs at once
  it('prints the hours and the kilos the Catalan way', async () => {
    const ctrl = require('../src/api/order/controllers/order.js')({ strapi: global.strapi });
    await ctrl.pdfmultiple({ request: { body: { orders: [24897] } }, send: () => {} });
    const all = texts.join('\n');
    expect(all).toContain('De 9:30 a 13:30 - De 18:00 a 20:00');
    expect(all).toContain('3 caixes - 13,8 kg');
    expect(all).not.toMatch(/9\.5h|13\.8 kg/);
  }, 30000);
});
