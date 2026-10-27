'use strict';

/**
 * CUPS (Código Universal del Punto de Suministro) of the energy community's
 * supply points.
 *
 * Shape: «ES» + 16 digits (4 of the distributor + 12 of the point) + 2 control
 * letters, optionally followed by a border point (a digit and a letter, «0F»).
 * The control letters come from the 16 digits: R = N mod 529, then the letters
 * at R / 23 and R mod 23 of TRWAGMYFPDXBNJZSQVHLCKE.
 *
 * Members send them by hand, so they come with spaces, lower case and an «O»
 * typed for the «0» of «0F». A wrong CUPS is still saved (the board has to
 * chase the member for the right one) and shown with a warning.
 */

const LETTERS = 'TRWAGMYFPDXBNJZSQVHLCKE';
const SHAPE = /^ES(\d{16})([A-Z]{2})(\d[A-Z])?$/;

/** «es 0336 0000 0025 7360 hb» → «ES0336000000257360HB»; «…GWOF» → «…GW0F». */
function normalizeCups(value) {
  let cups = String(value == null ? '' : value)
    .toUpperCase()
    .replace(/[\s.\-_]/g, '');
  // the border point is a digit and a letter: «OF» is a typed «0F»
  if (/^ES\d{16}[A-Z]{2}O[A-Z]$/.test(cups)) cups = `${cups.slice(0, 20)}0${cups.slice(21)}`;
  return cups;
}

/** The two control letters of the 16 digits of a CUPS. */
function controlLetters(digits) {
  const r = Number(BigInt(digits) % 529n);
  return LETTERS[Math.floor(r / 23)] + LETTERS[r % 23];
}

/**
 * Checks a CUPS (normalized first). `reason`: null when valid, else what is
 * wrong, in the app's language.
 */
function checkCups(value) {
  const cups = normalizeCups(value);
  if (!cups) return { cups, valid: false, reason: 'Falta el CUPS' };
  const match = SHAPE.exec(cups);
  if (!match) {
    return {
      cups,
      valid: false,
      reason: 'El CUPS ha de ser ES + 16 xifres + 2 lletres (i opcionalment 1 xifra i 1 lletra)',
    };
  }
  const expected = controlLetters(match[1]);
  if (expected !== match[2]) {
    return { cups, valid: false, reason: `Les lletres de control no quadren (haurien de ser ${expected})` };
  }
  return { cups, valid: true, reason: null };
}

/** The same supply point whatever the border point: «…HB» and «…HB0F». */
const cupsKey = (value) => normalizeCups(value).slice(0, 20);

module.exports = { normalizeCups, checkCups, controlLetters, cupsKey };
