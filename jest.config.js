// Jest config. Pure-function tests (financial engine, query-param adapter, etc.)
// run without booting Strapi. Integration tests that need Strapi use a separate
// setup (see tests/integration/README.md).
module.exports = {
  testEnvironment: 'node',
  testMatch: ['<rootDir>/tests/**/*.test.js'],
  // UTC like the containers (issues/346)
  globalSetup: '<rootDir>/tests/global-setup-tz.js',
  // utils/ holds the invoice and delivery-note PDF builders.
  collectCoverageFrom: ['src/**/*.js', 'utils/**/*.js', '!src/admin/**', '!**/node_modules/**'],
  coverageDirectory: 'coverage',
  // A floor, not a goal: just under what the suite covered on 2026-10-12, so
  // coverage can't drop unnoticed (`npm run test:cov`, which CI runs). Raise it
  // as tests are added.
  coverageThreshold: {
    global: { statements: 30, branches: 27, functions: 29, lines: 29 },
  },
  // Resolve Strapi alias '@' -> src/ in tests.
  moduleNameMapper: {
    '^@/(.*)$': '<rootDir>/src/$1',
  },
};
