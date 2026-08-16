import { createRequire } from 'node:module'
import { configureConnection, migrate } from '../src/data/schema'
import type { SqliteDatabase } from '../src/data/sqlite'

/*
 * `node:sqlite` is loaded through `createRequire` rather than imported.
 *
 * Vite does not yet recognise it as a Node builtin — it is new — so a static import is rewritten
 * to `sqlite`, which resolves to nothing. Going through require keeps it out of Vite's static
 * analysis entirely and hands the module to Node's own loader.
 */
const nodeRequire = createRequire(import.meta.url)
const { DatabaseSync } = nodeRequire('node:sqlite') as typeof import('node:sqlite')
/**
 * The `SqliteDatabase` implementation used by tests.
 *
 * `node:sqlite` is the real SQLite engine shipped with Node 22 — the same library the phone runs,
 * reached through a different binding. So these tests execute the actual SQL, against the actual
 * schema, with real CHECK constraints, real foreign keys and real transaction semantics.
 *
 * That matters more here than anywhere else in the codebase. The offline layer is where a bug
 * costs a shopkeeper a sale they can never recover, and it is the layer a device makes hardest to
 * inspect. A mocked database would have proved only that the mocks agreed with each other.
 */
export function createTestDatabase(): SqliteDatabase & { close(): void } {
  const db = new DatabaseSync(':memory:')

  let depth = 0

  const adapter: SqliteDatabase & { close(): void } = {
    exec(sql) {
      db.exec(sql)
    },

    run(sql, params = []) {
      const statement = db.prepare(sql)
      const result = statement.run(...(params as never[]))
      return Number(result.changes)
    },

    all(sql, params = []) {
      const statement = db.prepare(sql)
      return statement.all(...(params as never[])) as never
    },

    /**
     * Nested transactions use SAVEPOINTs.
     *
     * `recordSale` opens a transaction and calls `drawInvoiceNumber` and `enqueue` inside it, both
     * of which are also safe to call standalone. Without savepoint nesting the inner BEGIN would
     * throw, and the temptation would be to make the inner calls non-transactional — which is
     * exactly how the outbox row ends up outside the sale's transaction.
     */
    transaction(fn) {
      const name = `sp_${depth}`
      if (depth === 0) db.exec('BEGIN')
      else db.exec(`SAVEPOINT ${name}`)
      depth++

      try {
        const result = fn()
        depth--
        if (depth === 0) db.exec('COMMIT')
        else db.exec(`RELEASE ${name}`)
        return result
      } catch (error) {
        depth--
        if (depth === 0) db.exec('ROLLBACK')
        else db.exec(`ROLLBACK TO ${name}`)
        throw error
      }
    },

    close() {
      db.close()
    },
  }

  configureConnection(adapter)
  migrate(adapter)
  return adapter
}

/** A deterministic id generator, so assertions can name the ids they expect. */
export function sequentialIds(prefix = 'id'): () => string {
  let n = 0
  return () => `${prefix}-${String(++n).padStart(4, '0')}`
}

/** Seed a product with the columns the sale path reads. */
export function seedProduct(
  db: SqliteDatabase,
  product: {
    id: string
    nameEn?: string
    nameHi?: string
    unitCode?: string
    sellingPricePaise?: number
    qtyMilli?: number
  },
): void {
  db.run(
    `INSERT INTO product (id, name_en, name_hi, unit_code, selling_price_paise, search_text)
     VALUES (?, ?, ?, ?, ?, ?)`,
    [
      product.id,
      product.nameEn ?? null,
      product.nameHi ?? null,
      product.unitCode ?? 'KG',
      product.sellingPricePaise ?? 4_450,
      [product.nameEn, product.nameHi].filter(Boolean).join(' ').toLowerCase(),
    ],
  )
  db.run('INSERT INTO inventory_balance (product_id, qty_milli) VALUES (?, ?)', [
    product.id,
    product.qtyMilli ?? 50_000,
  ])
}

/** Give the device a block of invoice numbers, as a real lease request would. */
export function seedLease(db: SqliteDatabase, from = 1, to = 200, series = 'INV'): void {
  db.run(
    'INSERT INTO number_lease (series, range_from, range_to, next_value) VALUES (?, ?, ?, ?)',
    [series, from, to, from],
  )
}
