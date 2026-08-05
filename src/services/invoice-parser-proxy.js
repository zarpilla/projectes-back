'use strict';

/**
 * Shared invoice-parser upload logic — used by both received-invoice and
 * received-expense controllers (same Z.ai pipeline for both document types).
 * Extracted to a service so neither controller depends on the other.
 */
const fs = require('fs');
const os = require('os');
const axios = require('axios');
const FormData = require('form-data');

async function readUploadedPdfBuffer(ctx) {
  const files = ctx.request && ctx.request.files;
  if (files) {
    const candidates = [];
    Object.keys(files).forEach((key) => {
      const value = files[key];
      if (Array.isArray(value)) candidates.push(...value);
      else candidates.push(value);
    });
    const file = candidates.find((f) => isPdf(f)) || candidates[0];
    if (file && file.path) {
      const buffer = fs.readFileSync(file.path);
      cleanupTempFile(file.path);
      return buffer;
    }
  }
  if (ctx.request?.body && Buffer.isBuffer(ctx.request.body)) return ctx.request.body;
  if (ctx.req?.body && Buffer.isBuffer(ctx.req.body)) return ctx.req.body;
  return null;
}

function isPdf(file) {
  if (!file) return false;
  const name = (file.name || '').toLowerCase();
  const type = (file.type || '').toLowerCase();
  return name.endsWith('.pdf') || type === 'application/pdf';
}

function cleanupTempFile(filePath) {
  try {
    if (filePath && filePath.startsWith(os.tmpdir())) fs.unlinkSync(filePath);
  } catch {
    // ignore
  }
}

/**
 * Forwards an uploaded PDF to the Z.ai invoice-parser service configured on `me`.
 * @param {object} strapi
 * @param {object} ctx
 * @returns the parsed JSON from the parser service, or a ctx error response.
 */
async function proxyUpload(strapi, ctx) {
  try {
    const pdfBuffer = await readUploadedPdfBuffer(ctx);
    if (!pdfBuffer || !pdfBuffer.length) {
      return ctx.badRequest('No PDF file was provided.');
    }

    const meSettings = await strapi.documents('api::me.me').findFirst();
    if (!meSettings?.invoice_parser_api_url || !meSettings?.invoice_parser_api_token) {
      return ctx.badRequest('Invoice parser API is not configured');
    }

    const baseUrl = meSettings.invoice_parser_api_url.replace(/\/+$/, '');
    const form = new FormData();
    form.append('file', pdfBuffer, { filename: 'invoice.pdf', contentType: 'application/pdf' });

    const response = await axios.post(`${baseUrl}/api/parse`, form, {
      headers: { 'X-API-Key': meSettings.invoice_parser_api_token, ...form.getHeaders() },
      maxContentLength: Infinity,
      maxBodyLength: Infinity,
      responseType: 'json',
      timeout: 120000,
    });
    return response.data;
  } catch (error) {
    strapi.log.error('invoice-parser upload error: %s', error.message);
    if (error.response) {
      return ctx.send(error.response.data, error.response.status);
    }
    return ctx.internalServerError(error.message || 'Failed to process the invoice PDF.');
  }
}

module.exports = { proxyUpload };
