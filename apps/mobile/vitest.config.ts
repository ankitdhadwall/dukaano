import { defineConfig } from 'vitest/config'

/**
 * The offline engine is tested in **Node**, not in a React Native runtime.
 *
 * Everything under `src/data` and `src/sync` talks to SQLite through the `SqliteDatabase`
 * interface, so it runs unchanged against `node:sqlite` — the same engine the phone uses, reached
 * through a different binding. That is what makes the riskiest layer in the product testable at
 * all: on a device it is nearly impossible to inspect, and mocking it would prove only that the
 * mocks agree with each other.
 *
 * Screens are not covered here. They need a renderer, and they are not where the money is.
 */
export default defineConfig({
  test: {
    include: ['test/**/*.spec.ts'],
    environment: 'node',
    globals: false,
    server: {
      /*
       * `node:sqlite` is new enough that Vite does not yet recognise it as a Node builtin, so it
       * tries to resolve and bundle it and fails with "Failed to load url sqlite". Marking it
       * external hands it back to Node's own loader.
       */
      deps: { external: [/^node:sqlite$/] },
    },
  },
  optimizeDeps: { exclude: ['node:sqlite'] },
})
