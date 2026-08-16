import base from './base.mjs'
import tseslint from 'typescript-eslint'

/** Config for apps/api. Decorators require a few relaxations; tenancy rules add a few bans. */
export default tseslint.config(
  ...base,
  {
    rules: {
      // Nest's DI relies on parameter decorators and class properties assigned by the framework.
      '@typescript-eslint/no-extraneous-class': 'off',
      '@typescript-eslint/no-empty-object-type': 'off',

      /**
       * `consistent-type-imports` is OFF for the API, and this is a correctness requirement
       * rather than a style preference.
       *
       * NestJS resolves constructor dependencies from `design:paramtypes`, which TypeScript emits
       * only for imports that survive to runtime. Rewriting `import { PrismaService }` to
       * `import type { PrismaService }` erases that reference, `design:paramtypes` becomes
       * undefined, and Nest throws "Nest can't resolve dependencies" — or worse, injects nothing
       * and fails later.
       *
       * The rule's `--fix` cannot tell a DI token from a plain type, so leaving it enabled means
       * an autofix run can silently break the application. It stays ON for packages/*, which have
       * no decorators and no DI.
       */
      '@typescript-eslint/consistent-type-imports': 'off',

      'no-restricted-imports': [
        'error',
        {
          patterns: [
            {
              group: ['@dukaano/ui-web', '@dukaano/ui-mobile'],
              message: 'The API must not import UI packages (blueprint §29).',
            },
          ],
        },
      ],

      'no-restricted-syntax': [
        'error',
        {
          selector: "CallExpression > MemberExpression[property.name='toFixed']",
          message: 'Money is integer paise — use @dukaano/money (blueprint §15.1).',
        },
        {
          selector:
            "NewExpression[callee.object.name='Intl'][callee.property.name='NumberFormat']",
          message: 'Use formatMoney()/formatQuantity() from @dukaano/i18n (blueprint §22.5).',
        },
        {
          // §23.5: raw SQL is permitted, but only via tagged templates, which Prisma
          // parameterizes. The *Unsafe variants concatenate strings and defeat that protection.
          selector: "CallExpression[callee.property.name=/^\\$(queryRawUnsafe|executeRawUnsafe)$/]",
          message:
            'Unsafe raw SQL is banned. Use the tagged-template forms ($queryRaw / $executeRaw) ' +
            'so Prisma parameterizes the query (blueprint §23.5).',
        },
      ],
    },
  },
  {
    // base.mjs relaxes these for test files, but the block above re-declares
    // `no-restricted-syntax` and therefore re-enables it everywhere. Flat config is
    // last-match-wins, so the relaxation has to be re-applied after it.
    files: ['**/*.spec.ts', '**/*.test.ts', '**/test/**'],
    rules: {
      'no-restricted-syntax': 'off',
      'no-restricted-globals': 'off',
      'no-restricted-properties': 'off',
      'no-console': 'off',
    },
  },
)
