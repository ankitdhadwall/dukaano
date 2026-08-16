import { backoffDelayMs } from '@dukaano/business-logic'
import type { SqliteDatabase } from './sqlite'

/**
 * The outbox (blueprint §14.3).
 *
 * Every mutation a device makes is written here **in the same SQLite transaction as the domain
 * rows it describes**. That is the whole contract, and `enqueue` is deliberately not callable on
 * its own — it takes the database and expects to be inside `db.transaction(...)`, because the
 * failure it prevents is silent and permanent: a sale that exists on the phone, was never queued,
 * and therefore never reaches the shop's books. Nothing would report it. The shopkeeper would find
 * out at month end, if ever.
 *
 * Ops flush in `seq` order and stop at the first hard failure **for that entity chain**, so a
 * payment can never be applied before the sale it references, while unrelated work keeps moving.
 */

export type OutboxOpType = 'create' | 'update' | 'archive'

export interface OutboxOp {
  readonly opId: string
  readonly seq: number
  readonly entity: string
  readonly entityId: string
  readonly opType: OutboxOpType
  readonly baseVersion?: number
  readonly payload: Record<string, unknown>
  readonly attempts: number
  readonly lastError?: string
  readonly nextRetryAt?: number
  readonly createdAt: number
}

export interface EnqueueRequest {
  readonly opId: string
  readonly entity: string
  readonly entityId: string
  readonly opType: OutboxOpType
  readonly baseVersion?: number
  readonly payload: Record<string, unknown>
  readonly now?: number
}

/**
 * Take the next device-local sequence number.
 *
 * A dedicated counter rather than `max(seq) + 1`, because rows leave the outbox once acknowledged.
 * With an empty outbox `max(seq) + 1` restarts at 1, and a new op would sort *ahead* of ops still
 * queued from before — flushing a payment before the sale it belongs to, which the server would
 * reject as a missing reference.
 */
function nextSeq(db: SqliteDatabase): number {
  db.run(
    `INSERT INTO sync_counter (name, value) VALUES ('outbox_seq', 1)
     ON CONFLICT(name) DO UPDATE SET value = value + 1`,
  )
  const [row] = db.all<{ value: number }>(`SELECT value FROM sync_counter WHERE name = 'outbox_seq'`)
  if (!row) throw new Error('outbox sequence counter is missing')
  return row.value
}

/** Queue one operation. **Call inside the transaction that wrote the domain rows.** */
export function enqueue(db: SqliteDatabase, request: EnqueueRequest): OutboxOp {
  const seq = nextSeq(db)
  const createdAt = request.now ?? Date.now()

  db.run(
    `INSERT INTO sync_outbox
       (op_id, seq, entity, entity_id, op_type, base_version, payload, attempts, created_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, 0, ?)`,
    [
      request.opId,
      seq,
      request.entity,
      request.entityId,
      request.opType,
      request.baseVersion ?? null,
      JSON.stringify(request.payload),
      createdAt,
    ],
  )

  return {
    opId: request.opId,
    seq,
    entity: request.entity,
    entityId: request.entityId,
    opType: request.opType,
    baseVersion: request.baseVersion,
    payload: request.payload,
    attempts: 0,
    createdAt,
  }
}

interface OutboxRow {
  op_id: string
  seq: number
  entity: string
  entity_id: string
  op_type: string
  base_version: number | null
  payload: string
  attempts: number
  last_error: string | null
  next_retry_at: number | null
  created_at: number
}

const toOp = (row: OutboxRow): OutboxOp => ({
  opId: row.op_id,
  seq: row.seq,
  entity: row.entity,
  entityId: row.entity_id,
  opType: row.op_type as OutboxOpType,
  baseVersion: row.base_version ?? undefined,
  payload: JSON.parse(row.payload) as Record<string, unknown>,
  attempts: row.attempts,
  lastError: row.last_error ?? undefined,
  nextRetryAt: row.next_retry_at ?? undefined,
  createdAt: row.created_at,
})

/**
 * The next batch to send, in `seq` order, excluding ops still in backoff.
 *
 * Ops whose `next_retry_at` is in the future are skipped rather than blocking the queue behind
 * them — otherwise one permanently-failing op would stop a fortnight of good work from syncing,
 * which is the exact scenario the non-atomic batch design exists to avoid.
 */
