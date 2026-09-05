'use strict';

/**
 * Node version guard for projectes-v5.
 *
 * Strapi 5 and several runtime deps (node-ical 0.26 uses the /…/gv regex
 * flag, only supported from Node 20) crash with cryptic SyntaxErrors on
 * Node < 20. This preflight turns that into an actionable message.
 */

const MIN_MAJOR = 20;
const major = parseInt(process.versions.node.split('.')[0], 10);

if (major < MIN_MAJOR) {
  console.error('');
  console.error(`[projectes-v5] Node ${process.versions.node} detected — Node ${MIN_MAJOR}+ is required.`);
  console.error('[projectes-v5] Strapi 5 (and node-ical 0.26 in particular) crash on older Node');
  console.error('[projectes-v5] with "SyntaxError: Invalid regular expression flags".');
  console.error('');
  console.error('Fix: run the app with Node 20, e.g.');
  console.error('  nvm use 20       # this repo ships a .nvmrc pinned to 20');
  console.error('  npm run dev');
  console.error('');
  process.exit(1);
}
