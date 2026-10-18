'use strict';

/**
 * issues/136 (2026-10-18): Tresoreria › Moviments bancaris showed the dates as
 * «20-10-2026» (the API's `datex`), while the rest of the app uses dd/mm/aaaa.
 * Guards the display format and that the controller builds `datex` with it.
 */

const fs = require('fs');
const path = require('path');
const { treasuryDisplayDate } = require('../src/api/treasury/services/display-date');

describe('treasuryDisplayDate', () => {
  it('formats a YYYYMMDD date as dd/mm/aaaa', () => {
    expect(treasuryDisplayDate('20261020')).toBe('20/10/2026');
    expect(treasuryDisplayDate('20260305')).toBe('05/03/2026');
  });

  it('is what the treasury controller sends as datex', () => {
    const src = fs.readFileSync(path.join(__dirname, '../src/api/treasury/controllers/treasury.js'), 'utf8');
    expect(src).toMatch(/datex:\s*treasuryDisplayDate\(t\.datef\)/);
    expect(src).not.toMatch(/format\('DD-MM-YYYY'\)/);
  });
});
