'use strict';

/**
 * issues/342 (2026-10-25): the front moved from https://<site>/stats/ to the
 * root of the site. The startup script drops the "/stats" from the saved
 * front_url values («Adreça de l'aplicació») and the password-reset link, so
 * new e-mails, order QR codes and quote links use the new address. Values with
 * another path are left alone.
 */

let rows;
let updates;
let advanced;
let storeSets;
let frontUrlsAtRoot;
let atRoot;

beforeEach(() => {
  jest.resetModules();
  rows = {
    'api::config.config': [{ id: 1, front_url: 'https://site.example.org/stats/#/' }],
    'api::me.me': [{ id: 3, front_url: 'https://site.example.org/stats/' }, { id: 4, front_url: 'https://other.example.org/app/' }, { id: 5, front_url: null }],
  };
  updates = [];
  storeSets = [];
  advanced = { email_confirmation: false, email_reset_password: 'https://site.example.org/stats/reset-password' };
  global.strapi = {
    log: { info: jest.fn() },
    db: {
      query: (uid) => ({
        findMany: async () => rows[uid],
        update: async ({ where, data }) => updates.push({ uid, id: where.id, data }),
      }),
    },
    store: () => ({
      get: async () => advanced,
      set: async ({ value }) => storeSets.push(value),
    }),
  };
  ({ frontUrlsAtRoot, atRoot } = require('../src/services/front-urls-at-root'));
});

test('drops the /stats right after the host', () => {
  expect(atRoot('https://site.example.org/stats/')).toBe('https://site.example.org/');
  expect(atRoot('https://site.example.org/stats')).toBe('https://site.example.org/');
  expect(atRoot('https://site.example.org/stats/#/')).toBe('https://site.example.org/');
  expect(atRoot('https://site.example.org/stats/reset-password')).toBe('https://site.example.org/reset-password');
  expect(atRoot('https://site.example.org/stats/#/reset-password')).toBe('https://site.example.org/reset-password');
  expect(atRoot('http://localhost:8080/stats/')).toBe('http://localhost:8080/');
});

test('leaves other addresses alone', () => {
  expect(atRoot('https://site.example.org/')).toBe('https://site.example.org/');
  expect(atRoot('https://site.example.org/stats-app/')).toBe('https://site.example.org/stats-app/');
  expect(atRoot('https://site.example.org/app/stats/')).toBe('https://site.example.org/app/stats/');
  expect(atRoot(null)).toBe(null);
});

test('rewrites the saved front URLs and the reset link', async () => {
  await frontUrlsAtRoot();
  expect(updates).toEqual([
    { uid: 'api::config.config', id: 1, data: { front_url: 'https://site.example.org/' } },
    { uid: 'api::me.me', id: 3, data: { front_url: 'https://site.example.org/' } },
  ]);
  expect(storeSets).toEqual([
    { email_confirmation: false, email_reset_password: 'https://site.example.org/reset-password' },
  ]);
});

test('leaves a reset link at the root and a missing setting alone', async () => {
  advanced = { email_reset_password: 'https://site.example.org/reset-password' };
  await frontUrlsAtRoot();
  advanced = null;
  await frontUrlsAtRoot();
  expect(storeSets).toEqual([]);
});
