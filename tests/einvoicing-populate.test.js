'use strict';

/**
 * Guards the FACe and VeriFactu paths against the v3->v5 relation trap.
 *
 * v3's `strapi.query(uid).find()` populated first-level relations automatically,
 * so a nested relation came back as its FK id and code could read
 * `chain.emitted_invoice.contact` or `faceQueue.emitted_invoice` directly. v5
 * omits an unpopulated relation ENTIRELY, which turns those reads into
 * `undefined` — and in this corner of the app that does not raise anything
 * useful, it quietly diverts to an error branch or throws
 * "Undefined binding(s) detected when compiling WHERE" deep inside knex.
 *
 * Both features were switched off and both queue tables were empty when this was
 * written, so none of it had ever executed. These assertions are the substitute
 * for the end-to-end run that cannot be done without certificates and live AEAT
 * / FACe endpoints — they pin the populate lists to the relations the code
 * actually dereferences.
 */

const fs = require('fs');
const path = require('path');
const { relationId } = require('../src/services/relation-input');

const SRC = path.join(__dirname, '..', 'src');
const read = (...p) => fs.readFileSync(path.join(SRC, ...p), 'utf8');

const INVOICE_ATTRS = JSON.parse(
  read('api', 'emitted-invoice', 'content-types', 'emitted-invoice', 'schema.json'),
).attributes;

const NON_SCALAR = ['relation', 'component', 'media', 'dynamiczone'];
const invoiceRelations = new Set(
  Object.entries(INVOICE_ATTRS)
    .filter(([, def]) => def && NON_SCALAR.includes(def.type))
    .map(([name]) => name),
);

describe('emitted-invoice relations', () => {
  it('are what the guards below assume', () => {
    for (const name of ['contact', 'serial', 'user_real', 'lines']) {
      expect(invoiceRelations.has(name)).toBe(true);
    }
  });
});

describe('verifactu-chain lifecycle', () => {
  const source = read(
    'api', 'verifactu-chain', 'content-types', 'verifactu-chain', 'lifecycles.js',
  );

  it('populates every invoice relation it reads through emitted_invoice', () => {
    const dereferenced = new Set();
    for (const m of source.matchAll(/emitted_invoice\.([a-z_]+)/g)) {
      if (invoiceRelations.has(m[1])) dereferenced.add(m[1]);
    }
    // The nested populate block for emitted_invoice.
    const block = source.slice(source.indexOf('emitted_invoice: { populate: {'));
    const populated = block.slice(0, block.indexOf('}'));
    for (const name of dereferenced) {
      expect({ relation: name, populated: populated.includes(`${name}: true`) }).toEqual({
        relation: name,
        populated: true,
      });
    }
    expect(dereferenced.size).toBeGreaterThan(0);
  });

  it('never sends a lookup an id it has not checked', () => {
    // `where: { id: invoice.emitted_invoice.contact }` was the shape that threw.
    expect(source).not.toMatch(/where:\s*\{\s*id:\s*[a-zA-Z]+\.emitted_invoice\./);
  });
});

describe('face-queue service', () => {
  const source = read('api', 'face-queue', 'services', 'face-queue.js');

  it('populates emitted_invoice on the queue row it starts from', () => {
    const start = source.indexOf('const faceQueue = await strapi.db.query(FACE_QUEUE_UID).findOne(');
    expect(start).toBeGreaterThan(-1);
    expect(source.slice(start, start + 800)).toContain('populate: { emitted_invoice: true }');
  });

  it('normalises both relation shapes instead of reading the raw value', () => {
    expect(source).toContain('relationId(faceQueue.emitted_invoice)');
    expect(source).toContain('relationId(invoice.contact)');
  });
});

describe('emitted-invoice afterUpdate enqueue', () => {
  const source = read(
    'api', 'emitted-invoice', 'content-types', 'emitted-invoice', 'lifecycles.js',
  );
  const afterUpdate = source.slice(
    source.indexOf('async afterUpdate'),
    source.indexOf('async beforeDelete'),
  );

  it('populates the relations that gate the FACe and VeriFactu enqueues', () => {
    // `contact` decides whether a face-queue row is created at all; `user_real`
    // is stamped on the verifactu-chain row.
    expect(afterUpdate).toContain('populate: { contact: true, user_real: true }');
  });

  it('reads those relations through relationId', () => {
    expect(afterUpdate).toContain('relationId(invoice.contact)');
    expect(afterUpdate).toContain('relationId(invoice.user_real)');
  });
});

describe('relationId over the shapes these paths see', () => {
  it('reads a populated v5 relation object', () => {
    expect(relationId({ id: 12, code: '2026-1' })).toBe(12);
  });

  it('reads a bare v3 FK id', () => {
    expect(relationId(7)).toBe(7);
  });

  it('returns undefined for an absent relation, so callers can skip the lookup', () => {
    // This is the value an UNPOPULATED v5 relation produces; the point of the
    // guards is that it must never reach `where: { id: ... }`.
    expect(relationId(undefined)).toBeUndefined();
    expect(relationId(null)).toBeUndefined();
  });
});
