'use strict';

/**
 * issues/001 (2026-10-08): the new document-change-log type declared a
 * `document_id` attribute, which Strapi 5 reserves (it backs `documentId`).
 * Unit tests passed, but `strapi develop` refused to boot. This checks every
 * schema against Strapi's own reserved-name list, so a clash fails here first.
 */

const fs = require('fs');
const path = require('path');
const { contentTypes } = require('@strapi/utils');

const API_DIR = path.join(__dirname, '..', 'src', 'api');

function schemas() {
  const out = [];
  for (const api of fs.readdirSync(API_DIR)) {
    const dir = path.join(API_DIR, api, 'content-types');
    if (!fs.existsSync(dir)) continue;
    for (const type of fs.readdirSync(dir)) {
      const file = path.join(dir, type, 'schema.json');
      if (fs.existsSync(file)) out.push([`${api}/${type}`, JSON.parse(fs.readFileSync(file, 'utf8'))]);
    }
  }
  return out;
}

describe('content-type attribute names', () => {
  it('finds the schemas', () => {
    expect(schemas().length).toBeGreaterThan(10);
  });

  it.each(schemas())('%s uses no name Strapi reserves', (_name, schema) => {
    const reserved = Object.keys(schema.attributes || {}).filter((attr) =>
      // `status` is only reserved on draft-and-publish types.
      contentTypes.isReservedAttributeName(attr, {
        draftAndPublish: Boolean(schema.options && schema.options.draftAndPublish),
      }),
    );
    expect(reserved).toEqual([]);
  });
});
