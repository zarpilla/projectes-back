'use strict';

/**
 * Comunitat energètica: the CUPS of the members' supply points. The control
 * letters were checked against the 43 well-formed CUPS of the community's
 * spreadsheet (2026-10-25); the sample ones below are made up.
 */
const { normalizeCups, checkCups, controlLetters, cupsKey } = require('../src/services/energy-cups');

// made-up but consistent: 0000000000000001 mod 529 = 1 → «TR»
const GOOD = 'ES0000000000000001TR';

describe('energy CUPS', () => {
  test('control letters come from the 16 digits mod 529', () => {
    expect(controlLetters('0000000000000001')).toBe('TR');
    expect(controlLetters('0000000000000000')).toBe('TT');
    // 528 = 22 * 23 + 22 → «EE»
    expect(controlLetters('0000000000000528')).toBe('EE');
  });

  test('normalizes spaces, case and a typed «O» in the border point', () => {
    expect(normalizeCups(' es 0000 0000 0000 0001 tr ')).toBe(GOOD);
    expect(normalizeCups(`${GOOD}OF`)).toBe(`${GOOD}0F`);
    expect(normalizeCups(null)).toBe('');
  });

  test('accepts a valid CUPS with or without border point', () => {
    expect(checkCups(GOOD)).toEqual({ cups: GOOD, valid: true, reason: null });
    expect(checkCups(`${GOOD}0F`).valid).toBe(true);
    expect(checkCups(`${GOOD}OF`)).toMatchObject({ cups: `${GOOD}0F`, valid: true });
  });

  test('flags wrong control letters, with the expected ones', () => {
    const check = checkCups('ES0000000000000001TT0F');
    expect(check.valid).toBe(false);
    expect(check.reason).toContain('TR');
  });

  test('flags a malformed or missing CUPS', () => {
    expect(checkCups('ES023001029837417MJ').valid).toBe(false); // a digit short
    expect(checkCups('Nom titular (Anna)').valid).toBe(false);
    expect(checkCups('').reason).toBe('Falta el CUPS');
  });

  test('the same point whatever the border point', () => {
    expect(cupsKey(`${GOOD}0F`)).toBe(cupsKey(GOOD));
  });
});
