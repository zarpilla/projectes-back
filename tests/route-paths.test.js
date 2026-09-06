'use strict';

/**
 * Route paths must not carry a trailing slash.
 *
 * v3's routes.json declared two of them that way — "/orders/check-multidelivery/"
 * and "/orders/pdf/" — and Strapi 3's router matched the slashless request
 * anyway. v5's router does not. The frontend posts without the slash, so the
 * request fell through to the core `/orders/:documentId` route instead, which
 * has no POST handler: hence 405 Method Not Allowed rather than a 404, which
 * is what made it look like a method problem rather than a path typo.
 *
 * 60-odd custom routes were ported from v3 by hand, so this guards the whole
 * set rather than the two that were found.
 */

const fs = require('fs');
const path = require('path');

const API_DIR = path.join(__dirname, '..', 'src', 'api');

function routeFiles() {
  const out = [];
  for (const api of fs.readdirSync(API_DIR)) {
    const dir = path.join(API_DIR, api, 'routes');
    if (!fs.existsSync(dir)) continue;
    for (const file of fs.readdirSync(dir)) {
      if (file.endsWith('.js')) out.push(path.join(dir, file));
    }
  }
  return out;
}

/** Every `path: '...'` literal in the route files, with its location. */
function declaredPaths() {
  const found = [];
  for (const file of routeFiles()) {
    const source = fs.readFileSync(file, 'utf8');
    source.split('\n').forEach((line, i) => {
      const m = /\bpath:\s*'([^']*)'/.exec(line);
      if (m) found.push({ file: path.relative(API_DIR, file), line: i + 1, path: m[1] });
    });
  }
  return found;
}

describe('custom route paths', () => {
  const paths = declaredPaths();

  it('finds the route declarations', () => {
    expect(paths.length).toBeGreaterThan(30);
  });

  it('never end with a trailing slash', () => {
    const offenders = paths
      .filter((p) => p.path.length > 1 && p.path.endsWith('/'))
      .map((p) => `${p.file}:${p.line} ${p.path}`);
    expect(offenders).toEqual([]);
  });

  it('start with a slash', () => {
    const offenders = paths
      .filter((p) => !p.path.startsWith('/'))
      .map((p) => `${p.file}:${p.line} ${p.path}`);
    expect(offenders).toEqual([]);
  });

  it('are not double-prefixed with /api', () => {
    // v5 mounts custom routes at /api + the path as written.
    const offenders = paths
      .filter((p) => p.path.startsWith('/api/'))
      .map((p) => `${p.file}:${p.line} ${p.path}`);
    expect(offenders).toEqual([]);
  });
});
