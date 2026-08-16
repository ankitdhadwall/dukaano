import * as SQLite from 'expo-sqlite'
import { configureConnection, migrate } from './schema'
import type { SqliteDatabase } from './sqlite'

/**
 * The `SqliteDatabase` implementation the app actually runs on.
 *
 * The counterpart to `test/node-sqlite.ts`: same interface, same SQL, different binding. Keeping
 * both implementations to four methods is what makes it credible that the tested behaviour and
 * the shipped behaviour are the same behaviour.
 *
 * **Synchronous API on purpose.** expo-sqlite offers both; the sync variants are used because the
 * billing path must be atomic across a dozen statements, and interleaving `await` inside a
 * transaction is how a half-written sale happens — React re-renders, a second tap lands, and the
 * transaction is no longer the only thing touching the database. Each call is sub-millisecond
 * against a local file; the frame budget is not the constraint here, correctness is.
 */

const DATABASE_NAME = 'dukaano.db'

export function openDatabase(name = DATABASE_NAME): SqliteDatabase {
  const db = SQLite.openDatabaseSync(name)

  let depth = 0

  const adapter: SqliteDatabase = {
    exec(sql) {
      db.execSync(sql)
    },

    run(sql, params = []) {
      const result = db.runSync(sql, params as SQLite.SQLiteBindValue[])
      return result.changes
    },

    all(sql, params = []) {
      return db.getAllSync(sql, params as SQLite.SQLiteBindValue[]) as never
    },

    /**
     * Nested transactions become SAVEPOINTs, matching the test adapter exactly.
     *
     * `recordSale` opens a transaction and calls helpers that are also safe standalone. Without
     * nesting support the inner BEGIN throws, and the tempting fix — making those helpers
     * non-transactional — is precisely how the outbox row ends up committed outside the sale's
     * transaction, which is the one failure this whole design exists to prevent.
     */
    transaction(fn) {
      const name = `sp_${depth}`
      if (depth === 0) db.execSync('BEGIN')
      else db.execSync(`SAVEPOINT ${name}`)
      depth++

      try {
        const result = fn()
        depth--
        if (depth === 0) db.execSync('COMMIT')
        else db.execSync(`RELEASE ${name}`)
        return result
      } catch (error) {
        depth--
        if (depth === 0) db.execSync('ROLLBACK')
        else db.execSync(`ROLLBACK TO ${name}`)
        throw error
      }
    },
  }

  configureConnection(adapter)
  migrate(adapter)
  return adapter
}

/**
 * A module-level handle.
 *
 * One connection for the process. Opening a second would give it its own `PRAGMA foreign_keys`
 * setting — SQLite scopes that per connection — and the cascade from `sale` to `sale_item` would
 * work on one and silently not on the other.
 */
let instance: SqliteDatabase | null = null

export function database(): SqliteDatabase {
  instance ??= openDatabase()
  return instance
}
