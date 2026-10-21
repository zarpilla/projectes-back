# Read cache (issues/307)

One in-process cache for reads that are heavy or frequent and change rarely.
An answer is kept until a table it depends on changes; the change is detected
from the SQL this process sends to MySQL, and from MySQL's own per-table commit
time for writes made elsewhere. Code that writes never has to tell the cache
anything.

Code: `src/services/read-cache/` (each file explains itself), the route
middleware `src/middlewares/read-cache.js`, the admin endpoints
`src/api/read-cache/`.

## How a change is detected

| Who writes | How the cache learns it | When |
|---|---|---|
| This process: document service, `db.query`, `*Many`, `strapi.db.connection.raw`, the knex builder, startup scripts, crons, the admin panel | the hook on every MySQL connection of the pool (`mysql-hook.js`, installed by `config/database.js`) sees the statement | at once: the end of the statement, or of the COMMIT inside a transaction |
| Foreign key cascades (`ON DELETE CASCADE` / `SET NULL`) | the tracker follows the foreign keys of the written table (read from information_schema) | with the write |
| Another process (the other slot during a deploy), manual SQL, a restore | `information_schema.TABLES.UPDATE_TIME` / `CREATE_TIME` of the tables the cache depends on (`table-stamps.js`) | within `READ_CACHE_STAMPS_MS` (2 s) + 2 s |
| A MySQL restart | its start time moved | at the next stamps reading: everything dropped |
| (MySQL keeps UPDATE_TIME in memory: NULL for a table not written since MySQL started, and again NULL after a TRUNCATE (CREATE_TIME doesn't move) or when InnoDB evicts the table from its dictionary cache. A value → NULL counts as a change; a first reading NULL never covers a result loaded before it; NULL → NULL counts as unchanged. So one case is not seen: a write from outside to a table, then its eviction before the next reading; the entry stays until its TTL. InnoDB doesn't evict tables with foreign keys (almost all of Strapi's): only the ~17 per database without any (component tables such as periodification, options, application permissions; `strapi_*`), and only when more tables are open than `table_definition_cache` (2000 on the VPS, below the number of tables of all databases). Read on the VPS on 2026-10-21: stamps of tables with foreign keys, and of `strapi_core_store_settings`, kept for days, through the nightly dump. A `table_definition_cache` above the number of tables of the server removes the case.) | | |
| Something none of the above sees | `READ_CACHE_VERIFY` shows it as `[read-cache] STALE entry` errors; «Buida la memòria cau» (`POST /api/read-cache/clear`); `READ_CACHE_TTL_S` | — |

Rules that keep it safe (`change-tracker.js`, `read-cache.js`):

- A statement is a harmless read only when it clearly is one. Anything not
  recognised, a write naming no known table, and any DDL count as a change of
  every table.
- A write counts only if MySQL reports rows changed (`changedRows` of an
  UPDATE, `affectedRows` otherwise): `set dirty = 1` on a row already dirty
  changes nothing. A failed write, or one without a readable answer, counts.
- Every table a connection writes stays pending until its COMMIT/ROLLBACK, and
  is stamped again then. Savepoints and other connections never clear it.
- A result remembers the change counter at which its load began. It is served
  only while none of its tables has a later change, and never kept if one
  changed while it was loading.
- A result depends on the tables you declare **and on every table its load
  actually read** (recorded through AsyncLocalStorage). A load that writes, or
  reads no known table, is never kept.
- Inside a transaction (`strapi.db.inTransaction()`) the cache is skipped.
- Callers get their own copy; the cache keeps a private one.
- At boot the cache turns on only after a probe statement and a probe
  transaction (BEGIN … COMMIT) were seen by the hook, and the first stamps
  reading worked. Otherwise it stays off and logs `[read-cache] off: …`.
  If the hook or the tracker ever fails, the cache turns off.

## Using it

```js
const { getReadCache } = require('../../services/read-cache');

const rows = await getReadCache().get(
  `forecast-dataset:${year}`,              // everything the result depends on besides the data
  () => loadForecastDataset(year),        // the normal, uncached load
  { tables: ['treasuries', 'payrolls'] }, // optional: declared tables (read tables are added)
);
```

- The key must hold everything the result depends on that is not data: query
  parameters, the role if the result is cleaned by role, today's date if the
  result uses it. **Never** the per-user cleaning: cache the raw data and clean
  per request after `get`.
- `keep: (value) => boolean` refuses to keep a result (an error answer).
- `frozen: true` for big read-only datasets: the result is deep-frozen once
  and the same object goes to every caller (no copy on store or on hit). It is
  frozen also when the cache is off, so code that changes it (in-place
  `sort`, adding or deleting fields) throws the same way everywhere: copy what
  you change. Only plain data (no buffers, Maps or Sets).
- `maxBytes`: the largest result kept (default a quarter of
  `READ_CACHE_MAX_MB`, never more than it). The size is the JSON size; the
  heap holds about 2–3 times that.
- `verifyRate`: this call's share of verified hits (0 for expensive loads).
- Declaring `tables` also reads their MySQL stamps before the first load, so
  the first result is served from its second read on.
- A loader may call `get` for another key: the outer result depends on the
  inner one's tables too.
- Don't cache results that depend on the clock (unless the date is in the key),
  on random values, or on in-memory state outside the database.
- Results are copied with `structuredClone`: plain data only.

### A GET route

Add the API and its read actions to `CACHED_ROUTES` in
`services/read-cache/routes.js`. The answer is then kept per route, route
parameters, query and role (or Public), after `global::app-permissions` (access
checked and the answer cleaned for the caller on every request). Only list
actions whose answer depends on nothing but those and the data (review custom
controllers one by one: `GET /activity-types/global` writes, so it is not
listed).

Cached today: the master tables («Taules auxiliars» except «Festius
d'usuari», plus months, routes and city routes), and `contacts/basic`,
`contacts/for-orders`, `projects/basic`. The last three declare only their own
table (`OWN_TABLE_ONLY`): declaring all of a project's link tables would drop
`projects/basic` on every hour logged. Contacts were checked against every
role's scope in `middlewares/app-permissions.js` (members' filters go into the
query, so each member has her own entry; cleaning per person happens after).

Also the gantts of Informes (`projects/dedications`, Previsió dedicació;
`projects/real-dedications`, % Dedicació real) and `projects/estimated-totals`
(Justificacions): built from the query string and the data only, no scope of
app-permissions. The gantts depend on the day too (the current year by
default; % Dedicació real leaves the periods to come empty), so their key
carries it (`DATED_ROUTES`). A route keeps no answer above 4 MB
(`ROUTE_MAX_BYTES`): each hit is a copy, and the few bigger answers (the
Excel rows of Previsió dedicació, every year's estimated totals) are rare.

### Datasets kept by the controllers

Frozen and shared (`frozen: true`), filtered per request:

- Tresoreria (`treasuries/forecast`) and Informes › Dedicació
  (`projects/phases-both`): what they load, unfiltered (issues/309).
- Ingressos/Despeses and Preu hora (`projects/economic-detail`): the rows of
  every published, non-mother project, computed once and kept in the order of
  the answers with each project's state; a request filters them by state, year
  and paid and answers copies. The current year is in the key (undated
  projects take it). A search by name (`_q`) or one state
  (`_where[project_state_eq]`) is computed as before.
- Everyone's daily dedications and festives (`services/calendars.js`), shared
  by those reports, the estimated totals and the project form. They replaced
  `projectCache.js`, which change detection couldn't see and which went stale
  (dirty marks in `before` hooks, no *Many hooks, raw SQL).

On resilience (the biggest tenant) all of it takes ~50 MB of the 64 MB cap;
raise `READ_CACHE_MAX_MB` if `/read-cache/stats` shows evictions.

### Per request: the user and her app permissions

Every authenticated request read the user and her role
(`fetchAuthenticatedUser`) and her app permissions (app-permissions
middleware): 7 queries for an answer served from memory. Both are kept per user
(`services/authenticated-user-cache.js`, `services/app-permissions.js`):
3 queries left (the API-token lookup, the access token's user check, the
plugin's settings). Blocking a user or changing her role or app permissions
applies at her next request; secrets are never kept.

Comparing answers: Strapi fills populated relations with parallel queries, so
the key order of a row varies between two loads of the same data. The
verification compares with sorted keys (`canonicalJson`).

## Settings (environment)

| Variable | Default | |
|---|---|---|
| `READ_CACHE` | on | `false` turns it off, hook included |
| `READ_CACHE_MAX_MB` | 64 | memory cap per process (JSON size; least recently used out) |
| `READ_CACHE_TTL_S` | 600 | no answer is kept longer |
| `READ_CACHE_STAMPS_MS` | 2000 | max age of MySQL's stamps when an answer is served |
| `READ_CACHE_VERIFY` | 0 | share of hits loaded again and compared (0..1). A difference drops the entry; if the stamps then report a write from outside on its tables it was the normal delay for those (warning «served up to a few seconds after a write from outside»), otherwise it is a detection failure: `[read-cache] STALE entry` error with the first difference |

## Administration

- `GET /api/read-cache/stats` (app admins): entries, bytes, hits, misses, why
  answers were not kept or were dropped (`evicted`: pushed out by the cap),
  verification results, what the tracker and the stamps saw, and the
  process's memory (`memory`: RSS, heap used, heap limit, the container's
  limit) to size `READ_CACHE_MAX_MB` per tenant: the kept bytes are a
  JSON-size estimate, the heap holds about 2.5 times that.
- `POST /api/read-cache/clear` (app admins): «Buida la memòria cau», the button
  of Configuració general › Memòria cau, which also shows the stats.

## Tests

- `tests/read-cache-*.test.js`: the statement classifier, the tracker, the
  hook, the stamps, the cache, the routes and the boot gate (unit).
- `tests/read-cache-mysql.test.js`: everything together against a real MySQL,
  every write path, writes from a second connection, random concurrent writes
  and reads compared with the database. Runs with
  `READ_CACHE_TEST_MYSQL=mysql://user:pass@host:port` (CI starts a MySQL 8.0).
