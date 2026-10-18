'use strict';

/**
 * issues/179 (2026-10-18): 214 contacts of Diligència had a 4-digit postcode
 * («8225 Terrassa» for 08225), nearly all from two bulk loads in 2024 where a
 * spreadsheet dropped the leading zero. The startup script gives it back when
 * the town confirms the province, and leaves foreign codes and typos alone.
 */
const { paddedPostcodes, padFourDigitPostcodes } = require('../src/services/pad-four-digit-postcodes');

const contact = (id, postcode, city, country = null) => ({ id, postcode, city, country });

describe('paddedPostcodes (issues/179)', () => {
  it('pads a Spanish code when the town has 5-digit codes of that province', () => {
    const rows = [
      contact(1, '8225', 'Terrassa'),
      contact(2, '08221', 'Terrassa'),
      contact(3, '8001', ' barcelona ', 'Espanya'),
      contact(4, '08036', 'Barcelona'),
      contact(5, '8174', 'Sant Cugat del Vallès', 'Catalunya'),
      contact(6, '08172', 'Sant Cugat del Valles'),
    ];
    expect(paddedPostcodes(rows)).toEqual([
      { id: 1, from: '8225', to: '08225' },
      { id: 3, from: '8001', to: '08001' },
      { id: 5, from: '8174', to: '08174' },
    ]);
  });

  it('leaves foreign codes, typos and towns it cannot confirm', () => {
    const rows = [
      contact(1, '1050', 'Bruxelles', 'BELGIQUE'),
      contact(2, '1780', 'OLOT'),
      contact(3, '17800', 'Olot'),
      contact(4, '8070', 'Bertrange'),
      contact(5, '8390', 'Montgat'),
      contact(6, '1040', 'Brussel·les', 'Belgica'),
      contact(7, '01040', 'Brussel·les'),
      contact(8, '08225', 'Terrassa'),
    ];
    expect(paddedPostcodes(rows)).toEqual([]);
  });
});

describe('padFourDigitPostcodes (issues/179)', () => {
  afterEach(() => {
    delete global.strapi;
  });

  it('writes the padded code straight to the table, only while it is still the old one', async () => {
    const updates = [];
    const rows = [contact(1, '8225', 'Terrassa'), contact(2, '08221', 'Terrassa'), contact(3, '1780', 'Olot')];
    const connection = jest.fn(() => {
      const q = {
        select: async () => rows,
        where: (w) => ({ update: async (data) => updates.push({ where: w, data }) }),
      };
      return q;
    });
    global.strapi = {
      db: { metadata: { get: () => ({ tableName: 'contacts' }) }, connection },
      log: { info: jest.fn() },
    };

    await padFourDigitPostcodes();

    expect(connection).toHaveBeenCalledWith('contacts');
    expect(updates).toEqual([{ where: { id: 1, postcode: '8225' }, data: { postcode: '08225' } }]);
    expect(global.strapi.log.info.mock.calls[0][0]).toMatch(/1 contacts .*1 4-digit postcodes left .*#3 1780 Olot/);
  });

  it('is registered as a run-once startup script', () => {
    const text = require('fs').readFileSync(require('path').join(__dirname, '..', 'src', 'index.js'), 'utf8');
    expect(text).toMatch(/\['padFourDigitPostcodes', padFourDigitPostcodes, \{ runOnce: true \}\]/);
  });
});
