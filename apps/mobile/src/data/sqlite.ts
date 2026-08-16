/**
 * The SQLite seam.
 *
 * Everything in `src/data` and `src/sync` talks to this interface rather than to `expo-sqlite`
 * directly, and that is the single decision that makes the offline engine testable.
 *
 * The offline layer is where this product's real risk lives — an outbox that loses an op, a
 * migration that drops a cart, a flush that double-bills — and it is also the layer that is
 * hardest to exercise on a device. Behind this interface it runs in Node against **real SQLite**
 * (`node:sqlite`), so the tests execute the same SQL the phone will, with the same constraints and
 * the same failure modes. Mocking the database instead would have tested only that the mocks
 * agreed with themselves.
 *
 * The surface is deliberately tiny — four methods — because every method here has to be
 * implemented twice and kept honest twice.
 */

export interface SqlParams {
  readonly [key: string]: string | number | null
}

/** A prepared-statement-shaped, driver-agnostic database handle. */
export interface SqliteDatabase {
  /** Run DDL or a statement with no meaningful result. */
  exec(sql: string): void

  /** Run a parameterized write. Returns the number of rows affected. */
  run(sql: string, params?: readonly (string | number | null)[]): number

  /** Run a parameterized read. */
  all<T = Record<string, unknown>>(sql: string, params?: readonly (string | number | null)[]): T[]

  /**
   * Run `fn` inside a transaction, rolling back if it throws.
   *
   * The outbox depends on this absolutely: §14.3 requires the outbox row to be written in the
   * **same transaction** as the domain rows it describes. There must be no window in which a sale
   * exists on the device but is not queued for the server, because that sale would be invisible
   * forever — present on the phone, absent from the shop's books, and impossible to detect.
   */
  transaction<T>(fn: () => T): T
}

/** SQLite has no boolean; 0/1 with an explicit conversion is clearer than a truthiness check. */
export const toSqlBool = (value: boolean): number => (value ? 1 : 0)
export const fromSqlBool = (value: number | null | undefined): boolean => value === 1

/**
 * Timestamps are stored as **integer epoch milliseconds**, not ISO strings.
 *
 * Comparable and index-friendly in SQLite, which has no date type, and it removes an entire class
 * of bug where two rows written by different code paths sort incorrectly because one carried a
 * timezone suffix and the other did not.
 */
export const toEpoch = (date: Date): number => date.getTime()
export const fromEpoch = (value: number): Date => new Date(value)
