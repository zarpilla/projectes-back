'use strict';

/**
 * Files under /uploads that a browser would run (HTML, XML, scripts, SVG) never
 * go out as active content, whatever is already on disk (issues/395):
 *
 * - HTML/XML/scripts: `application/octet-stream` + attachment. With `nosniff`
 *   a browser neither renders the page nor runs the file as a script.
 * - SVG: still an image (logos are shown with <img>, which never runs scripts),
 *   but opened on its own it is sandboxed and may load nothing.
 *
 * Must precede strapi::public, like block-key-material.
 */

const path = require('path');
const { isActiveName, isSvgName } = require('../services/active-file-types');

const UPLOADS = /^\/uploads\//i;

function decodedPaths(raw) {
  try {
    const decoded = decodeURIComponent(raw);
    return [raw, decoded, path.posix.normalize(decoded)];
  } catch {
    return [raw];
  }
}

const SVG_POLICY = "default-src 'none'; style-src 'unsafe-inline'; img-src data:; sandbox";

module.exports = () => async (ctx, next) => {
  const paths = decodedPaths(ctx.path || '').filter((p) => UPLOADS.test(p));
  if (!paths.length || !paths.some(isActiveName)) return next();
  await next();
  if (!ctx.body) return;
  ctx.set('X-Content-Type-Options', 'nosniff');
  if (paths.some(isSvgName)) {
    ctx.set('Content-Security-Policy', SVG_POLICY);
    return;
  }
  // attachment() sets the type from the extension: the type goes after it
  ctx.attachment(path.posix.basename(paths[paths.length - 1]));
  ctx.type = 'application/octet-stream';
  ctx.set('Content-Security-Policy', "default-src 'none'; sandbox");
};
