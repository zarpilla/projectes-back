// ESLint flat config (ESLint v9+), CommonJS — matches the rest of this project.
// Kept permissive: the migration ports untyped v3 business logic, so we lint for
// real bugs (no-undef, no-unused-vars) rather than style. Style is Prettier's job.
const js = require('@eslint/js');
const prettier = require('eslint-config-prettier');
const globals = require('globals');

module.exports = [
  js.configs.recommended,
  prettier, // must be last — turns off conflicting style rules
  {
    languageOptions: {
      ecmaVersion: 2021,
      sourceType: 'commonjs',
      globals: {
        ...globals.node,
        ...globals.jest,
      },
    },
    rules: {
      // Strapi controllers/services use a lot of optional chaining and async;
      // keep these lenient during the migration.
      'no-unused-vars': ['warn', { argsIgnorePattern: '^_', varsIgnorePattern: '^_' }],
      'no-console': 'off',
      'no-empty': ['error', { allowEmptyCatch: true }],
    },
  },
  {
    ignores: [
      'node_modules/**',
      'dist/**',
      'build/**',
      '.tmp/**',
      'coverage/**',
      'src/admin/**',
      '.strapi/**',
      'database/migrations/**',
      'utils/**', // vendored PDF utilities (microinvoice) — copied verbatim from v3
    ],
  },
];
