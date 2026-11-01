'use strict';

/**
 * Where a document's stored `pdf` lives on disk, or null (issues/385).
 *
 * `pdf` is written by the server when it draws the PDF
 * (`/uploads/documents/<name>.pdf`). The invoice e-mail read
 * `./public${invoice.pdf}` as it was, and the field could be set by the client:
 * `/../../proc/self/environ` mailed the process environment (shared SSO keys,
 * JWT secret, DB password). Only a file inside public/uploads/documents is
 * ever read.
 */
const path = require('path');

function documentsDir(app = global.strapi) {
  const publicDir = (app && app.dirs && app.dirs.static && app.dirs.static.public) || './public';
  return path.resolve(publicDir, 'uploads', 'documents');
}

/** The absolute path of a stored `/uploads/documents/…` PDF, or null. */
function documentPdfPath(pdf, app = global.strapi) {
  if (typeof pdf !== 'string' || !pdf.startsWith('/uploads/documents/')) return null;
  const dir = documentsDir(app);
  const full = path.resolve(dir, '.' + pdf.slice('/uploads/documents'.length));
  return full.startsWith(dir + path.sep) ? full : null;
}

module.exports = { documentPdfPath, documentsDir };
