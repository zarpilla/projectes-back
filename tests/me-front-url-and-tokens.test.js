'use strict';

/**
 * issues/159 (2026-10-18): settings that could only be managed from the Strapi
 * admin.
 * - Configuració general edited `me.front_url`, but every link the API sends
 *   (tasks, incidences, order QR codes, quotes) read `config.front_url`, a
 *   single type with no screen. They now read `me.front_url`, falling back to
 *   `config.front_url` for tenants that never filled it.
 * - The DIR3 / PDF-reader tokens are private: GET /me tells an admin only
 *   whether each one is set, never the value.
 */

let meRow;
let admin;

beforeEach(() => {
  jest.resetModules();
  meRow = { id: 1, dir3_api_token: 'enc:v1:abc', invoice_parser_api_token: null };
  admin = true;
  global.strapi = {
    db: {
      query: (uid) => {
        if (uid === 'plugin::users-permissions.user') {
          return { findOne: async () => ({ id: 5, permissions: admin ? [{ permission: 'admin' }] : [{ permission: 'projects' }] }) };
        }
        return { findOne: async () => meRow };
      },
    },
  };
});

describe('frontUrlOf', () => {
  const { frontUrlOf } = require('../src/services/me-settings');

  it('prefers Configuració general, falls back to config, always ends in /', () => {
    expect(frontUrlOf({ front_url: 'https://a.example.org/stats/' }, { front_url: 'https://old.example.org/stats/#/' })).toBe('https://a.example.org/stats/');
    expect(frontUrlOf({ front_url: '' }, { front_url: 'https://old.example.org/stats/' })).toBe('https://old.example.org/stats/');
    expect(frontUrlOf({ front_url: ' https://a.example.org/stats ' }, null)).toBe('https://a.example.org/stats/');
    expect(frontUrlOf(null, null)).toBe('');
  });
});

describe('GET /me token flags', () => {
  const load = (data) => {
    jest.doMock('@strapi/strapi', () => ({ factories: { createCoreController: (_uid, cfg) => cfg({ strapi: global.strapi }) } }));
    const controller = require('../src/api/me/controllers/me');
    Object.setPrototypeOf(controller, { find: async () => ({ data }) });
    return controller;
  };

  it('tells an admin which tokens are set, without their values', async () => {
    const controller = load({ id: 1, name: 'Coop' });
    const response = await controller.find({ query: {}, state: { user: { id: 5 } } });
    expect(response.data).toEqual({ id: 1, name: 'Coop', dir3_api_token_set: true, invoice_parser_api_token_set: false });
  });

  it('adds nothing for other users', async () => {
    admin = false;
    const controller = load({ id: 1, name: 'Coop' });
    const response = await controller.find({ query: {}, state: { user: { id: 5 } } });
    expect(response.data).toEqual({ id: 1, name: 'Coop' });
  });
});
