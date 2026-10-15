'use strict';

/**
 * Answers client errors thrown as plain `http-errors` without logging them.
 *
 * `strapi::errors` only stays quiet for Strapi's own error classes. Anything
 * else is logged with `strapi.log.error` and its stack, and only then answered
 * with its 4xx status. `koa-static` (behind `strapi::public` and the uploads
 * route) throws plain `http-errors`: bots probing `//wp-content/...` or
 * `..%5c..%5c` get a correct 400 "Malicious Path" / 403 "Forbidden", but each
 * probe also logged an error. They were 441 of the 467 errors in Loki in the
 * week after the move to Docker (issues/052).
 *
 * This answers them with the same status and body `strapi::errors` would send.
 * The `http:` request line still records each one. Errors that are not exposed
 * client errors (500s, crashes) go on to `strapi::errors` and are logged.
 *
 * It must be registered right after `strapi::errors` in config/middlewares.js.
 */

const { errors } = require('@strapi/utils');

function isQuietClientError(error) {
  if (!(error instanceof Error)) return false;
  // Strapi's own errors are already answered without a log by strapi::errors.
  if (error instanceof errors.ApplicationError || error instanceof errors.HttpError) return false;
  const { status } = error;
  return error.expose === true && Number.isInteger(status) && status >= 400 && status < 500;
}

module.exports = () => async (ctx, next) => {
  try {
    await next();
  } catch (error) {
    if (!isQuietClientError(error)) throw error;
    ctx.status = error.status;
    ctx.body = {
      data: null,
      error: { status: error.status, name: error.name, message: error.message, details: error.details },
    };
  }
};

module.exports.isQuietClientError = isQuietClientError;
