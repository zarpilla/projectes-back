'use strict';

/**
 * File types a browser runs when it opens them (issues/395).
 *
 * /uploads is served from the app's own domain. Strapi accepts a file sent as
 * `application/octet-stream` when its first bytes look like an allowed type
 * (`%PDF`, a GIF header…) and keeps the name's extension, so a member stored
 * `<hash>.html` and `<hash>.js` (a GIF that is also valid JavaScript): the page
 * loaded the script, which counts as 'self' for the CSP, and ran on the app's
 * origin, where the session token lives. Nobody uploads these types for real.
 */

const ACTIVE_EXTENSIONS = [
  'html',
  'htm',
  'xhtml',
  'xht',
  'shtml',
  'mht',
  'mhtml',
  'xml',
  'xsl',
  'xslt',
  'js',
  'mjs',
  'cjs',
  'svg',
  'svgz',
];

const ACTIVE = new RegExp(`\\.(${ACTIVE_EXTENSIONS.join('|')})$`, 'i');
const SVG = /\.svgz?$/i;

/** Whether a file name or path ends in an extension the browser would run. */
const isActiveName = (name) => ACTIVE.test(String(name || '').trim());

/** SVG: allowed to full users (logos), but still never served as a document. */
const isSvgName = (name) => SVG.test(String(name || '').trim());

module.exports = { ACTIVE_EXTENSIONS, isActiveName, isSvgName };