export function pending(db: SqliteDatabase, limit = 100, now = Date.now()): OutboxOp[] {
  return db
    .all<OutboxRow>(
      `SELECT * FROM sync_outbox
       WHERE next_retry_at IS NULL OR next_retry_at <= ?
       ORDER BY seq
       LIMIT ?`,
      [now, limit],
    )
    .map(toOp)
}

/** How many operations are waiting. Drives the sync pill — "3 pending" (§14.9). */
export function pendingCount(db: SqliteDatabase): number {
  const [row] = db.all<{ n: number }>('SELECT count(*) AS n FROM sync_outbox')
  return row?.n ?? 0
}

/**
 * Remove an op the server has accounted for.
 *
 * Called for `applied`, `duplicate` **and** `conflict`. A duplicate means the server already had
 * it; a conflict means the server made a decision and recorded it in the conflict inbox. In all
 * three the device has no further work to do, and keeping the row would retry forever.
 */
export function acknowledge(db: SqliteDatabase, opId: string): void {
  db.run('DELETE FROM sync_outbox WHERE op_id = ?', [opId])
}

/**
 * Record a failure and schedule the next attempt.
 *
 * Retryable failures back off on the shared schedule (§14.9) with jitter, so four devices that
 * lost connectivity together do not retry in lockstep forever.
 *
 * A **permanent** rejection — the server refused on a rule that will not change — is dropped from
 * the outbox rather than retried, because retrying cannot help and the queue would never drain.
 * The caller surfaces it in the conflict inbox first; §14.9's "nothing is ever discarded silently"
 * is satisfied by that record, not by keeping a doomed row.
 */
export function fail(
  db: SqliteDatabase,
  opId: string,
  error: string,
  options: { permanent?: boolean; now?: number; jitter?: number } = {},
): void {
  if (options.permanent) {
    db.run('DELETE FROM sync_outbox WHERE op_id = ?', [opId])
    return
  }

  const [row] = db.all<{ attempts: number }>('SELECT attempts FROM sync_outbox WHERE op_id = ?', [
    opId,
  ])
  if (!row) return

  const attempts = row.attempts + 1
  const now = options.now ?? Date.now()
  const base = backoffDelayMs(attempts)
  // Jitter up to ±25%. Injectable so tests are deterministic rather than sometimes-flaky.
  const jitter = options.jitter ?? Math.random() * 0.5 - 0.25
  const delay = Math.max(0, Math.round(base * (1 + jitter)))

  db.run(
    'UPDATE sync_outbox SET attempts = ?, last_error = ?, next_retry_at = ? WHERE op_id = ?',
    [attempts, error.slice(0, 500), now + delay, opId],
  )
}

/**
 * Ops that have failed enough times to be worth telling the shopkeeper about.
 *
 * The sync banner is persistent and never lies (§14.9): once something has failed this many times
 * it is not a blip, and the shopkeeper deserves to know their work is not reaching the shop's
 * books rather than watching a spinner that never resolves.
 */
export const STUCK_AFTER_ATTEMPTS = 5

export function stuck(db: SqliteDatabase): OutboxOp[] {
  return db
    .all<OutboxRow>('SELECT * FROM sync_outbox WHERE attempts >= ? ORDER BY seq', [
      STUCK_AFTER_ATTEMPTS,
    ])
    .map(toOp)
}

/**
 * Entity ids currently blocked by an earlier failing op on the same chain.
 *
 * §14.3: ops flush in `seq` order and stop at the first hard failure *for that entity chain*.
 * Without this, a sale whose op keeps failing would let its payment through, and the server would
 * see a payment referencing a sale it has never heard of.
 */
export function blockedEntityIds(db: SqliteDatabase, now = Date.now()): Set<string> {
  const rows = db.all<{ entity_id: string }>(
    'SELECT DISTINCT entity_id FROM sync_outbox WHERE next_retry_at IS NOT NULL AND next_retry_at > ?',
    [now],
  )
  return new Set(rows.map((row) => row.entity_id))
}
