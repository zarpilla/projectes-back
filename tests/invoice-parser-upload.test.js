/**
 * Regression test for issues/406: uploading a PDF on a received invoice or
 * expense always answered «No PDF file was provided.». The proxy read
 * `file.path`, `file.name` and `file.type`, but koa-body 6 / formidable 2 give
 * `filepath`, `originalFilename` and `mimetype`. The upload goes through the
 * real koa-body here, so the test follows whatever shape it really gives.
 */
const fs = require('fs');
const os = require('os');
const Koa = require('koa');
const { koaBody } = require('koa-body');

jest.mock('axios', () => ({ post: jest.fn() }));
jest.mock('@/services/me-settings', () => ({ getMe: jest.fn() }));
jest.mock('@/services/secret-crypto', () => ({ decryptSecret: (v) => `decrypted-${v}` }));
jest.mock('@/services/outbound-url', () => ({
  checkBaseUrl: (v) => v,
  outboundAxiosOptions: () => ({}),
  upstreamError: (ctx, error) => {
    ctx.status = 502;
    ctx.body = { error: error.message };
  },
}));

const axios = require('axios');
const { getMe } = require('@/services/me-settings');
const { proxyUpload } = require('@/services/invoice-parser-proxy');

const PDF = Buffer.from('%PDF-1.4 test invoice');

describe('invoice parser upload (issues/406)', () => {
  let server;
  let url;
  let tempFiles;

  beforeEach(async () => {
    axios.post.mockReset().mockResolvedValue({ data: { invoice: 'parsed' } });
    getMe.mockReset().mockResolvedValue({
      invoice_parser_api_url: 'https://parser.example.org',
      invoice_parser_api_token: 'token',
    });
    tempFiles = [];

    const app = new Koa();
    // Strapi adds ctx.badRequest; plain Koa doesn't have it
    app.context.badRequest = function badRequest(message) {
      this.status = 400;
      this.body = { error: message };
    };
    app.use(koaBody({ multipart: true }));
    app.use(async (ctx) => {
      tempFiles = Object.values(ctx.request.files || {}).flat().map((f) => f.filepath);
      const result = await proxyUpload(null, ctx);
      if (result !== undefined) ctx.body = result;
    });
    await new Promise((resolve) => {
      server = app.listen(0, '127.0.0.1', resolve);
    });
    url = `http://127.0.0.1:${server.address().port}/`;
  });

  afterEach(() => new Promise((resolve) => {
    server.close(resolve);
  }));

  const send = (form) => fetch(url, { method: 'POST', body: form });

  const pdfForm = () => {
    const form = new FormData();
    form.append('file', new Blob([PDF], { type: 'application/pdf' }), 'factura.pdf');
    return form;
  };

  it('forwards the uploaded PDF to the parser and returns its answer', async () => {
    const res = await send(pdfForm());

    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ invoice: 'parsed' });
    expect(axios.post).toHaveBeenCalledTimes(1);
    const [target, form, options] = axios.post.mock.calls[0];
    expect(target).toBe('https://parser.example.org/api/parse');
    expect(form.getBuffer().includes(PDF)).toBe(true);
    expect(options.headers['X-API-Key']).toBe('decrypted-token');
  });

  it('removes the temporary upload file', async () => {
    await send(pdfForm());

    expect(tempFiles).toHaveLength(1);
    expect(tempFiles[0].startsWith(os.tmpdir())).toBe(true);
    expect(fs.existsSync(tempFiles[0])).toBe(false);
  });

  it('picks the PDF when other files come with it', async () => {
    const form = new FormData();
    form.append('notes', new Blob(['not a pdf'], { type: 'text/plain' }), 'notes.txt');
    form.append('file', new Blob([PDF]), 'FACTURA.PDF');

    await send(form);

    expect(axios.post.mock.calls[0][1].getBuffer().includes(PDF)).toBe(true);
  });

  it('still refuses a request without a file', async () => {
    const res = await send(new FormData());

    expect(res.status).toBe(400);
    expect(await res.json()).toEqual({ error: 'No PDF file was provided.' });
    expect(axios.post).not.toHaveBeenCalled();
  });
});
