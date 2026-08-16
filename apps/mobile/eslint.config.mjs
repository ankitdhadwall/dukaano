import library from '@dukaano/config/eslint/library'

/**
 * The mobile app lints as a library, not as a Nest app.
 *
 * `library.mjs` bans framework imports in packages/*; here it is applied for the rules that do
 * carry over — the money bans (no parseFloat, no toFixed, no Intl.NumberFormat outside i18n),
 * empty-catch as an error, and consistent type imports. React Native is not a banned framework in
 * this package, so the import restrictions are relaxed below.
 */
export default [
  ...library,
  {
    rules: {
      // The pure packages may not import a framework. This app is the framework boundary.
      'no-restricted-imports': 'off',
    },
  },
  {
    files: ['test/**/*.ts'],
    rules: { 'no-restricted-syntax': 'off', 'no-console': 'off' },
  },
]
