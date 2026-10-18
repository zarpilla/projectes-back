'use strict';

/**
 * certificate controller (v5): status, upload/replace and removal of the AEAT
 * and FACe certificates (ticket 159). See services/certificates.js.
 */

const fs = require('fs');
const os = require('os');
const certificates = require('../../../services/certificates');

/** The `file` part of the multipart body (or the only one sent). */
function uploadedFile(ctx) {
  const files = (ctx.request && ctx.request.files) || {};
  const value = files.file || Object.values(files)[0];
  return Array.isArray(value) ? value[0] : value;
}

/** The keystore must not stay in the temp folder once handled. */
function removeTempFile(file) {
  try {
    if (file && file.filepath && file.filepath.startsWith(os.tmpdir())) fs.unlinkSync(file.filepath);
  } catch {
    // already gone
  }
}

module.exports = {
  async status(ctx) {
    if (!certificates.kindOf(ctx.params.kind)) return ctx.notFound();
    ctx.body = await certificates.getStatus(ctx.params.kind);
  },

  async replace(ctx) {
    if (!certificates.kindOf(ctx.params.kind)) return ctx.notFound();
    const file = uploadedFile(ctx);
    const body = ctx.request.body || {};
    const password = typeof body.password === 'string' ? body.password : '';
    try {
      ctx.body = await certificates.replace(ctx.params.kind, file, password);
    } catch (error) {
      if (error instanceof certificates.CertificateError) return ctx.badRequest(error.message);
      throw error;
    } finally {
      removeTempFile(file);
    }
  },

  async remove(ctx) {
    if (!certificates.kindOf(ctx.params.kind)) return ctx.notFound();
    ctx.body = await certificates.remove(ctx.params.kind);
  },
};
