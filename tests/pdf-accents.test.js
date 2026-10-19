'use strict';

/**
 * issues/198 (2026-10-19): invoice and quote PDFs dropped every accent of a
 * text as soon as it had one character above U+0500, e.g. the typographic
 * apostrophe ’ pasted from a word processor: «d’un pla estratègic» printed
 * «d'un pla estrategic». Only characters the font has no glyph for are
 * transliterated now.
 */

const Microinvoice = require('../utils/microinvoice');
const MicroinvoiceOrder = require('../utils/microinvoice-order');
const { printableText } = require('../utils/pdf-text');

const FONT = require('path').join(__dirname, '..', 'utils', 'Rubik-Regular.ttf');

describe('PDF text keeps what the font can print', () => {
  it('keeps accents next to a typographic apostrophe', () => {
    expect(printableText('Mediació artística i ideació d’un pla estratègic.', FONT))
      .toBe('Mediació artística i ideació d’un pla estratègic.');
  });

  it('keeps quotes, dashes, the euro sign and line breaks', () => {
    expect(printableText('“Plaça” – 12 €\nl·l', FONT)).toBe('“Plaça” – 12 €\nl·l');
  });

  it('transliterates only the characters the font lacks', () => {
    expect(printableText('Acció → feta', FONT)).toBe('Acció - feta');
  });

  it('leaves empty values alone', () => {
    expect(printableText(null, FONT)).toBeNull();
    expect(printableText(undefined, FONT)).toBeUndefined();
    expect(printableText(12, FONT)).toBe('12');
  });

  it.each([['invoice', Microinvoice], ['order', MicroinvoiceOrder]])('%s PDF uses it', (_, Writer) => {
    const writer = new Writer({});
    expect(writer.valueOrTransliterate('d’un pla estratègic')).toBe('d’un pla estratègic');
    expect(writer.valueOrTransliterate('Plaça de Sant Domènec')).toBe('Plaça de Sant Domènec');
  });
});
