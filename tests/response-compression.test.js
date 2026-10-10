/**
 * Regression (issues/016, 2026-10-10): since the move to v5 no API answer was
 * compressed. The v3 gzip setting had been ported onto `strapi::responses`,
 * which only runs status handlers in v5; the middleware that compresses is
 * `strapi::compression`. A large project travelled as 485 KB of raw JSON.
 */

const middlewares = require('../config/middlewares');

const env = Object.assign(() => undefined, { bool: (key, fallback) => fallback });
const nameOf = (entry) => (typeof entry === 'string' ? entry : entry.name);

describe('middleware stack', () => {
  const stack = middlewares({ env });
  const names = stack.map(nameOf);

  it('compresses responses', () => {
    expect(names).toContain('strapi::compression');
  });

  it('compresses with gzip only (brotli at koa-compress defaults is too slow)', () => {
    const compression = stack.find((entry) => nameOf(entry) === 'strapi::compression');
    expect(compression.config.br).toBe(false);
    expect(compression.config.gzip).not.toBe(false);
  });

  it('wraps the handlers that write the body', () => {
    expect(names.indexOf('strapi::compression')).toBeLessThan(names.indexOf('strapi::body'));
    expect(names.indexOf('strapi::compression')).toBeLessThan(names.indexOf('global::v3-compat'));
  });
});
