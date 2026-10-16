'use strict';

const fs = require('fs');

/**
 * The logo for the invoice / quote / order PDFs, or null to draw them without one.
 *
 * 2026-10-16: an entity whose logo record pointed to a file that wasn't on disk
 * (a database copied without its uploads) got a 500 on every invoice PDF:
 * pdfkit threw ENOENT opening the image. A missing or unreadable logo now only
 * logs a warning; the document is still generated.
 *
 * SVG logos are converted to a PNG first (pdfkit can't draw SVG), as before.
 */
async function resolvePdfLogo(me, { sharp, log, svgOut = './public/uploads/invoice-logo.jpg' } = {}) {
  const url = me && me.logo && me.logo.url;
  if (!url) return null;
  const file = `./public${url}`;
  if (!fs.existsSync(file)) {
    if (log) log.warn(`PDF logo not found on disk (${file}): the document is generated without it`);
    return null;
  }
  if (file.endsWith('.svg')) {
    try {
      await sharp(file).png().toFile(svgOut);
      return svgOut;
    } catch (error) {
      if (log) log.warn(`PDF logo could not be converted (${file}): ${error.message}`);
      return null;
    }
  }
  return file;
}

module.exports = { resolvePdfLogo };
