'use strict';

/**
 * 2026-10-16: with the entity's logo record pointing to a file that wasn't on
 * disk (a database restored without its uploads), every invoice PDF answered
 * 500 (pdfkit: ENOENT opening the logo). resolvePdfLogo returns null in that
 * case so the PDF is drawn without a logo, and logs a warning.
 */
const fs = require('fs');
const os = require('os');
const path = require('path');

describe('resolvePdfLogo', () => {
  let cwd;
  let dir;
  let resolvePdfLogo;
  const log = { warn: jest.fn() };

  beforeEach(() => {
    jest.resetModules();
    log.warn.mockClear();
    cwd = process.cwd();
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'pdf-logo-'));
    fs.mkdirSync(path.join(dir, 'public/uploads'), { recursive: true });
    process.chdir(dir);
    ({ resolvePdfLogo } = require('../src/services/pdf-logo'));
  });

  afterEach(() => {
    process.chdir(cwd);
    fs.rmSync(dir, { recursive: true, force: true });
  });

  test('no logo: null', async () => {
    expect(await resolvePdfLogo({}, { log })).toBeNull();
    expect(await resolvePdfLogo(null, { log })).toBeNull();
  });

  test('a logo whose file is missing: null and a warning, no exception', async () => {
    const me = { logo: { url: '/uploads/arrandeterra_logo.png' } };
    expect(await resolvePdfLogo(me, { log })).toBeNull();
    expect(log.warn).toHaveBeenCalledTimes(1);
  });

  test('a logo on disk: its path', async () => {
    fs.writeFileSync('public/uploads/logo.png', 'png');
    expect(await resolvePdfLogo({ logo: { url: '/uploads/logo.png' } }, { log })).toBe('./public/uploads/logo.png');
  });

  test('an SVG logo is converted; if that fails, null', async () => {
    fs.writeFileSync('public/uploads/logo.svg', '<svg/>');
    const me = { logo: { url: '/uploads/logo.svg' } };
    const ok = () => ({ png: () => ({ toFile: async () => {} }) });
    expect(await resolvePdfLogo(me, { sharp: ok, log })).toBe('./public/uploads/invoice-logo.jpg');
    const broken = () => ({ png: () => ({ toFile: async () => { throw new Error('bad svg'); } }) });
    expect(await resolvePdfLogo(me, { sharp: broken, log })).toBeNull();
    expect(log.warn).toHaveBeenCalledTimes(1);
  });
});
