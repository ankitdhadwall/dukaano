import { defineConfig } from 'vitest/config'
import swc from 'unplugin-swc'

/**
 * NestJS relies on `emitDecoratorMetadata` for dependency injection, which esbuild (Vite's
 * default transformer) does not emit. SWC does, so the API's tests are transformed with it.
 */
export default defineConfig({
  test: {
    include: ['test/**/*.spec.ts', 'src/**/*.spec.ts'],
    environment: 'node',
    globals: false,
    // Integration tests share one Postgres database, so they must not race each other.
    fileParallelism: false,
    testTimeout: 30_000,
    hookTimeout: 120_000,
  },
  plugins: [swc.vite({ module: { type: 'es6' } })],
})
