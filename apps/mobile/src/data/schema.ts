import type { SqliteDatabase } from './sqlite'

/**
 * The on-device schema (blueprint §14.3).
 *
 * A deliberate **subset** of the server's, not a mirror. A phone needs what it takes to bill
 * without a network: the catalogue, stock levels, customers and their balances, and a queue of
 * what it has done. It does not need audit logs, subscriptions, memberships or the master
 * catalogue, and copying them down would cost bandwidth and battery for data no screen reads.
 *
 * Three conventions run through every table:
 *
 *   • **Money is integer paise and quantity is integer milli-units**, exactly as on the server.
 *     SQLite has no decimal type, so storing rupees as REAL would drift against the server's
 *     BIGINT the first time a bill was split three ways — the phone and the shop's books would
 *     disagree by a paisa and nobody could say which was right.
 *   • **Timestamps are integer epoch milliseconds.** SQLite has no date type either.
 *   • **Ids are client-generated UUIDv7**, so a row created offline keeps its identity through
 *     sync and a create whose response was lost replays as a no-op rather than a second sale.
 */

export const SCHEMA_VERSION = 1

/**
 * Migrations, applied in order and recorded.
 *
 * An array rather than a single schema string because a shopkeeper's phone will be several
 * versions behind on the day they finally reopen the app, and it has to walk forward through
 * every step. `user_version` is SQLite's own counter, so the record survives anything short of
 * deleting the file.
 */
const MIGRATIONS: readonly { version: number; sql: string }[] = [
  {
    version: 1,
    sql: `
      -- ── Catalogue ────────────────────────────────────────────────────────────────────────
      CREATE TABLE product (
        id                        TEXT PRIMARY KEY,
        name_en                   TEXT,
        name_hi                   TEXT,
        sku                       TEXT,
        short_code                TEXT,
        category_id               TEXT,
        unit_code                 TEXT NOT NULL,
        selling_price_paise       INTEGER NOT NULL,
        purchase_price_paise      INTEGER,
        mrp_paise                 INTEGER,
        low_stock_threshold_milli INTEGER NOT NULL DEFAULT 0,
        is_active                 INTEGER NOT NULL DEFAULT 1,
        archived_at               INTEGER,
        -- The server's version of this row, so a local edit can declare what it was made against
        -- and the field-aware conflict rule can do its work (§14.7).
        server_row_version        INTEGER NOT NULL DEFAULT 0,
        client_updated_at         INTEGER,
        sync_state                TEXT NOT NULL DEFAULT 'synced',
        -- Denormalized lowercase haystack: name_en + name_hi + sku + short_code + aliases.
        -- Rebuilt on every write so search is one indexed LIKE rather than a join per keystroke.
        search_text               TEXT NOT NULL DEFAULT ''
      );
      CREATE INDEX product_search    ON product (search_text);
      CREATE INDEX product_active    ON product (is_active, archived_at);

      CREATE TABLE product_alias (
        product_id TEXT NOT NULL,
        alias      TEXT NOT NULL,
        PRIMARY KEY (product_id, alias)
      );

      CREATE TABLE category (
        id         TEXT PRIMARY KEY,
        name_en    TEXT,
        name_hi    TEXT,
        sort_order INTEGER NOT NULL DEFAULT 0
      );

      -- ── Stock ────────────────────────────────────────────────────────────────────────────
      -- Pull-only derived state (§14.7). The device NEVER pushes a balance; it reports movements
      -- and the server recomputes. A phone that could push a balance would let two devices
      -- overwrite each other's arithmetic with no way to tell which was right.
      CREATE TABLE inventory_balance (
        product_id     TEXT PRIMARY KEY,
        qty_milli      INTEGER NOT NULL DEFAULT 0,
        avg_cost_paise INTEGER NOT NULL DEFAULT 0
      );

      -- ── Customers ────────────────────────────────────────────────────────────────────────
      CREATE TABLE customer (
        id                 TEXT PRIMARY KEY,
        name               TEXT NOT NULL,
        phone_e164         TEXT,
        credit_limit_paise INTEGER,
        archived_at        INTEGER,
        server_row_version INTEGER NOT NULL DEFAULT 0,
        client_updated_at  INTEGER,
        sync_state         TEXT NOT NULL DEFAULT 'synced',
        search_text        TEXT NOT NULL DEFAULT ''
      );
      CREATE INDEX customer_search ON customer (search_text);

      -- Pull-only, like inventory_balance.
      CREATE TABLE customer_balance (
        customer_id       TEXT PRIMARY KEY,
        outstanding_paise INTEGER NOT NULL DEFAULT 0,
        last_activity_at  INTEGER
      );

      -- ── Sales ────────────────────────────────────────────────────────────────────────────
      CREATE TABLE sale (
        id                        TEXT PRIMARY KEY,
        sale_number               TEXT NOT NULL,
        customer_id               TEXT,
        status                    TEXT NOT NULL DEFAULT 'COMPLETED',
        subtotal_paise            INTEGER NOT NULL,
        line_discount_paise       INTEGER NOT NULL DEFAULT 0,
        bill_discount_paise       INTEGER NOT NULL DEFAULT 0,
        rounding_adjustment_paise INTEGER NOT NULL DEFAULT 0,
        total_paise               INTEGER NOT NULL,
        paid_paise                INTEGER NOT NULL DEFAULT 0,
        credit_paise              INTEGER NOT NULL DEFAULT 0,
        business_date             TEXT NOT NULL,
        occurred_at               INTEGER NOT NULL,
        sync_state                TEXT NOT NULL DEFAULT 'local',
        -- The same identity the server enforces (§19.1). Enforced here too, because a bill that
        -- does not reconcile must never leave the device: it would be rejected on arrival and the
        -- shopkeeper would have handed over goods against a bill that never existed.
        CHECK (paid_paise + credit_paise = total_paise),
        CHECK (credit_paise = 0 OR customer_id IS NOT NULL)
      );
      CREATE INDEX sale_recent ON sale (occurred_at DESC);

      CREATE TABLE sale_item (
        id                    TEXT PRIMARY KEY,
        sale_id               TEXT NOT NULL REFERENCES sale(id) ON DELETE CASCADE,
        product_id            TEXT NOT NULL,
        product_name_snapshot TEXT NOT NULL,
        unit_snapshot         TEXT NOT NULL,
        qty_milli             INTEGER NOT NULL,
        unit_price_paise      INTEGER NOT NULL,
        discount_paise        INTEGER NOT NULL DEFAULT 0,
        line_total_paise      INTEGER NOT NULL,
        sort_order            INTEGER NOT NULL DEFAULT 0
      );
      CREATE INDEX sale_item_sale ON sale_item (sale_id);

      CREATE TABLE payment (
        id           TEXT PRIMARY KEY,
        sale_id      TEXT,
        customer_id  TEXT,
        direction    TEXT NOT NULL DEFAULT 'IN',
        method       TEXT NOT NULL,
        amount_paise INTEGER NOT NULL,
        reference    TEXT,
        occurred_at  INTEGER NOT NULL,
        sync_state   TEXT NOT NULL DEFAULT 'local',
        -- 'UDHAAR' is not a method here either (§19.1). The rule has to hold on both sides of the
        -- wire, or the phone's own "today's takings" would count credit as money taken.
        CHECK (method IN ('CASH','UPI','CARD','BANK_TRANSFER','OTHER'))
      );
      CREATE INDEX payment_recent ON payment (occurred_at DESC);

      -- ── The outbox (§14.3) ───────────────────────────────────────────────────────────────
      CREATE TABLE sync_outbox (
        op_id         TEXT PRIMARY KEY,
        seq           INTEGER NOT NULL,
        entity        TEXT NOT NULL,
        entity_id     TEXT NOT NULL,
        op_type       TEXT NOT NULL,
        base_version  INTEGER,
        payload       TEXT NOT NULL,
        attempts      INTEGER NOT NULL DEFAULT 0,
        last_error    TEXT,
        next_retry_at INTEGER,
        created_at    INTEGER NOT NULL
      );
      -- Flushed in seq order, so a payment can never be applied before the sale it references.
      CREATE INDEX outbox_flush ON sync_outbox (seq);

      -- Device-local monotonic counter for 'seq'. A separate table rather than max(seq)+1 because
      -- rows leave the outbox once acknowledged, and reusing a sequence number would reorder a
      -- later op behind an earlier one.
      CREATE TABLE sync_counter (
        name  TEXT PRIMARY KEY,
        value INTEGER NOT NULL
      );

      -- ── Device state ─────────────────────────────────────────────────────────────────────
      CREATE TABLE sync_state (
        key   TEXT PRIMARY KEY,
        value TEXT
      );

      -- Invoice numbers leased from the server, drawn down offline (§14.6).
      CREATE TABLE number_lease (
        series     TEXT PRIMARY KEY,
        range_from INTEGER NOT NULL,
        range_to   INTEGER NOT NULL,
        next_value INTEGER NOT NULL
      );
    `,
  },
]

