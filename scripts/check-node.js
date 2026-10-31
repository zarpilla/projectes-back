'use strict';

/**
 * Node version guard for projectes-v5.
 *
 * Strapi 5 and several runtime deps (node-ical 0.26 uses the /…/gv regex
 * flag, only supported from Node 20) crash with cryptic SyntaxErrors on
 * Node < 20. This preflight turns that into an actionable message.
 *
 * Since Strapi 5.59 (issues/382) the floor is Node 22.19: Strapi loads undici 8,
 * which needs it, although Strapi's `engines` field still says >=20.
 */

const MIN = [22, 19];
const [major, minor] = process.versions.node.split('.').map((n) => parseInt(n, 10));

if (major < MIN[0] || (major === MIN[0] && minor < MIN[1])) {
  console.error('');
  console.error(
    `[projectes-v5] Node ${process.versions.node} detected — Node ${MIN.join('.')}+ is required.`,
  );
  console.error('[projectes-v5] Strapi 5.59+ loads undici 8, which needs Node 22.19 or later, and');
  console.error(
    '[projectes-v5] node-ical 0.26 crashes on Node < 20 with "Invalid regular expression flags".',
  );
  console.error('');
  console.error('Fix: run the app with Node 22, e.g.');
  console.error('  nvm use 22       # this repo ships a .nvmrc pinned to 22');
  console.error('  npm run dev');
  console.error('');
  process.exit(1);
}
