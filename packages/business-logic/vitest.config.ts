import { defineConfig } from 'vitest/config'

/**
 * Blueprint §26.1: @dukaano/business-logic carries the same hard 100% gate as @dukaano/money.
 * It is pure and I/O-free, so full coverage is cheap, and it holds the rules — RBAC, ledger,
 * costing, conflict resolution — where a silent bug is most expensive.
 */
export default defineConfig({
  test: {
    include: ['src/**/*.test.ts'],
    environment: 'node',
    coverage: {
      provider: 'v8',
      reporter: ['text', 'json-summary', 'lcov'],
      include: ['src/**/*.ts'],
      exclude: ['src/**/*.test.ts', 'src/index.ts'],
      thresholds: { lines: 100, functions: 100, branches: 100, statements: 100 },
    },
  },
})
