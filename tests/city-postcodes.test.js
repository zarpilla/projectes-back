'use strict';

/**
 * issues/182 (2026-10-18): on the delivery point form, picking the town left
 * the CP empty: the towns have no postcode. GET /cities/postcodes gives the
 * code the contacts of each town use most, and nothing else about them.
 */
const path = require('path');

afterEach(() => {
  delete global.strapi;
});

beforeEach(() => {
  jest.resetModules();
});

describe('townPostcodes (issues/182)', () => {
  it('the most used 5-digit code of each town, by its plain name', () => {
    const { townPostcodes } = require('../src/api/city/services/town-postcodes');
    const rows = [
      { city: 'Terrassa', postcode: '08225' },
      { city: 'terrassa ', postcode: '08225' },
      { city: 'Terrassa', postcode: '08221' },
      { city: 'Terrassa', postcode: '8225' },
      { city: "L'Hospitalet de Llobregat", postcode: '08901' },
      { city: 'Sant Cugat del Vallès', postcode: '08174' },
      { city: 'Sant Cugat del Valles', postcode: '08172' },
      { city: '', postcode: '08001' },
      { city: 'Olot', postcode: null },
    ];
    expect(townPostcodes(rows)).toEqual({
      terrassa: '08225',
      "l'hospitalet de llobregat": '08901',
      // a tie: the lowest code
      'sant cugat del valles': '08172',
    });
  });
});

describe('GET /cities/postcodes (issues/182)', () => {
  it('reads only the town and the code of the contacts', async () => {
    const select = jest.fn(() => ({ whereNotNull: async () => [{ city: 'Vic', postcode: '08500' }] }));
    const connection = jest.fn(() => ({ select }));
    global.strapi = {
      db: { metadata: { get: () => ({ tableName: 'contacts' }) }, connection },
      contentType: () => ({ uid: 'api::city.city', attributes: {} }),
    };
    const ctrl = require(path.join(__dirname, '..', 'src', 'api', 'city', 'controllers', 'city.js'))({ strapi: global.strapi });

    expect(await ctrl.postcodes({})).toEqual({ vic: '08500' });
    expect(connection).toHaveBeenCalledWith('contacts');
    expect(select).toHaveBeenCalledWith('city', 'postcode');
  });

  it('is open to the members, who fill their delivery points', () => {
    const { isAllowed } = require('../src/services/app-access-rules');
    for (const p of ['orders', 'orders_admin', 'orders_delivery', 'projects']) {
      expect(isAllowed('api::city.city.postcodes', [p])).toBe(true);
    }
    const routes = require('../src/api/city/routes/01-custom-city.js').routes;
    expect(routes).toContainEqual({ method: 'GET', path: '/cities/postcodes', handler: 'city.postcodes' });
  });
});
