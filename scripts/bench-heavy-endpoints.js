'use strict';
/**
 * Times the heavy read endpoints on a local database and saves their responses,
 * so a change can be measured and its output compared (issues/309).
 *
 *   DATABASE_NAME=projectes_v5_resilience CRON_ENABLED=false \
 *     node scripts/bench-heavy-endpoints.js <outDir> [passes=3]
 *
 * BENCH_ONLY=<regexp> runs only the matching cases; BENCH_YEAR sets the year.
 *
 * Boots Strapi without the HTTP server and calls the controllers with a fake
 * ctx (an admin user), counting the SQL queries of each call. Prints the median
 * time of the passes; writes <outDir>/<case>.json with the response of the last
 * pass. Compare two runs with scripts/bench-compare.js.
 */
const fs = require('fs');
const path = require('path');

const ROOT = path.resolve(__dirname, '..');

const CASES = (year) => [
  ['economic-detail-all', 'api::project.project', 'findWithEconomicDetail', { _limit: '-1' }],
  ['economic-detail-year', 'api::project.project', 'findWithEconomicDetail', { _limit: '-1', _where: { year_eq: year } }],
  // the call of Informes › Ingressos/Despeses that took 40 s on resilience
  ['economic-detail-states', 'api::project.project', 'findWithEconomicDetail', { _limit: '-1', _where: { project_state_in: '1,2,3,5,6,7,8,0', year_eq: year } }],
  // Informes › Dedicació gantt, 10 s on resilience
  ['dedications-month', 'api::project.project', 'findDedications', { _where: { project_state_in: '1,2,3,5,6,7' }, hoursType: 'previstes', year, view: 'month' }],
  ['dedications-week', 'api::project.project', 'findDedications', { _where: { project_state_in: '1,2,3,5,6,7' }, hoursType: 'previstes', year, view: 'week' }],
  ['dedications-month-norows', 'api::project.project', 'findDedications', { _where: { project_state_in: '1,2,3,5,6,7' }, hoursType: 'previstes', year, view: 'month', rows: 'false' }],
  ['forecast-year', 'api::treasury.treasury', 'forecast', { _limit: '-1', year, periodification: 'prevista' }],
  ['forecast-real', 'api::treasury.treasury', 'forecast', { _limit: '-1', year, periodification: 'real' }],
];

const median = (xs) => [...xs].sort((a, b) => a - b)[Math.floor(xs.length / 2)];

async function main() {
  const outDir = process.argv[2];
  const passes = Number(process.argv[3]) || 3;
  if (!outDir) throw new Error('usage: bench-heavy-endpoints.js <outDir> [passes]');
  fs.mkdirSync(outDir, { recursive: true });

  const { createStrapi } = require('@strapi/strapi');
  const app = await createStrapi({ appDir: ROOT, distDir: ROOT }).load();
  let queries = 0;
  app.db.connection.on('query', () => { queries += 1; });

  const user = await app.db.query('plugin::users-permissions.user').findOne({ where: { blocked: false } });
  // Fixed so runs on different days compare equal.
  const year = process.env.BENCH_YEAR || '2026';
  const lines = [];
  const only = process.env.BENCH_ONLY ? new RegExp(process.env.BENCH_ONLY) : null;
  for (const [name, uid, action, query] of CASES(year).filter(([n]) => !only || only.test(n))) {
    const times = [];
    let body;
    for (let i = 0; i < passes; i++) {
      queries = 0;
      const ctx = {
        query: JSON.parse(JSON.stringify(query)),
        params: {},
        request: { query },
        state: { user, auth: { credentials: user } },
        send(b) { this.body = b; },
        badRequest(m) { throw new Error(m); },
        notFound(m) { throw new Error(`404 ${m}`); },
        forbidden(m) { throw new Error(m); },
        set() {},
      };
      const t = process.hrtime.bigint();
      const res = await app.controller(uid)[action](ctx);
      times.push(Number(process.hrtime.bigint() - t) / 1e6);
      body = ctx.body !== undefined ? ctx.body : res;
    }
    const json = JSON.stringify(body);
    fs.writeFileSync(path.join(outDir, `${name}.json`), json);
    const line = `${name.padEnd(22)} median ${median(times).toFixed(0).padStart(6)} ms  (${times.map((t) => t.toFixed(0)).join(', ')})  ${queries} queries  ${(json.length / 1e6).toFixed(2)} MB`;
    console.log(line);
    lines.push(line);
  }
  fs.writeFileSync(path.join(outDir, 'timings.txt'), `${lines.join('\n')}\n`);
  await app.destroy();
}

main().then(() => process.exit(0), (e) => { console.error(e); process.exit(1); });
