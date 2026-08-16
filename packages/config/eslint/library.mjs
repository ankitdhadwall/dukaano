import base from './base.mjs'
import tseslint from 'typescript-eslint'

/**
 * Config for pure domain packages (@dukaano/money, @dukaano/business-logic).
 *
 * Enforces the monorepo boundary rules from blueprint §29: these packages must stay pure —
 * no I/O, no framework imports, no reaching into apps. That purity is what makes 100% test
 * coverage cheap and what lets the React Native client run byte-identical money and ledger
 * math to the server.
 */
export default tseslint.config(...base, {
  rules: {
    'no-restricted-imports': [
      'error',
      {
        patterns: [
          {
            group: ['@dukaano/api', '@dukaano/web', '@dukaano/admin', '@dukaano/mobile', '**/apps/**'],
            message: 'packages/* must never import from apps/* (blueprint §29 boundary rules).',
          },
          {
            group: ['@nestjs/*', 'next', 'next/*', 'react', 'react-native', 'expo*', '@prisma/*'],
            message:
              'Domain packages must stay framework-free and I/O-free so both the server and the ' +
              'React Native client can run identical logic (blueprint §29).',
          },
          {
            group: ['fs', 'node:fs', 'path', 'node:path', 'http', 'node:http', 'crypto', 'node:crypto'],
            message:
              'Domain packages must be pure — no I/O. Move this into apps/api or a package that ' +
              'explicitly owns side effects (blueprint §29).',
          },
        ],
      },
    ],
  },
})
