'use strict';

/**
 * The PDF generators load their fonts from disk at render time, so a missing
 * file is invisible until someone creates an invoice or an order PDF — it
 * surfaces as `ENOENT ... Rubik-Medium.ttf` deep inside pdfkit, from an
 * afterCreate lifecycle. The v5 port copied `utils/*.js` but not the .ttf files
 * beside them.
 *
 * Asserts every font path referenced from utils/ actually exists.
 */
const fs = require('fs');
const path = require('path');

const UTILS = path.join(__dirname, '..', 'utils');

describe('PDF font assets', () => {
  const sources = fs.readdirSync(UTILS).filter((f) => f.endsWith('.js'));

  test('utils/ holds the PDF generators', () => {
    expect(sources.length).toBeGreaterThan(0);
  });

  test('every font referenced from utils/ exists on disk', () => {
    const missing = [];
    for (const file of sources) {
      const src = fs.readFileSync(path.join(UTILS, file), 'utf8');
      for (const match of src.matchAll(/['"]([A-Za-z0-9_-]+\.(?:ttf|otf))['"]/g)) {
        const font = match[1];
        if (!fs.existsSync(path.join(UTILS, font))) missing.push(`${file} -> ${font}`);
      }
    }
    expect(missing).toEqual([]);
  });
});
