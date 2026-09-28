'use strict';

/**
 * Uploaded files were attached correctly but never displayed: a received
 * expense with a row in files_related_mph (file 1318, field "documents")
 * showed "no document attached".
 *
 * Strapi 5 decides a media field's multiplicity from ONE key:
 *
 *   // @strapi/core/dist/utils/transform-content-types-to-models.js
 *   case 'media':
 *     relation: attribute.multiple === true ? 'morphMany' : 'morphOne',
 *
 * The schemas were ported from v3 carrying `"relation": "oneToMany"` and no
 * `multiple`, so every media field became morphOne — a single object rather
 * than an array. The frontend renders lists with
 * `v-if="form.documents && form.documents.length"`, and an object has no
 * `.length`, so every attachment list in the app rendered empty. The seven
 * single-file fields (logo, certificates, pdf) were unaffected, which is why
 * certificate uploads worked and only lists looked broken.
 *
 * `relation` is inert for media in v5. It is kept because
 * entity-metadata's controller echoes it, and it is used here as the
 * cross-check on what each field was in v3.
 */

const fs = require('fs');
const path = require('path');

const ROOT = path.join(__dirname, '..', 'src');

/** Every schema.json under src/, wherever Strapi looks for one. */
function schemaFiles(dir, found = []) {
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) schemaFiles(full, found);
    else if (entry.name.endsWith('.json')) found.push(full);
  }
  return found;
}

const mediaAttributes = [];
for (const file of schemaFiles(ROOT)) {
  let schema;
  try {
    schema = JSON.parse(fs.readFileSync(file, 'utf8'));
  } catch {
    continue;
  }
  for (const [name, def] of Object.entries(schema.attributes || {})) {
    if (def && def.type === 'media') {
      mediaAttributes.push({ file: path.relative(ROOT, file), name, def });
    }
  }
}

describe('media attributes', () => {
  it('there are some to check — guards the discovery above', () => {
    expect(mediaAttributes.length).toBeGreaterThan(0);
    expect(mediaAttributes.map((m) => m.name)).toContain('documents');
  });

  it.each(mediaAttributes.map((m) => [`${m.file} :: ${m.name}`, m]))(
    '%s declares multiple explicitly',
    (_label, { def }) => {
      // Absent means morphOne, which is a silent wrong answer for a list.
      expect(typeof def.multiple).toBe('boolean');
    }
  );

  it.each(
    mediaAttributes
      .filter((m) => m.def.relation)
      .map((m) => [`${m.file} :: ${m.name}`, m])
  )('%s agrees with what it was in v3', (_label, { def }) => {
    expect(def.multiple).toBe(def.relation === 'oneToMany');
  });

  it('keeps both list and single-file fields, so neither case is untested', () => {
    const multiple = mediaAttributes.filter((m) => m.def.multiple === true);
    const single = mediaAttributes.filter((m) => m.def.multiple === false);
    expect(multiple.length).toBeGreaterThan(0);
    expect(single.length).toBeGreaterThan(0);
    // the field the bug was reported against
    expect(
      multiple.some((m) => m.file.includes('received-expense') && m.name === 'documents')
    ).toBe(true);
  });
});
