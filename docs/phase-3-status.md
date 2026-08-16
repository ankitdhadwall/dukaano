# Phase 3 — Sync engine · **Complete**

Last updated: 2026-08-16 · Blueprint: [dukaano-blueprint.md](dukaano-blueprint.md) §14, §28

## Acceptance criteria — 4 of 4 met

| # | Criterion (blueprint §28) | Status |
|---|---|---|
| 1 | The lost-change test passes (§14.5) | ✅ Reproduced with a genuinely held-open transaction |
| 2 | A duplicate `op_id` is a no-op | ✅ Single ops, whole batches, and replayed entity ids |
| 3 | A 45-day-stale device is forced to bootstrap | ✅ Plus the never-pulled and revoked cases |
| 4 | 500 queued ops sync correctly | ✅ **1.8 s** across five batches of 100 |

**773 tests across 6 packages.** Lint, typecheck and build clean. `@dukaano/money` and
`@dukaano/business-logic` hold at **100% branch coverage**.

Scope is per §28: the engine is exercised **end-to-end on products only**. Idempotency, the cursor,
conflict policy and authorization are entity-agnostic, so Phase 4 registers sales and payments
against the same push loop rather than writing a second one.

## The lost-change test

This is the criterion worth describing, because it is the one that cannot be verified by reading
code. `change_log.id` is `BIGSERIAL` — allocated at INSERT, visible at COMMIT — so a transaction
holding id 100 can commit *after* one holding id 105. A cursor keyed on `id` serves 105, advances
past it, and loses 100 permanently. The sale never appears on the device, nothing errors, and
nothing is reproducible afterwards.

The test spawns a real second connection that inserts and then sleeps inside an open transaction,
inserts and commits a *higher* id from a third connection, and pulls while the first is still in
flight. It asserts the cursor serves **neither** row — then commits the slow transaction and
asserts both arrive on the very next pull, using the cursor the device was actually given.

## Built

**Change log** — every tenant write appends in the same transaction as the write. `txid` comes from
the column default `pg_current_xact_id()`, never from application code. Bulk paths log in one
`unnest` statement, so 5,000 imported products cost one round trip.

**Push** — per-op transactions, deliberately not one per batch. A batch holds a fortnight of
unrelated work; one poisonous op must not roll back the other 499 and leave the client retrying
forever with no way to identify the culprit. The route carries `@SkipTenant()` for exactly this
reason, which is the only place in the codebase that opts out of the request-scoped transaction.

Idempotency is a claim on `op_id` taken **before** the work, in its own transaction, so a
deterministic rejection is remembered and a replay returns the identical stored result. A claim
left `in_progress` by a killed process is taken over rather than treated as a duplicate — the
alternative loses the op permanently.

**Pull** — an xmin watermark, extended to a composite keyset
([ADR-0007](architecture/adr-0007-composite-sync-cursor.md)).

**Bootstrap** — the cursor is read **before** the data, not after. Reading it after would open a
window in which a change committed between the snapshot and the cursor read, and the device would
advance past a change it never received.

**Conflict policy** — field-aware last-write-wins. Prices are server-wins unless the client's edit
is strictly newer *and* was made against the current `rowVersion`; everything else is plain LWW
with ties going to the server. Resolution is **per field**, so a patch carrying a rename and a
stale price keeps the rename and refuses the price — all-or-nothing would either lose the rename or
reprice the shelf from a phone that has been in a drawer.

**The E-31 asymmetry** — a queued *sale* from a since-demoted cashier applies; a queued *edit* or
cancellation does not. The goods left the shop and the money entered the till, so refusing the
record does not undo either — it only means the books stop describing reality. Accepting an edit,
by contrast, is exactly the abuse the demotion was meant to stop.

**Number leases**, **device registry** with clock-skew recording (E-26), **conflict inbox**, and a
**nightly retention job** pruning `change_log` at 30 days and `processed_operation` at 90.

## Verified behaviour

A duplicate `op_id` returns the stored original result, not a re-derived one · a create replayed
under a new op id but the same client-generated entity id makes one product, not two · a batch that
repeats an op id within itself is **rejected**, not deduplicated, because colliding keys mean the
client's outbox is broken and the whole defence rests on those keys · 500 ops across five batches
apply in 1.8 s and replay as duplicates · one invalid op leaves its neighbours applied · a stale
price is refused while the rename in the same patch lands · a client attempt to set `archivedAt` is
refused as server-authoritative · every refusal appears in the conflict inbox with both payloads ·
acknowledging is idempotent · concurrent lease requests never produce overlapping ranges · a
revoked device cannot pull and cannot re-register itself · a three-day clock skew is recorded and
the op still applies.

## Bugs found and fixed in this phase

**The cursor could not drain a backlog.** The first implementation left the cursor unchanged
whenever a page was truncated, so a client received the same page on every pull and a device with
more than one page of backlog could never catch up. Found by a test that drains page by page and
asserts every row arrives. Fixed with a composite keyset — see
[ADR-0007](architecture/adr-0007-composite-sync-cursor.md).

**A migration silently removed `WITH CHECK` from three tenant tables.** While adding sync indexes I
recreated the `tenant_isolation` policies on `change_log`, `processed_operation` and
`sync_conflict` with only a `USING` clause. Reads stayed correctly isolated and every existing test
passed; writes were open, so the application role could have inserted rows bearing another shop's
`shop_id`. The tenant-isolation suite could not catch it — it attacks through the API with GETs and
PATCHes, and this hole is only reachable by a write naming a foreign shop id directly. Now guarded
by a gate asserting every RLS-enabled table has both clauses, plus a test that proves the clause is
load-bearing by attempting the insert.

**The retention job silently deleted nothing.** `change_log` and `processed_operation` carry the
standard tenant policy, so a `DELETE` from the application role with no `app.shop_id` matches
nothing and reports success having removed zero rows. Retention would have "run" nightly forever
while both tables grew without bound. This is the same trap the reconciliation sweep hit in Phase 2
and gets the same narrow answer: `platform_prune_sync_tables()`, a `SECURITY DEFINER` function that
deletes **by age only** and holds no shop id, so it cannot be aimed at a tenant.

**`JSON.stringify` threw on Prisma BigInt columns.** Storing an op result or a conflict payload
crashed on any row carrying money or quantity. Fixed by reusing `serializeBigInts` — the same
converter the HTTP envelope uses — so a replayed result is byte-identical to the original response.

## Deliberate trade recorded

A deterministic server bug inside an op's apply lands in the same catch as a transient failure and
is reported as **retryable**, so the client keeps retrying something that will never succeed. That
is the intended direction to fail in: marking real financial data permanently failed to avoid a
retry loop would discard a sale that actually happened, and §54 puts financial correctness first.
The retry is capped at five minutes by the client's backoff, and an error-level log line is what
surfaces the bug.

## Not built

- **The client half** — outbox table, flush loop, background scheduling, the sync banner. There is
  no mobile app yet; this is Phase 5. The server contract and the shared pure logic
  (`parseCursor`, `backoffDelayMs`, the conflict rules) are what the client will import.
- **Gzip on both directions** (§14.9) — worth doing at the reverse proxy rather than in the app.
- **Sales, payments and ledger entries through push** — Phase 4, per the §28 scope.

## Local development

```bash
pnpm install
pnpm db:up
cd apps/api && pnpm exec prisma migrate deploy && pnpm exec prisma generate
pnpm db:seed
pnpm test           # 773 tests
```
