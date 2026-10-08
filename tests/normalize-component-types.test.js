'use strict';

/**
 * issues/002 (2026-10-08): a received income's single line showed twice and
 * came back after deleting the copy and saving (micelluralcoop, 2025-012).
 *
 * The ETL copied v3's `component_type` (the component's table name) into the
 * v5 `*_cmps` join tables, where v5 writes the component UID. v5 populates
 * every row of the field but only manages UID rows, so the first save that
 * re-linked the lines added UID rows next to the legacy ones and the legacy
 * ones were never removed.
 *
 * Guards normalizeComponentTypes: legacy rows with a UID twin are deleted, the
 * rest are renamed to the UID, and a second run changes nothing.
 */

const LINE_UID = 'invoice-line.ticket-line';
const LINE_TABLE = 'components_invoice_line_ticket_lines';
const CONTACT_UID = 'contact.contact-data';
const CONTACT_TABLE = 'components_contact_contact_data';

let rows;
let warn;

/** Answers the four statements the service issues, against `rows`. */
function fakeRaw(sql, bindings) {
  if (sql.includes('information_schema.TABLES')) {
    return [[{ name: 'received_incomes_cmps' }], []];
  }
  if (sql.startsWith('SELECT DISTINCT component_type')) {
    return [[...new Set(rows.map((r) => r.component_type))].map((type) => ({ type })), []];
  }
  if (sql.startsWith('DELETE')) {
    const [uid, legacy] = bindings;
    const before = rows.length;
    rows = rows.filter(
      (r) =>
        r.component_type !== legacy ||
        !rows.some(
          (c) =>
            c.component_type === uid && c.entity_id === r.entity_id && c.cmp_id === r.cmp_id && c.field === r.field,
        ),
    );
    return [{ affectedRows: before - rows.length }, undefined];
  }
  if (sql.startsWith('UPDATE')) {
    const [uid, legacy] = bindings;
    const hits = rows.filter((r) => r.component_type === legacy);
    hits.forEach((r) => {
      r.component_type = uid;
    });
    return [{ affectedRows: hits.length }, undefined];
  }
  throw new Error(`unexpected SQL: ${sql}`);
}

const link = (id, entity_id, cmp_id, component_type, field = 'lines', order = 1) => ({
  id,
  entity_id,
  cmp_id,
  component_type,
  field,
  order,
});

describe('normalizeComponentTypes (issues/002)', () => {
  let normalizeComponentTypes;

  beforeEach(() => {
    jest.resetModules();
    warn = jest.fn();
    global.strapi = {
      components: {
        [LINE_UID]: { collectionName: LINE_TABLE },
        [CONTACT_UID]: { collectionName: CONTACT_TABLE },
      },
      db: { connection: { raw: jest.fn(async (sql, bindings) => fakeRaw(sql.trim(), bindings)) } },
      log: { info: jest.fn(), warn },
    };
    ({ normalizeComponentTypes } = require('@/services/normalize-component-types'));
  });

  afterEach(() => {
    delete global.strapi;
  });

  it('drops the legacy link of a line v5 already re-linked, so it shows once', async () => {
    rows = [
      link(2, 24, 11, LINE_TABLE),
      link(12, 24, 11, LINE_UID),
    ];

    await normalizeComponentTypes();

    expect(rows).toEqual([link(12, 24, 11, LINE_UID)]);
  });

  it('renames legacy links that have no twin, keeping entity, field and order', async () => {
    rows = [
      link(1, 1, 10, LINE_TABLE, 'lines', 1),
      link(2, 1, 13, LINE_TABLE, 'lines', 2),
      link(9, 1, 915, CONTACT_TABLE, 'contact_info', 1),
    ];

    await normalizeComponentTypes();

    expect(rows).toEqual([
      link(1, 1, 10, LINE_UID, 'lines', 1),
      link(2, 1, 13, LINE_UID, 'lines', 2),
      link(9, 1, 915, CONTACT_UID, 'contact_info', 1),
    ]);
  });

  it('only treats a row as a twin for the same entity, component and field', async () => {
    rows = [
      link(1, 1, 10, LINE_TABLE),
      link(2, 2, 10, LINE_UID), // another document
    ];

    await normalizeComponentTypes();

    expect(rows).toEqual([link(1, 1, 10, LINE_UID), link(2, 2, 10, LINE_UID)]);
  });

  it('is a no-op on a table already in v5 form', async () => {
    rows = [link(12, 24, 11, LINE_UID)];

    await normalizeComponentTypes();
    await normalizeComponentTypes();

    const statements = global.strapi.db.connection.raw.mock.calls.map(([sql]) => sql.trim().split(/\s/)[0]);
    expect(statements).not.toContain('DELETE');
    expect(statements).not.toContain('UPDATE');
    expect(rows).toEqual([link(12, 24, 11, LINE_UID)]);
  });

  it('leaves an unknown component_type alone and says so', async () => {
    rows = [link(1, 1, 10, 'components_gone_away')];

    await normalizeComponentTypes();

    expect(rows).toEqual([link(1, 1, 10, 'components_gone_away')]);
    expect(warn).toHaveBeenCalledWith(expect.stringContaining('components_gone_away'));
  });
});
