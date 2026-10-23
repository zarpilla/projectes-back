/**
 * 2026-10-22 (with issues/318): the PDFs wrote «EUR» because the € sign was
 * thought not to print. The Rubik fonts have the glyph, so amounts now use €
 * (shorter cells, fewer wrapped rows). Text with € used to switch to the
 * fallback font (Rubik-Regular) as any character above U+0500 did, so a bold
 * «TOTAL 363,00 €» lost its weight.
 *
 * Guards: € is drawn as €, in the font the text asked for (bold stays bold),
 * in invoice and order PDFs; a character the font lacks is still transliterated.
 */
const MicroInvoice = require('../utils/microinvoice');
const MicroInvoiceOrder = require('../utils/microinvoice-order');
const { fontHasAll } = require('../utils/pdf-text');

describe.each([
  ['invoice', MicroInvoice],
  ['order', MicroInvoiceOrder],
])('€ in %s PDFs', (_, Klass) => {
  const pdf = new Klass({});
  pdf.document = { registerFont: jest.fn() };

  it('keeps the bold font for bold text with €', () => {
    expect(pdf.getFontOrFallback('bold', 'TOTAL 363,00 €')).toBe(pdf.options.style.fonts.bold.name);
  });

  it('keeps € as € (no transliteration)', () => {
    expect(pdf.valueOrTransliterate('2,98 € (20%)')).toBe('2,98 € (20%)');
  });

  it('still transliterates a character the font lacks', () => {
    expect(fontHasAll('漢', pdf.options.style.fonts.bold.path)).toBe(false);
    expect(pdf.valueOrTransliterate('漢')).not.toBe('漢');
  });

  it('prints prices with €', () => {
    pdf.options.data.invoice.currency = '€';
    expect(pdf.prettyPrice(14.41)).toBe('14,41 €');
  });
});
