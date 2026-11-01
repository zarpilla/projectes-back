'use strict';

/**
 * issues/395 (security review round 3, 2026-11-01): a member uploaded
 * `g.js`, a 1×1 GIF that is also valid JavaScript, and `f2.html` starting with
 * `%PDF`, both sent as application/octet-stream. Strapi accepted them on the
 * detected type and kept the extensions; /uploads served them from the app's
 * origin as application/javascript and text/html, and the page ran the script
 * in Chromium. Guards: those uploads are refused, and such files already on
 * disk go out inert.
 */

describe('upload-file-types (issues/395)', () => {
  beforeEach(() => jest.resetModules());

  const run = async ({ path = '/api/upload', method = 'POST', files }) => {
    const middleware = require('../src/middlewares/upload-file-types')();
    const ctx = { method, path, request: { files } };
    const next = jest.fn();
    await middleware(ctx, next);
    return next;
  };

  it.each([['f2.html'], ['x.HTM'], ['g.js'], ['a.mjs'], ['feed.xml'], ['p.xhtml']])('refuses %s', async (name) => {
    await expect(run({ files: { files: [{ originalFilename: name }] } })).rejects.toMatchObject({
      name: 'ValidationError',
    });
  });

  it('refuses on the admin media library route and with one file', async () => {
    await expect(run({ path: '/upload', files: { files: { originalFilename: 'a.html' } } })).rejects.toThrow();
  });

  it('lets the files people upload through, SVG included (scopeUpload limits it)', async () => {
    for (const name of ['factura.pdf', 'comandes.csv', 'foto.JPG', 'logo.svg', 'cert.p12', 'nòmina.xlsx', 'doc.24']) {
      const next = await run({ files: { files: [{ originalFilename: name }] } });
      expect(next).toHaveBeenCalled();
    }
  });

  it('ignores other routes', async () => {
    const next = await run({ path: '/api/orders', files: { files: [{ originalFilename: 'a.html' }] } });
    expect(next).toHaveBeenCalled();
  });
});

describe('uploads-inert (issues/395)', () => {
  beforeEach(() => jest.resetModules());

  const serve = async (path) => {
    const middleware = require('../src/middlewares/uploads-inert')();
    const headers = {};
    const ctx = {
      path,
      body: 'x',
      type: 'text/html',
      set: (k, v) => {
        headers[k.toLowerCase()] = v;
      },
      attachment(name) {
        headers['content-disposition'] = `attachment; filename="${name}"`;
        this.type = name.endsWith('.js') ? 'application/javascript' : 'text/html'; // as koa does
      },
    };
    await middleware(ctx, async () => {});
    return { ctx, headers };
  };

  it('serves HTML and scripts as downloads, never as a page or a script', async () => {
    for (const p of ['/uploads/f2_9fafcf4e82.html', '/uploads/g_8a8c14e7a1.js', '/uploads/%2e/x.html']) {
      const { ctx, headers } = await serve(p);
      expect(ctx.type).toBe('application/octet-stream');
      expect(headers['content-disposition']).toMatch(/^attachment/);
      expect(headers['x-content-type-options']).toBe('nosniff');
      expect(headers['content-security-policy']).toMatch(/sandbox/);
    }
  });

  it('keeps SVG an image but sandboxed', async () => {
    const { ctx, headers } = await serve('/uploads/logo_abc.svg');
    expect(ctx.type).toBe('text/html'); // untouched here: koa-send sets image/svg+xml
    expect(headers['content-disposition']).toBeUndefined();
    expect(headers['content-security-policy']).toMatch(/default-src 'none'.*sandbox/);
  });

  it('leaves PDFs, images and other paths alone', async () => {
    for (const p of ['/uploads/documents/Factura-x.pdf', '/uploads/foto.jpg', '/api/orders.html', '/index.html']) {
      const { headers } = await serve(p);
      expect(headers).toEqual({});
    }
  });
});
