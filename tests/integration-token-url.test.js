'use strict';

/**
 * issues/404 (security review round 3, 2026-11-01): the DIR3 and invoice
 * parser keys are write-only (issues/159), but an admin could point
 * `dir3_api_url` to her own host and receive the stored key in the next DIR3
 * search. A stored key now goes only to the address it was given for: a new
 * address clears it, unless the same save brings a key.
 */

describe('integration keys follow their address (issues/404)', () => {
  let stored;
  beforeEach(() => {
    jest.resetModules();
    stored = { id: 1, dir3_api_url: 'https://dir3.esstrapis.org/', dir3_api_token: 'enc:abc', invoice_parser_api_url: 'https://ip', invoice_parser_api_token: 'enc:x' };
    global.strapi = { db: { query: () => ({ findOne: async () => stored }) } };
  });
  const drop = async (data) => {
    await require('../src/services/integration-tokens').dropTokensOfMovedUrls({ where: { id: 1 }, data });
    return data;
  };

  it('a new address clears its key', async () => {
    expect(await drop({ dir3_api_url: 'https://attacker.example' })).toEqual({ dir3_api_url: 'https://attacker.example', dir3_api_token: null });
  });

  it('the same address (also without the last slash) keeps it, and so does a save that brings a key', async () => {
    expect(await drop({ dir3_api_url: 'https://dir3.esstrapis.org', name: 'x' })).toEqual({ dir3_api_url: 'https://dir3.esstrapis.org', name: 'x' });
    expect(await drop({ dir3_api_url: 'https://new', dir3_api_token: 'nova' })).toEqual({ dir3_api_url: 'https://new', dir3_api_token: 'nova' });
    expect(await drop({ name: 'x' })).toEqual({ name: 'x' });
  });

  it('each integration on its own', async () => {
    expect(await drop({ dir3_api_url: 'https://dir3.esstrapis.org/', invoice_parser_api_url: 'https://other' })).toEqual({
      dir3_api_url: 'https://dir3.esstrapis.org/',
      invoice_parser_api_url: 'https://other',
      invoice_parser_api_token: null,
    });
  });
});
