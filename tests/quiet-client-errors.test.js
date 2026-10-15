'use strict';

/**
 * issues/052 — 2026-10-15. The Grafana error dashboard was mostly bot scans:
 * `GET //cgi-bin/index.php` or `GET /views..%5c..%5c...` make koa-static
 * (strapi::public) throw a plain http-error, 400 "Malicious Path" or 403
 * "Forbidden". strapi::errors answered it correctly but logged it first as an
 * error with its stack: 441 of the 467 errors in Loki that week.
 *
 * The tests run the real strapi::errors middleware around the new one, with
 * the errors resolve-path throws for those requests.
 */

const path = require('path');
const resolvePath = require('resolve-path');

// Not in @strapi/core's package exports; required by file path.
const { errors: strapiErrorsMiddleware } = require(
  path.join(__dirname, '../node_modules/@strapi/core/dist/middlewares/errors.js')
);

function errorFrom(requestPath) {
  try {
    resolvePath('/srv/public', requestPath);
  } catch (error) {
    return error;
  }
  throw new Error(`resolve-path accepted ${requestPath}`);
}

async function request(thrown) {
  jest.resetModules();
  const quietClientErrors = require('../src/middlewares/quiet-client-errors');
  global.strapi = { log: { error: jest.fn() } };
  const ctx = { response: {}, notFound: jest.fn() };
  const route = async () => {
    throw thrown;
  };
  // strapi::errors -> quiet-client-errors -> route, as in config/middlewares.js
  await strapiErrorsMiddleware()(ctx, () => quietClientErrors()(ctx, route));
  return { ctx, log: global.strapi.log.error };
}

afterEach(() => {
  delete global.strapi;
});

describe('quiet-client-errors (issues/052)', () => {
  it('answers a malicious path with 400 and does not log it', async () => {
    const { ctx, log } = await request(errorFrom('//cgi-bin/index.php'));
    expect(log).not.toHaveBeenCalled();
    expect(ctx.status).toBe(400);
    expect(ctx.body).toEqual({
      data: null,
      error: { status: 400, name: 'BadRequestError', message: 'Malicious Path', details: undefined },
    });
  });

  it('answers a traversal path with 403 and does not log it', async () => {
    const { ctx, log } = await request(errorFrom('views..\\..\\x/../../../etc'));
    expect(log).not.toHaveBeenCalled();
    expect(ctx.status).toBe(403);
    expect(ctx.body.error).toMatchObject({ status: 403, name: 'ForbiddenError', message: 'Forbidden' });
  });

  it('still logs a crash and answers 500', async () => {
    const crash = new TypeError("Cannot read properties of null (reading 'username')");
    const { ctx, log } = await request(crash);
    expect(log).toHaveBeenCalledWith(crash);
    expect(ctx.status).toBe(500);
  });

  it('still logs an http-error with a 5xx status', async () => {
    const createError = require('http-errors');
    const unavailable = createError(503);
    const { ctx, log } = await request(unavailable);
    expect(log).toHaveBeenCalledWith(unavailable);
    expect(ctx.status).toBe(503);
  });
});
