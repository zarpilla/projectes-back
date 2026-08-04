// Jest config. Pure-function tests (financial engine, query-param adapter, etc.)
// run without booting Strapi. Integration tests that need Strapi use a separate
// setup (see tests/integration/README.md).
module.exports = {
  testEnvironment: 'node',
  testMatch: ['<rootDir>/tests/**/*.test.js'],
  collectCoverageFrom: ['src/**/*.js', '!src/admin/**', '!**/node_modules/**'],
  coverageDirectory: 'coverage',
  // Quiet coverage thresholds during the migration; tighten at M3 (logic parity).
  coverageThreshold: undefined,
  // Resolve Strapi alias '@' -> src/ in tests.
  moduleNameMapper: {
    '^@/(.*)$': '<rootDir>/src/$1',
  },
};
