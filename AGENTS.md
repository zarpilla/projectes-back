# projectes-v5 (Strapi 5 backend)

## Commands
- `npm run dev` — Strapi in develop mode
- `npm test` — Jest (all `tests/**/*.test.js`)
- `npm test -- tests/<file>.test.js` — a single test file
- `npm run lint`

## Tests
Every bug fix or feature should come with a test that fails before the change and passes after it. If that is not reasonable, say why in the issue/PR.

- Tests live flat in `tests/`, named `<topic>.test.js`.
- They don't boot Strapi. They `require` the controller, service or lifecycle under test and stub `global.strapi` with only what that code touches (see `tests/order-invoice-reinvoice-guard.test.js`). Call `jest.resetModules()` in `beforeEach` so each test gets a fresh module and stub.
- Controllers are tested by calling the action with a fake `ctx` (`request.body`, `params`, `state.user`, `send`/`body`).
- For regressions, start the file with a comment describing the incident or issue (date, what broke, what the test guards). Reference the issue id when there is one (e.g. `issues/001`).
- `@/` resolves to `src/`.

## Repairing existing data: run-once startup scripts
A code fix only corrects rows written from now on. When the bug also left wrong data behind (stale totals, missing computed fields), ship the repair with the fix as a run-once startup script, so every tenant is corrected on its next deploy without manual SQL:

- Put it in `src/services/<verb>-<what>.js`, exporting one async function, and register it in the `fixes` list of `bootstrap()` in `src/index.js` with `{ runOnce: true }`.
- `runStartupScript` (`src/services/startup-scripts.js`) records each run in `startup_scripts`: a finished run never repeats; a run that started but never ended is not retried and needs a look. Use `{ runOnce: false }` only for cheap, idempotent checks that must hold after every ETL rebuild.
- Keep handlers idempotent (several PM2 instances may boot at once), touch only rows that are actually wrong, and log what changed.
- Write straight to the table (`strapi.db.connection(...)`) when going through the entity layer would rerun lifecycles or be refused by guards.
- For project totals, don't recompute inline: mark the projects `dirty` and let the totals cron (`config/cron.js`) drain them.
- Test the handler like any other service (stub `global.strapi`); examples: `recalc-zero-document-totals.js`, `backfill-activity-costs.js`.
