# ADR-0007 — The sync cursor is a composite `(txid, changeId)`, not an xmin watermark alone

**Status:** Accepted · **Date:** 2026-08-16 · **Refines:** Blueprint §14.5

## Context

Blueprint §14.5 specifies the delta-pull query, and its central insight is correct and load-bearing:

```sql
SELECT * FROM change_log
WHERE shop_id = $1
  AND txid >= $cursor_xmin
  AND txid <  pg_snapshot_xmin(pg_current_snapshot())
ORDER BY txid, id
LIMIT $n;
```

> "The next cursor is the new `pg_snapshot_xmin`."

The `txid <` condition is what prevents the lost-change bug — `BIGSERIAL` ids are allocated at
INSERT but rows become visible at COMMIT, so a cursor keyed on `id` can serve a higher id, advance
past it, and permanently lose a lower one. That reasoning is unchanged and the test that proves it
is the most important in the suite.

The gap is what happens when `LIMIT $n` truncates a page. A device returning from two weeks offline
has more changes waiting than one page holds, and "the next cursor is the new
`pg_snapshot_xmin`" then has two readings, both wrong:

- **Advance to the watermark anyway.** Everything past the page is skipped. This is the lost-change
  bug reintroduced through the front door — worse, because it triggers precisely for the devices
  that have been away longest and have most to receive.
- **Leave the cursor unchanged until the window drains.** This is what the first implementation
  did. The client then receives the *same page* on every pull, forever. A device with a backlog
  larger than one page can never catch up, and the sync banner sits at "saving…" indefinitely while
  making no progress.

The second was caught by a test that drained a backlog page by page and asserted every row arrived.
It would not have been caught by any single-pull test, and in production it would have presented as
"sync is stuck" on exactly the devices whose owners were already unhappy.

## Decision

The cursor is `"<txid>:<changeId>"`, and the predicate becomes a **keyset matching the sort order**:

```sql
WHERE shop_id = $1
  AND txid <  pg_snapshot_xmin(pg_current_snapshot())
  AND (txid > $cursorTxid OR (txid = $cursorTxid AND id > $cursorChangeId))
ORDER BY txid, id
LIMIT $n + 1
```

- **Mid-window** (page truncated): the next cursor is the last row delivered, so the following pull
  resumes strictly after it.
- **Drained**: the next cursor is the current `pg_snapshot_xmin` with `changeId` 0.

`changeId` 0 is what preserves the blueprint's inclusive lower bound. Every real `change_log.id` is
greater than 0, so `id > 0` admits every row at that txid — which is required, because a
transaction sitting exactly at the watermark was still in flight when the watermark was taken and
its rows have never been served.

The bare form `"<txid>"` is still accepted and parses to `changeId` 0, so a cursor issued by an
older build keeps working.

## Consequences

**Good.** A backlog of any size drains in bounded pages, and every change arrives exactly once per
page rather than being re-served. The lost-change property is untouched — `txid <
pg_snapshot_xmin` is still what provides it, and its test still passes.

**Good.** The keyset is exact rather than approximate, so the overlap the blueprint accepted at the
lower edge (`txid >=`) mostly disappears in steady state. The client's apply is still an idempotent
upsert, so this is an efficiency gain rather than a correctness one.

**Good.** The composite is served by the existing `(shop_id, txid, id)` index with no new index and
no plan change.

**Bad.** The cursor is now an opaque string with internal structure rather than a number, so it
cannot be compared with `>` on the client. Anything reasoning about cursor ordering must parse it —
`parseCursor` is exported from `@dukaano/business-logic` for exactly that, but it is a sharp edge
that a plain integer did not have. One test asserted `BigInt(cursor)` and had to be changed.

**Bad.** It departs from a blueprint section that is quoted in the schema comments and the sync
module. Those comments now describe a query that is not quite the one being run, which is why this
ADR exists and is linked from both.

**Bad.** `lastPulledAt` now advances on every page rather than only on a completed drain. That is
deliberate — a device steadily working through a backlog is plainly not stale, and letting the
timestamp go cold mid-drain would eventually force it into a bootstrap it does not need — but it
means the field means "last made progress", not "last fully caught up".

## Alternatives rejected

**Keep the watermark and never truncate a page.** Removing `LIMIT` entirely makes the blueprint's
cursor correct. Rejected: a device returning after two weeks would receive its entire backlog in
one response, on a 3G connection, with no way to make partial progress if it dropped. The limit is
what makes sync resumable.

**A separate "resume offset" alongside the cursor.** Same information, two fields to keep in sync,
and a client that persisted one but not the other would silently skip or repeat. One opaque token
that is always used whole has fewer ways to be half-applied.
