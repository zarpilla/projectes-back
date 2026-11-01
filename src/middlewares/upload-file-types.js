'use strict';

/**
 * Refuses uploads of HTML, XML and script files, for every user and every
 * upload route (content API and the admin media library), issues/395. SVG
 * stays allowed here: users without full access are refused it by the
 * permissions middleware (scopeUpload), admins upload SVG logos.
 *
 * Runs right after strapi::body, which has parsed the multipart files.
 */

const { errors } = require('@strapi/utils');
const { isActiveName, isSvgName } = require('../services/active-file-types');

const UPLOAD_PATH = /^\/(api\/)?upload(\/|$)/i;

function filesOf(ctx) {
  const files = ctx.request && ctx.request.files;
  if (!files) return [];
  return Object.values(files).flatMap((f) => (Array.isArray(f) ? f : [f]));
}

const nameOf = (file) => (file && (file.originalFilename || file.name)) || '';

module.exports = () => async (ctx, next) => {
  if (ctx.method === 'POST' && UPLOAD_PATH.test(ctx.path || '')) {
    const bad = filesOf(ctx).find((f) => isActiveName(nameOf(f)) && !isSvgName(nameOf(f)));
    if (bad) throw new errors.ValidationError(`No es poden pujar fitxers d'aquest tipus (${nameOf(bad)})`);
  }
  return next();
};
