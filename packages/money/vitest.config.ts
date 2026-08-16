import { defineConfig } from 'vitest/config'

/**
 * Blueprint §26.1: @dukaano/money carries a **hard 100% coverage gate**.
 *
 * Every rupee and every gram in Dukaano flows through this package, it has no dependencies and
 * no I/O, and it is the one place where a bug is both most likely to be silent and most costly
 * to a shopkeeper. Full coverage is cheap here precisely because the code is pure, so there is
 * no excuse for less.
 */
export default defineConfig({
  test: {
    include: ['src/**/*.test.ts'],
    environment: 'node',
    coverage: {
      provider: 'v8',
      reporter: ['text', 'json-summary', 'lcov'],
      include: ['src/**/*.ts'],
      exclude: ['src/**/*.test.ts'],
      thresholds: {
        lines: 100,
        functions: 100,
        branches: 100,
        statements: 100,
      },
    },
  },
})
