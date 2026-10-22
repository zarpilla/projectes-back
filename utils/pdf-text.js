'use strict';

const fontkit = require('fontkit');
const { transliterate } = require('transliteration');

const fonts = new Map();

const openFont = (fontPath) => {
  if (!fonts.has(fontPath)) fonts.set(fontPath, fontkit.openSync(fontPath));
  return fonts.get(fontPath);
};

/**
 * Text the PDF font can print: every character the font has a glyph for is
 * kept (accents, ’ “ ” – €…), only the others are transliterated one by one.
 * issues/198: the whole string used to be transliterated as soon as one
 * character was above U+0500, so «d’un pla estratègic» lost its accents.
 */
const printableText = (value, fontPath) => {
  if (value === null || value === undefined) return value;
  const font = openFont(fontPath);
  let out = '';
  for (const ch of value.toString()) {
    const cp = ch.codePointAt(0);
    out += cp < 0x20 || font.hasGlyphForCodePoint(cp) ? ch : transliterate(ch);
  }
  return out;
};

/**
 * Whether the font has a glyph for every character of the text: such text keeps
 * its own font (bold included) instead of the fallback, e.g. «TOTAL 363,00 €».
 */
const fontHasAll = (value, fontPath) => {
  if (value === null || value === undefined || !fontPath) return false;
  const font = openFont(fontPath);
  for (const ch of value.toString()) {
    const cp = ch.codePointAt(0);
    if (cp >= 0x20 && !font.hasGlyphForCodePoint(cp)) return false;
  }
  return true;
};

module.exports = { printableText, fontHasAll };
