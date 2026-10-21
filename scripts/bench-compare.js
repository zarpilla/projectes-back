'use strict';
/**
 * Compares the responses saved by two runs of bench-heavy-endpoints.js
 * (issues/309): same rows and amounts, apart from the fields trimmed on purpose
 * (`document` of the economic detail, the forecast `projects` reduced to what
 * the front reads).
 *
 *   node scripts/bench-compare.js <beforeDir> <afterDir>
 */
const fs = require('fs');
const path = require('path');

const EPS = 1e-6;
const ISO_NOW = /^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d\.\d{3}Z$/;
const SLIM_PROJECT = (p) => ({
  id: p.id,
  name: p.name,
  project_state: p.project_state ? { id: p.project_state.id, name: p.project_state.name } : null,
  mother: p.mother ? { id: p.mother.id, name: p.mother.name } : null,
});

// projects/phases-both keeps of each project and activity what the report reads (issues/309)
const ACTIVITY_FIELDS = ['id', 'date', 'hours', 'cost_by_hour', 'users_permissions_user', 'activity_type', 'dedication_type'];
const phasesBothProject = ({ project_phases, project_original_phases, ...p }) => ({
  ...p,
  leader: p.leader ? { id: p.leader.id, username: p.leader.username } : p.leader,
  ...(p.activities
    ? {
        activities: p.activities
          .map((a) => Object.fromEntries(ACTIVITY_FIELDS.map((f) => [f, a[f]])))
          .sort((x, y) => x.id - y.id),
      }
    : {}),
});

function normalize(name, body) {
  if (name.startsWith('phases-both') && Array.isArray(body)) return body.map(phasesBothProject);
  if (Array.isArray(body)) return body.map(({ document, ...row }) => row);
  if (body && Array.isArray(body.projects)) return { ...body, projects: body.projects.map(SLIM_PROJECT) };
  return body;
}

function diff(a, b, at, out) {
  if (out.length > 20) return;
  if (typeof a === 'number' && typeof b === 'number') {
    if (Math.abs(a - b) > EPS * Math.max(1, Math.abs(a))) out.push(`${at}: ${a} != ${b}`);
    return;
  }
  // the «Avui» rows carry the moment of the run
  if (typeof a === 'string' && typeof b === 'string' && ISO_NOW.test(a) && ISO_NOW.test(b)) return;
  if (a === null || b === null || typeof a !== 'object' || typeof b !== 'object') {
    if (a !== b) out.push(`${at}: ${JSON.stringify(a)} != ${JSON.stringify(b)}`);
    return;
  }
  if (Array.isArray(a) !== Array.isArray(b)) { out.push(`${at}: array vs object`); return; }
  if (Array.isArray(a) && a.length !== b.length) out.push(`${at}: length ${a.length} != ${b.length}`);
  const keys = new Set([...Object.keys(a), ...Object.keys(b)]);
  for (const k of keys) {
    if (!(k in a)) { out.push(`${at}.${k}: missing before`); continue; }
    if (!(k in b)) { out.push(`${at}.${k}: missing after`); continue; }
    diff(a[k], b[k], `${at}.${k}`, out);
  }
}

const [beforeDir, afterDir] = process.argv.slice(2);
let failed = false;
for (const file of fs.readdirSync(beforeDir).filter((f) => f.endsWith('.json') && fs.existsSync(path.join(afterDir, f)))) {
  const name = file.replace(/\.json$/, '');
  const read = (dir) => normalize(name, JSON.parse(fs.readFileSync(path.join(dir, file), 'utf8')));
  const out = [];
  diff(read(beforeDir), read(afterDir), name, out);
  console.log(out.length ? `DIFF ${name}\n  ${out.join('\n  ')}` : `same ${name}`);
  if (out.length) failed = true;
}
process.exit(failed ? 1 : 0);
