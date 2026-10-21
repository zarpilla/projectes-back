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

Cached today (phase 1): the master tables, i.e. «Taules auxiliars» except
«Festius d'usuari», plus months, routes and city routes.

## Settings (environment)

| Variable | Default | |
|---|---|---|
| `READ_CACHE` | on | `false` turns it off, hook included |
| `READ_CACHE_MAX_MB` | 64 | memory cap per process (JSON size; least recently used out) |
| `READ_CACHE_TTL_S` | 600 | no answer is kept longer |
| `READ_CACHE_STAMPS_MS` | 2000 | max age of MySQL's stamps when an answer is served |
| `READ_CACHE_VERIFY` | 0 | share of hits loaded again and compared (0..1); a difference no change explains is logged as `[read-cache] STALE entry` and dropped |

## Administration

- `GET /api/read-cache/stats` (app admins): entries, bytes, hits, misses, why
  answers were not kept or were dropped, verification results, what the
  tracker and the stamps saw.
- `POST /api/read-cache/clear` (app admins): «Buida la memòria cau».

## Tests

- `tests/read-cache-*.test.js`: the statement classifier, the tracker, the
  hook, the stamps, the cache, the routes and the boot gate (unit).
- `tests/read-cache-mysql.test.js`: everything together against a real MySQL,
  every write path, writes from a second connection, random concurrent writes
  and reads compared with the database. Runs with
  `READ_CACHE_TEST_MYSQL=mysql://user:pass@host:port` (CI starts a MySQL 8.0).
