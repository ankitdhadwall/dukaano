import type { NestExpressApplication } from '@nestjs/platform-express'

/**
 * Application configuration shared by production boot and the integration harness.
 *
 * This exists because of a bug worth remembering. The JSON body limit was originally set in
 * `main.ts`, which only runs in production — the tests build the app straight from `AppModule`.
 * The 5,000-row import test then failed with a 500 that had nothing to do with importing, and the
 * production path was the only one actually configured. Anything that changes how requests are
 * handled belongs here, where both paths get it.
 */

/**
 * Express's JSON limit, raised from its 100 kB default for one endpoint: bulk product import.
 *
 * A 5,000-row catalogue with Devanagari names runs to roughly 900 kB of UTF-8. 4 MB leaves
 * headroom without turning the API into an upload target. `MAX_IMPORT_ROWS` and
 * `MAX_IMPORT_CHARS` in @dukaano/validation reject an oversized file with a message that says
 * what is wrong; this limit is the backstop underneath them, and it returns a bare 413.
 */
export const JSON_BODY_LIMIT = '4mb'

/**
 * Both callers must create the app with `{ bodyParser: false }`.
 *
 * Nest registers its own parser during `init()`, before any module middleware, so a limit applied
 * later never sees the raw body — the default parser has already thrown. Disabling it at creation
 * and installing ours here is the only ordering that works.
 */
export function configureBodyParser(app: NestExpressApplication): void {
  app.useBodyParser('json', { limit: JSON_BODY_LIMIT })
  app.useBodyParser('urlencoded', { limit: JSON_BODY_LIMIT, extended: true })
}