/**
 * Bring the database to the current schema version.
 *
 * Each migration runs inside its own transaction, so a failure part-way leaves `user_version` at
 * the last version that fully applied and the next launch retries from there. A half-applied
 * migration that reported success would be far worse than a failed one: the app would run against
 * a schema nobody has ever seen.
 */
export function migrate(db: SqliteDatabase): number {
  const [row] = db.all<{ user_version: number }>('PRAGMA user_version')
  let current = row?.user_version ?? 0

  for (const migration of MIGRATIONS) {
    if (migration.version <= current) continue

    db.transaction(() => {
      db.exec(migration.sql)
      // PRAGMA does not accept a bound parameter; the value is a literal from this file, never
      // from input.
      db.exec(`PRAGMA user_version = ${migration.version}`)
    })
    current = migration.version
  }

  return current
}

/**
 * Prepare a fresh connection.
 *
 * `foreign_keys` is OFF by default in SQLite — every connection, every time — so the cascade from
 * `sale` to `sale_item` would silently not happen. WAL is what keeps a read during a flush from
 * blocking the till.
 */
export function configureConnection(db: SqliteDatabase): void {
  db.exec('PRAGMA journal_mode = WAL')
  db.exec('PRAGMA foreign_keys = ON')
  // NORMAL rather than FULL: a phone losing power mid-write is the case this protects, and in WAL
  // mode NORMAL still cannot corrupt the database — it can only lose the last transaction, which
  // for a till means re-entering the bill currently on screen.
  db.exec('PRAGMA synchronous = NORMAL')
}

/** Build the denormalized search haystack. One place, so search behaves identically everywhere. */
export function buildSearchText(parts: readonly (string | null | undefined)[]): string {
  return parts
    .filter((part): part is string => Boolean(part && part.trim()))
    .map((part) => part.trim().toLowerCase())
    .join(' ')
}
