/**
 * Found while writing the manual (2026-10): the subjects of the incidence,
 * task summary and contact form e-mails said «ESSSTRAPIS» (three S). Keeps the
 * misspelling out of the sources.
 */
const fs = require('fs');
const path = require('path');

const files = (dir) =>
  fs.readdirSync(dir, { withFileTypes: true }).flatMap((e) =>
    e.isDirectory() ? files(path.join(dir, e.name)) : /\.js$/.test(e.name) ? [path.join(dir, e.name)] : [],
  );

describe('e-mail wording', () => {
  it('spells ESSTRAPIS with two S', () => {
    const offenders = files(path.resolve(__dirname, '..', 'src'))
      .filter((f) => /ESSSTRAPIS/i.test(fs.readFileSync(f, 'utf8')))
      .map((f) => path.relative(path.resolve(__dirname, '..'), f));
    expect(offenders).toEqual([]);
  });
});
