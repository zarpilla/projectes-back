'use strict';

/**
 * issues/394 (security review round 2, 2026-10-31): strapi::logger wrote the
 * whole URL to Loki (searches, names, filters), unlike Caddy's redacted log.
 * The request line keeps its format and the query's shape, without the values
 * people type.
 */
const middleware = require('../src/middlewares/request-log');

describe('request log (issues/394)', () => {
  it('keeps paging, sorting and populate values and hides the rest', () => {
    const { redactedQuery } = middleware;
    expect(redactedQuery('_q=Maria%20Garcia&_limit=50&_where%5Bnif_contains%5D=4612&populate%5B0%5D=owner&_sort=id:DESC')).toBe(
      '?_q=…&_limit=50&_where%5Bnif_contains%5D=…&populate%5B0%5D=owner&_sort=id:DESC',
    );
    expect(redactedQuery('')).toBe('');
    expect(redactedQuery('code=abcdef123')).toBe('?code=…');
  });

  it('logs in strapi::logger’s format', async () => {
    const http = jest.fn();
    const log = middleware({}, { strapi: { log: { http } } });
    const ctx = { method: 'GET', path: '/api/contacts', querystring: '_q=Joan&_limit=10', status: 200 };
    await log(ctx, async () => {});
    expect(http.mock.calls[0][0]).toMatch(/^GET \/api\/contacts\?_q=…&_limit=10 \(\d+ ms\) 200$/);
  });
});
