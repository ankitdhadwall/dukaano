import js from '@eslint/js'
import tseslint from 'typescript-eslint'
import prettier from 'eslint-config-prettier'

/**
 * Shared flat ESLint config for every Dukaano workspace package.
 *
 * Beyond the usual hygiene rules, this config mechanically enforces three of the binding
 * DECISIONs from docs/dukaano-blueprint.md. These are not style preferences — each one
 * corresponds to a class of bug that is expensive or impossible to detect later:
 *
 *   §15.1  Money is integer paise and quantity is integer milli-units. Float helpers
 *          (parseFloat, toFixed, Number.parseFloat) silently reintroduce binary floating
 *          point into currency math, so they are banned outside @dukaano/money.
 *   §22.5  No component formats currency itself; Intl.NumberFormat is confined to
 *          @dukaano/i18n so Indian digit grouping is applied in exactly one place.
 *   §24.2  Errors are never swallowed. Empty catch blocks are a lint error.
 */
export default tseslint.config(
  {
    ignores: ['**/dist/**', '**/coverage/**', '**/node_modules/**', '**/.turbo/**', '**/*.js'],
  },
  js.configs.recommended,
  ...tseslint.configs.recommended,
  {
    languageOptions: {
      ecmaVersion: 2022,
      sourceType: 'module',
    },
    rules: {
      // --- Explicit types, no escape hatches (blueprint §46) -------------------
      '@typescript-eslint/no-explicit-any': 'error',
      '@typescript-eslint/no-non-null-assertion': 'error',
      '@typescript-eslint/consistent-type-imports': ['error', { prefer: 'type-imports' }],
      '@typescript-eslint/no-unused-vars': [
        'error',
        { argsIgnorePattern: '^_', varsIgnorePattern: '^_', caughtErrorsIgnorePattern: '^_' },
      ],

      // --- Errors are never swallowed (blueprint §24.2) ------------------------
      'no-empty': ['error', { allowEmptyCatch: false }],
      'no-useless-catch': 'error',
      '@typescript-eslint/no-floating-promises': 'off', // requires type info; enabled per-package

      // --- Money safety (blueprint §15.1) --------------------------------------
      'no-restricted-globals': [
        'error',
        {
          name: 'parseFloat',
          message:
            'Floating point is banned in Dukaano. Money is integer paise and quantity is integer ' +
            'milli-units — use parseMoneyInput()/parseQuantityInput() from @dukaano/money.',
        },
      ],
      'no-restricted-properties': [
        'error',
        {
          object: 'Number',
          property: 'parseFloat',
          message: 'Use parseMoneyInput()/parseQuantityInput() from @dukaano/money (blueprint §15.1).',
        },
      ],
      'no-restricted-syntax': [
        'error',
        {
          selector: "CallExpression > MemberExpression[property.name='toFixed']",
          message:
            'toFixed() implies float money. Use formatMoney()/formatQuantity() from @dukaano/i18n ' +
            'or the integer helpers in @dukaano/money (blueprint §15.1, §22.5).',
        },
        {
          selector: "NewExpression[callee.object.name='Intl'][callee.property.name='NumberFormat']",
          message:
            'Currency and quantity formatting lives in @dukaano/i18n so Indian digit grouping is ' +
            'applied in one place. Import formatMoney()/formatQuantity() (blueprint §22.5).',
        },
      ],

      // --- Magic numbers in domain code (blueprint §46) -------------------------
      eqeqeq: ['error', 'always', { null: 'ignore' }],
      'no-console': ['error', { allow: ['warn', 'error'] }],
      'prefer-const': 'error',
      'no-var': 'error',
    },
  },
  // Tests may reach for the banned helpers when asserting against float behaviour, and may log.
  {
    files: ['**/*.test.ts', '**/*.spec.ts', '**/*.e2e-spec.ts', '**/test/**', '**/testing/**'],
    rules: {
      'no-restricted-syntax': 'off',
      'no-restricted-globals': 'off',
      'no-restricted-properties': 'off',
      'no-console': 'off',
      '@typescript-eslint/no-non-null-assertion': 'off',
    },
  },
  prettier,
)
