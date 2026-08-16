/**
 * Sync cursor rules (blueprint §14.5).
 *
 * The cursor is a Postgres **xmin watermark**, not a row id, and the reason is worth restating
 * because the bug it avoids is the kind that reaches production and stays there:
 *
 *   `BIGSERIAL` ids are allocated at INSERT but rows become visible at COMMIT. A transaction that
 *   grabs id 100 can commit *after* one that grabbed id 105. A cursor keyed on id would serve
 *   105, advance past it, and **permanently lose row 100** — a sale that silently never arrives
 *   on a shopkeeper's device, with no error anywhere and nothing to reproduce.
 *
 * The query side of this lives in the API (it needs `pg_snapshot_xmin`). What lives here is
 * everything a client also has to agree about: how a cursor is written down, and when a cursor is
 * too old to be usable.
 */

/**
 * How long `change_log` is kept.
 *
 * A device that has not pulled within this window may have missed changes that were pruned, and
 * must bootstrap instead of asking for a delta. Long enough for a shopkeeper's phone to spend a
 * fortnight in a drawer; short enough that the table does not grow without bound.
 */
export const CHANGE_LOG_RETENTION_DAYS = 30

/**
 * How long `processed_operation` is kept (§14.4 step 5).
 *
 * This is the duplicate-suppression window. Longer than the change-log retention on purpose: a
 * device forced to bootstrap at 30 days may still hold un-pushed ops in its outbox, and those ops
 * must remain replay-safe when they finally arrive. Pruning at the same 30 days would make a
 * long-offline device's queued sales duplicable at exactly the moment they are most likely to be
 * retried.
 */
export const PROCESSED_OPERATION_RETENTION_DAYS = 90

/** Maximum ops the server accepts in one push batch (§14.9). */
export const MAX_PUSH_BATCH_OPS = 100

/** Maximum change rows returned by one pull. */
export const MAX_PULL_LIMIT = 500

/**
 * Client retry schedule in milliseconds (§14.9): 1s → 2s → 5s → 15s → 60s → 5min, then capped.
 *
 * Shared rather than duplicated in the app so the server's rate limits and the client's backoff
 * are designed against the same numbers.
 */
export const SYNC_BACKOFF_MS = [1_000, 2_000, 5_000, 15_000, 60_000, 300_000] as const

/** Every attempt past the end of the schedule waits this long. */
export const SYNC_BACKOFF_CAP_MS = 300_000

/**
 * Delay before attempt number `attempt` (1-based), with jitter applied by the caller.
 *
 * Jitter is not optional in practice: a shop with four devices that all lost connectivity at the
 * same moment will otherwise retry in lockstep forever, and the server sees a thundering herd
 * every five minutes instead of a smooth trickle.
 *
 * `Math.max(…, 0)` guards the negative index that `Array.at` would otherwise read as counting
 * back from the end — attempt 0 would return the five-minute cap instead of one second.
 */
export function backoffDelayMs(attempt: number): number {
  return SYNC_BACKOFF_MS.at(Math.max(attempt - 1, 0)) ?? SYNC_BACKOFF_CAP_MS
}

export type BootstrapReason =
  /** The device has never pulled. First login, or a reinstall. */
  | 'NO_CURSOR'
  /** The device's cursor is older than change-log retention; changes it needs are gone. */
  | 'CURSOR_EXPIRED'

export interface BootstrapDecision {
  readonly required: boolean
  readonly reason?: BootstrapReason
}

/**
 * Must this device bootstrap rather than pull a delta?
 *
 * Time-based rather than comparing the cursor against the oldest surviving `change_log` row, and
 * the two are equivalent because pruning is itself time-based: if the device last pulled inside
 * the retention window, nothing it needs has been pruned. Comparing against `min(txid)` instead
 * would be wrong in the ordinary case — a fully caught-up device's cursor is *ahead* of every
 * surviving row, which is indistinguishable from being hopelessly behind if you only look at the
 * ordering.
 *
 * The boundary is deliberately inclusive: a device at exactly the retention edge bootstraps. A
 * needless bootstrap costs one gzipped download; a missed change costs a sale that never appears.
 */
export function decideBootstrap(input: {
  readonly cursor: string | null | undefined
  readonly lastPulledAt: Date | null | undefined
  readonly now: Date
  readonly retentionDays?: number
}): BootstrapDecision {
  if (!input.cursor || !input.lastPulledAt) return { required: true, reason: 'NO_CURSOR' }

  const retentionDays = input.retentionDays ?? CHANGE_LOG_RETENTION_DAYS
  const ageMs = input.now.getTime() - input.lastPulledAt.getTime()

  if (ageMs >= retentionDays * 24 * 60 * 60 * 1000) {
    return { required: true, reason: 'CURSOR_EXPIRED' }
  }

  return { required: false }
}

const MAX_UINT64 = 18_446_744_073_709_551_615n

/**
 * A cursor's two parts: the xmin watermark, and how far into that watermark's rows we have read.
 *
 * The second half exists because a watermark alone cannot express a **partially read page**. With
 * only an xmin, a pull that hits its row limit has two bad options: advance to the current
 * watermark and skip everything past the page, or leave the cursor where it is and hand the client
 * the same rows forever, never draining the backlog. Both were tried; the second is what the
 * pagination test caught.
 *
 * `changeId` is the `change_log.id` of the last row delivered. Combined with the sort order
 * (`txid, id`), it gives an exact keyset: resume strictly after the last row seen.
 */
export interface SyncCursor {
  readonly txid: bigint
  readonly changeId: bigint
}

/**
 * Parse a cursor.
 *
 * Two accepted forms: `"<txid>"` and `"<txid>:<changeId>"`. The bare form means "start of this
 * watermark" and is what a bootstrap hands out, so it must behave **inclusively** — a transaction
 * sitting exactly at the watermark was still in flight when the watermark was taken and its rows
 * have not been served. `changeId` 0 achieves that: every real `change_log.id` is greater than 0,
 * so `id > 0` admits them all.
 */
export function parseCursor(cursor: string): SyncCursor | null {
  const match = /^(\d{1,20})(?::(\d{1,20}))?$/.exec(cursor)
  // Destructured rather than indexed: the regex guarantees group 1 exists, but
  // `noUncheckedIndexedAccess` cannot see that, and an assertion here would be the one place a
  // malformed cursor could slip through as a runtime cast error.
  const [, rawTxid, rawChangeId] = match ?? []
  if (rawTxid === undefined) return null

  const txid = BigInt(rawTxid)
  const changeId = rawChangeId === undefined ? 0n : BigInt(rawChangeId)
  if (txid > MAX_UINT64 || changeId > MAX_UINT64) return null

  return { txid, changeId }
}

/** Render a cursor for the wire. */
export function formatCursor(cursor: SyncCursor): string {
  return `${cursor.txid}:${cursor.changeId}`
}

/**
 * Is this a well-formed cursor?
 *
 * Validated before it reaches SQL: the pull query casts the cursor to `xid8`, and a malformed
 * value would surface as a Postgres cast error — a 500 for what is really a client sending
 * nonsense. Checking here turns it into a 400 that names the problem.
 *
 * Not a security boundary — the query is parameterized regardless (§23.5) — but a cursor is the
 * one piece of server state a client holds and hands back, so it is worth checking rather than
 * trusting.
 */
export function isValidCursor(cursor: string): boolean {
  return parseCursor(cursor) !== null
}
