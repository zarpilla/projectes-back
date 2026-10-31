'use strict';
/* global strapi */

/**
 * Startup script (issues/374): the generated PDFs already on disk get names
 * nobody can compute.
 *
 * /uploads is served without login. Delivery notes were
 * `uploads/orders/orders-<order id>.pdf` (and `<id>-H<md5>.pdf` parts), and
 * invoices and quotes `uploads/documents/…-H<md5(type-code-id)>.pdf`: anyone
 * could walk or compute them.
 *
 * - uploads/orders: removed. They are printed on demand and never stored.
 * - uploads/documents: every `-H<16 hex>.pdf` is renamed with a random token,
 *   and the `pdf` of the invoices and quotes that pointed to it follows. The
 *   next regeneration writes the new keyed name (services/pdf-names.js).
 *
 * Idempotent: the new names carry 32 hex characters, which don't match again.
 */
const fs = require('fs');
const path = require('path');
const { randomToken } = require('./pdf-names');

const OLD_HASH = /-H[0-9a-f]{16}\.pdf$/;
const DOCUMENT_TYPES = ['api::emitted-invoice.emitted-invoice', 'api::quote.quote'];

function uploadsDir() {
  const publicDir = (strapi.dirs && strapi.dirs.static && strapi.dirs.static.public) || './public';
  return path.join(publicDir, 'uploads');
}

const list = (dir) => {
  try {
    return fs.readdirSync(dir);
  } catch (err) {
    if (err.code === 'ENOENT') return [];
    throw err;
  }
};

async function renameGuessablePdfs() {
  const root = uploadsDir();

  const ordersDir = path.join(root, 'orders');
  let removed = 0;
  for (const name of list(ordersDir)) {
    if (!name.endsWith('.pdf')) continue;
    fs.rmSync(path.join(ordersDir, name), { force: true });
    removed += 1;
  }

  const documentsDir = path.join(root, 'documents');
  const moved = new Map();
  for (const name of list(documentsDir)) {
    if (!OLD_HASH.test(name)) continue;
    const next = name.replace(OLD_HASH, `-H${randomToken()}.pdf`);
    try {
      fs.renameSync(path.join(documentsDir, name), path.join(documentsDir, next));
      moved.set(`/uploads/documents/${name}`, `/uploads/documents/${next}`);
    } catch (err) {
      if (err.code !== 'ENOENT') throw err; // another instance moved it first
    }
  }

  let rows = 0;
  for (const uid of DOCUMENT_TYPES) {
    const { tableName } = strapi.db.metadata.get(uid);
    for (const [from, to] of moved) {
      rows += await strapi.db.connection(tableName).where('pdf', from).update({ pdf: to });
    }
  }

  strapi.log.info(
    `[renameGuessablePdfs] ${removed} delivery notes removed, ${moved.size} document PDFs renamed, ${rows} documents updated`,
  );
  return { removed, renamed: moved.size, rows };
}

module.exports = { renameGuessablePdfs };
