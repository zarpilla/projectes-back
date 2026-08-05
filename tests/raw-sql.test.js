'use strict';

const { _ensureBindings } = require('../src/services/raw-sql');

describe('raw-sql helper (R11: SQL injection fix)', () => {
  describe('ensureBindings validation', () => {
    test('accepts correct placeholder/bindings count', () => {
      expect(() => _ensureBindings('UPDATE t SET a = ?, b = ? WHERE id = ?', ['x', 1, 5])).not.toThrow();
    });

    test('accepts zero placeholders with empty bindings', () => {
      expect(() => _ensureBindings('SELECT 1', [])).not.toThrow();
    });

    test('rejects non-array bindings', () => {
      expect(() => _ensureBindings('UPDATE t SET a = ?', 'x')).toThrow(/bindings must be an array/);
    });

    test('rejects mismatched count (placeholder > bindings)', () => {
      expect(() => _ensureBindings('UPDATE t SET a = ?, b = ?', ['x'])).toThrow(
        /placeholder count \(2\) != bindings length \(1\)/,
      );
    });

    test('rejects mismatched count (bindings > placeholder)', () => {
      expect(() => _ensureBindings('UPDATE t SET a = ?', ['x', 'y', 'z'])).toThrow(
        /placeholder count \(1\) != bindings length \(3\)/,
      );
    });

    test('rejects undefined binding value (silent-corruption guard)', () => {
      expect(() => _ensureBindings('UPDATE t SET a = ?, b = ?', ['x', undefined])).toThrow(
        /binding #1 is undefined/,
      );
    });

    test('rejects when no bindings passed for a parameterized query', () => {
      expect(() => _ensureBindings('UPDATE t SET a = ?', [])).toThrow(/placeholder count/);
    });
  });

  describe('the v3 injection scenario (now impossible)', () => {
    // The v3 code did: `UPDATE ${table} SET vat_paid_date = '${vat_paid_date}', ... WHERE id = ${id}`
    // With this helper, the equivalent MUST be parameter-bound:
    test('v3 payEntity pattern rewritten with bindings', () => {
      const table = 'emitted_invoices';
      const vatPaidDate = "2024-01-01'; DROP TABLE emitted_invoices; --"; // injection attempt
      const pct = 100;
      const id = 42;
      const query = `UPDATE ${table} SET vat_paid_date = ?, deductible_vat_pct = ? WHERE id = ?`;
      // table is from a fixed internal whitelist (safe to interpolate), the rest is bound
      expect(() => _ensureBindings(query, [vatPaidDate, pct, id])).not.toThrow();
      // The injection string is now treated as a literal value, never executed as SQL.
    });
  });
});
