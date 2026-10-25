'use strict';

/**
 * issues/343: the front's URLs are in Catalan. The startup script points the
 * saved password-reset link at «/canviar-clau»; other values are left alone.
 */

let advanced;
let storeSets;
let frontUrlsInCatalan;
let catalanResetUrl;

beforeEach(() => {
  jest.resetModules();
  storeSets = [];
  advanced = { email_confirmation: false, email_reset_password: 'https://site.example.org/reset-password' };
  global.strapi = {
    log: { info: jest.fn() },
    store: () => ({
      get: async () => advanced,
      set: async ({ value }) => storeSets.push(value),
    }),
  };
  ({ frontUrlsInCatalan, catalanResetUrl } = require('../src/services/front-urls-in-catalan'));
});

test('renames the reset page, keeping the host and the query', () => {
  expect(catalanResetUrl('https://site.example.org/reset-password')).toBe('https://site.example.org/canviar-clau');
  expect(catalanResetUrl('https://site.example.org/reset-password/')).toBe('https://site.example.org/canviar-clau');
  expect(catalanResetUrl('http://localhost:8082/stats/reset-password?x=1')).toBe('http://localhost:8082/stats/canviar-clau?x=1');
  expect(catalanResetUrl('https://site.example.org/canviar-clau')).toBe('https://site.example.org/canviar-clau');
  expect(catalanResetUrl('https://site.example.org/reset-password-old')).toBe('https://site.example.org/reset-password-old');
});

test('saves the new password-reset link once', async () => {
  await frontUrlsInCatalan();
  expect(storeSets).toEqual([{ email_confirmation: false, email_reset_password: 'https://site.example.org/canviar-clau' }]);
  advanced = storeSets[0];
  storeSets = [];
  await frontUrlsInCatalan();
  expect(storeSets).toEqual([]);
});

test('does nothing without a link', async () => {
  advanced = { email_confirmation: false };
  await frontUrlsInCatalan();
  expect(storeSets).toEqual([]);
});
