'use strict';

/**
 * issues/158 (2026-10-18): the front moved from hash URLs (…/stats/#/tasks)
 * to plain ones (…/stats/tasks). The startup script drops the "#/" from the
 * saved front_url values and the password-reset link, so new e-mails, order QR
 * codes and quote links use the new form. Values already plain are left alone.
 */

let rows;
let updates;
let advanced;
let storeSets;
let frontUrlsWithoutHash;
let withoutHash;

beforeEach(() => {
  jest.resetModules();
  rows = {
    'api::config.config': [{ id: 1, front_url: 'https://site.example.org/stats/#/' }],
    'api::me.me': [{ id: 3, front_url: 'https://site.example.org/stats/' }],
  };
  updates = [];
  storeSets = [];
  advanced = { email_confirmation: false, email_reset_password: 'https://site.example.org/stats/#/reset-password' };
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
  ({ frontUrlsWithoutHash, withoutHash } = require('../src/services/front-urls-without-hash'));
});

test('drops the "#/" of the front URLs', () => {
  expect(withoutHash('https://site.example.org/stats/#/')).toBe('https://site.example.org/stats/');
  expect(withoutHash('https://site.example.org/stats/#/reset-password')).toBe('https://site.example.org/stats/reset-password');
  expect(withoutHash('https://site.example.org/stats/')).toBe('https://site.example.org/stats/');
  expect(withoutHash(null)).toBe(null);
});

test('rewrites only the saved values that still have the hash', async () => {
  await frontUrlsWithoutHash();
  expect(updates).toEqual([
    { uid: 'api::config.config', id: 1, data: { front_url: 'https://site.example.org/stats/' } },
  ]);
  expect(storeSets).toEqual([
    { email_confirmation: false, email_reset_password: 'https://site.example.org/stats/reset-password' },
  ]);
});

test('leaves a plain reset link and a missing setting alone', async () => {
  advanced = { email_reset_password: 'https://site.example.org/stats/reset-password' };
  await frontUrlsWithoutHash();
  advanced = null;
  await frontUrlsWithoutHash();
  expect(storeSets).toEqual([]);
});
