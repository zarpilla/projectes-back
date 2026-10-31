'use strict';

/**
 * issues/383 (security review 2026-10-31): the API reflected any Origin with
 * `Access-Control-Allow-Credentials: true` (`Origin: https://evil.example` came
 * back allowed). Now only the instance's own front end, localhost and
 * CORS_ORIGINS are.
 */
function strapiWith(frontUrls) {
  return {
    log: { warn: jest.fn() },
    db: { query: (uid) => ({ findMany: async () => (frontUrls[uid] || []).map((front_url) => ({ front_url })) }) },
  };
}
const ctxFrom = (origin) => ({ get: (h) => (h === 'Origin' ? origin : '') });

describe('CORS origins (issues/383)', () => {
  let cors;
  beforeEach(() => {
    jest.resetModules();
    cors = require('../src/services/cors-origins');
  });

  const strapi = () =>
    strapiWith({
      'api::me.me': ['https://gestio.ladiligencia.coop/'],
      'api::config.config': ['https://miceliruralcoop.esstrapis.org/stats/'],
    });
  const env = { URL: 'https://api-gestio.ladiligencia.coop', CORS_ORIGINS: 'https://extra.example, ' };

  it.each([
    'https://gestio.ladiligencia.coop',
    'https://miceliruralcoop.esstrapis.org',
    'https://api-gestio.ladiligencia.coop',
    'https://extra.example',
    'http://localhost:8080',
    'http://127.0.0.1:5173',
  ])('allows %s', async (origin) => {
    expect(await cors.corsOrigin(ctxFrom(origin), strapi(), env)).toEqual([origin]);
  });

  it.each(['https://evil.example', 'https://demo.esstrapis.org', 'null', 'http://gestio.ladiligencia.coop'])(
    'refuses %s, and logs it once',
    async (origin) => {
      const s = strapi();
      const list = await cors.corsOrigin(ctxFrom(origin), s, env);
      expect(list).not.toContain(origin);
      await cors.corsOrigin(ctxFrom(origin), s, env);
      expect(s.log.warn).toHaveBeenCalledTimes(1);
    },
  );

  it('stays open on an instance with no URL at all yet', async () => {
    expect(await cors.corsOrigin(ctxFrom('https://evil.example'), strapiWith({}), {})).toBe('*');
  });
});
