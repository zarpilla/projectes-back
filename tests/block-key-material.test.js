'use strict';

/**
 * Private key material must not be reachable over HTTP.
 *
 * Uploads are served straight off disk by `strapi::public` (nginx in
 * production), which left the AEAT/FACe PKCS#12 downloadable anonymously at
 * /uploads/<name>.p12 — six certificates were exposed this way, including ones
 * belonging to other people and organisations. Their URLs are not secret
 * either: the media relation carries them into GET /api/verifactu.
 */

const middleware = require('../src/middlewares/block-key-material');

function run(path) {
  const strapi = { log: { warn: jest.fn() } };
  const handler = middleware({}, { strapi });
  const ctx = {
    path,
    ip: '127.0.0.1',
    notFound: jest.fn(() => 'NOT_FOUND'),
  };
  const next = jest.fn(async () => 'SERVED');
  return { result: handler(ctx, next), ctx, next, strapi };
}

const BLOCKED = ['p12', 'pfx', 'pem', 'key', 'jks', 'p8', 'p7b', 'p7s', 'asc', 'gpg', 'der', 'crt', 'cer'];
const SERVED = ['pdf', 'png', 'jpg', 'csv', 'docx', 'xlsx', 'txt', 'svg'];

describe('block-key-material', () => {
  it.each(BLOCKED)('refuses /uploads/cert.%s', async (ext) => {
    const { result, ctx, next } = run(`/uploads/cert.${ext}`);
    await result;
    expect(ctx.notFound).toHaveBeenCalled();
    expect(next).not.toHaveBeenCalled();
  });

  it.each(SERVED)('still serves /uploads/file.%s', async (ext) => {
    const { result, ctx, next } = run(`/uploads/file.${ext}`);
    await result;
    expect(ctx.notFound).not.toHaveBeenCalled();
    expect(next).toHaveBeenCalled();
  });

  it('matches regardless of case', async () => {
    const { result, ctx } = run('/uploads/CERT.P12');
    await result;
    expect(ctx.notFound).toHaveBeenCalled();
  });

  it('logs the refusal, so an attempt is visible', async () => {
    const { result, strapi } = run('/uploads/cert.p12');
    await result;
    expect(strapi.log.warn).toHaveBeenCalledWith(expect.stringContaining('refused key-material'));
  });

  it('leaves paths outside /uploads alone', async () => {
    // The API itself must not be caught by an extension match.
    const { result, ctx, next } = run('/api/emitted-invoices/1.pem');
    await result;
    expect(ctx.notFound).not.toHaveBeenCalled();
    expect(next).toHaveBeenCalled();
  });
});
