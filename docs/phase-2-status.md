# Phase 2 — Catalogue & Inventory · **Complete**

Last updated: 2026-08-16 · Blueprint: [dukaano-blueprint.md](dukaano-blueprint.md) §28

## Acceptance criteria — 4 of 4 met

| # | Criterion (blueprint §28) | Status |
|---|---|---|
| 1 | Product search under 100 ms at 5,000 products | ✅ **6.0 ms worst case, 4.7 ms median** — measured end-to-end over HTTP |
| 2 | Every stock change has a transaction | ✅ `InventoryService` is the only writer; opening stock, adjustments, imports and adoptions all append |
| 3 | `balance == Σ transactions` | ✅ Asserted after ~10,000 creates, and swept nightly across every shop |
| 4 | 5,000-row import with per-row error report | ✅ **4,980 created + 20 reported, committed in ~850 ms** |

**663 tests across 6 packages.** Lint, typecheck and build clean. `@dukaano/money` and
`@dukaano/business-logic` hold at **100% branch coverage**.

## Built

**Seed — Dhadwal Confectionery & General Store.** A real Himachal general store rather than
invented data, because the shape of a real catalogue is what surfaces design problems: ₹1 toffees
beside ₹330 ghee, loose goods priced per kg beside packets priced per packet, and Hindi names
longer than their English equivalents.

- 12 master categories, 97 master products, all bilingual with romanized aliases
- 71 shop products with realistic per-category margins (confectionery thin, household best)
- 210 search aliases, 6 khata customers with opening balances, 3 suppliers
- Opening stock written as `OPENING_STOCK` transactions, opening balances as ledger entries —
  never as bare balances, so the reconciliation invariant holds from the first row
- Production-guarded: the demo shop has a known password and is skipped when `NODE_ENV=production`

**Costing** (`@dukaano/business-logic/inventory`) — moving average, stock valuation, low-stock
crossing detection. The case worth naming: a receipt arriving while stock is *negative* resets the
average to the incoming cost rather than averaging against a negative denominator, which can flip
the sign of the cost and corrupt the valuation months later.

**Inventory service** — the single writer of stock. `SELECT … FOR UPDATE` on the balance row,
deterministic lock ordering by product id across multi-line movements (unordered locking deadlocks
roughly 1 in a few hundred concurrent multi-line sales), server-assigned `balance_after`, reason
enforcement, low-stock crossing, and a reconciliation that **reports rather than auto-heals** — a
mismatch means a write-path bug, and healing it would hide the defect.

**Products service** — bilingual create/update/archive, quick-create for billing, and ranked
search: exact short code → exact SKU → name prefix → alias prefix → contains. Aliases rank equal
to names, which is what makes `chini` → चीनी work.

**Categories and units.** Categories are organisational only — no pricing rule, no tax rate, no
report that changes its answer if a product moves — which is what makes renaming free and
archiving cheap. Archiving is soft and deliberately leaves products carrying the category: they
archived a *label*, and finding forty products silently uncategorised is a bigger problem than the
one they were solving. Units are a **fixed platform list** with no CRUD, per blueprint A-7; they
are served from the API rather than hardcoded per client so a new unit ships without an app-store
release.

**Master-catalogue adoption** (`POST /v1/master-catalogue/adopt`) — the one-tap "add 40 common
items" flow, and the main mitigation for risk R-1. Prices are **never copied** from the platform
row: `hintPricePaise` may pre-fill the UI, but adoption requires an explicit price per item,
because a shop in Shimla and a shop in Solan do not charge the same for atta. Re-adopting skips
rather than duplicating, so a double tap leaves one Sugar and does not read as an error.

**Bulk import** — the four-step wizard's server half. Stateless and two-phase; the file is
re-parsed and re-validated on commit rather than trusted from a stored job
([ADR-0006](architecture/adr-0006-stateless-two-phase-import.md)). The CSV reader and row
normalizer live in `@dukaano/business-logic`, so the browser preview and the server commit are
computed by the same code and cannot disagree.

**Nightly reconciliation sweep** — 02:30 IST, every shop, `balance == Σ transactions`. One
transaction per shop rather than one for the sweep, so a snapshot is not held open across the
whole tenant list and one shop's failure does not abort the rest. Gated on `ENABLE_SCHEDULED_JOBS`
so only the designated replica runs it.

## Verified behaviour

Search finds Sugar by `sug`, `SUG01`, `SUG`, `chini`, `cheeni`, `shakkar` and `चीनी` · an exact
short-code match outranks an alphabetically-earlier name match · 10 concurrent deductions on one
product produce exactly 10 transactions and the correct balance · negative stock is permitted and
reported, not blocked · the moving average is quantity-weighted (25 kg @ ₹100 + 25 kg @ ₹110 →
₹105) and untouched by outbound movements · a unit change is blocked while stock is non-zero ·
archiving is soft and frees the SKU for reuse · a Cashier cannot adjust stock, read valuation,
create a category, adopt from the master catalogue, or run an import.

**Import, specifically.** The CSV reader handles the BOM Excel writes, CRLF/LF/CR endings mixed in
one file, embedded newlines and doubled quotes, and skips the blank trailing rows Excel appends —
while refusing to pad a misaligned row, because silently shifting a row by one column would
misprice a product with no trace. Headers auto-detect in English and Hindi. A row reports **every**
bad field at once rather than the first. Selling-below-cost is amber, not red: clearing old stock
at a loss is a real thing shopkeepers do. Two rows claiming one SKU are **both** rejected, since
importing either is a coin toss. A duplicate against an existing product defaults to **skip** —
overwriting a live price because a spreadsheet reused a code is not a default. `CREATE_ANYWAY`
drops the clashing code from the new row rather than failing the batch. An `UPDATE` never applies
opening stock, because that product already has a history. Failed rows come back as re-uploadable
CSV carrying the original cells plus an `_error` column.

**Reconciliation is tested by breaking it.** A balance corrupted with direct SQL — the only way to
reach the state, since `InventoryService` is the sole writer — is detected by the sweep, and the
corrupted number is still there afterwards. An untested detector is not a detector.

**The isolation gate did its job, twice.** Adding id-bearing routes in Phase 2 and again in this
batch made `tenant-isolation.spec.ts` fail on the day they were written, exactly as designed. The
matrix now covers products, memberships, shops, inventory and categories, including assertions
that a cross-tenant `PATCH` returning 404 leaves the victim's price and category name genuinely
unchanged. The route-coverage gate now templates URLs by replacing any UUID rather than naming
each id field — the old form silently failed to match new resource types and blamed the wrong
thing.

## Bugs found and fixed in this batch

**Body limits were configured only in `main.ts`, which tests never run.** The 5,000-row import
failed with a 500 that had nothing to do with importing. Anything affecting request handling now
lives in `src/bootstrap.ts` and is applied by both the production boot and the test harness, so
the two cannot drift.

**`GET /v1/inventory/products/:id` returned 404 for a product that had never moved.** The balance
row is created lazily by the first movement, so this was the normal state of every newly created
product. It conflated "no such product" with "never stocked" and read as data loss on a stock
screen. It now returns zero, and still 404s for a product that genuinely does not exist or belongs
to another shop.

**The reconciliation sweep silently checked nothing.** `shop` carries the same RLS policy as every
tenant table, so listing shops as the application role returns zero rows — RLS failing closed,
correctly, in a place where a maintenance job must not accept the answer. Fixed with
`platform_shop_directory()`, a `SECURITY DEFINER` function returning id, name and status only;
every data read still happens inside a normal tenant transaction. Verified directly: as
`dukaano_app` with no tenant context, `SELECT count(*) FROM shop` returns 0, the function returns
1, and `SELECT count(*) FROM product` still returns 0 — the function grants no access to tenant
data.

## Deferred, with reasons

- **Bulk entry grid** (`/products/bulk`) — a web UI. No web app exists yet; this is Phase 5.
- **XLSX parsing** — done in the browser, not the API. See
  [ADR-0006](architecture/adr-0006-stateless-two-phase-import.md); it keeps a parser for untrusted
  binary files out of the process holding the database credentials.
- **A content hash on import commit** — would close the gap where a file edited between preview
  and commit produces a commit that does not match what was reviewed. Currently mitigated by
  keying duplicate decisions on line number, so a mismatch is visible rather than silent.
- **Structured request logging and Sentry** — `nestjs-pino` is installed but not mounted. Phase 9.

## Architecture decisions

All six ADRs from Phase 1 and 2 are now written: [docs/architecture/](architecture/).

## Local development

```bash
pnpm install
pnpm db:up
cd apps/api && pnpm exec prisma migrate deploy && pnpm exec prisma generate
pnpm db:seed        # Dhadwal Confectionery & General Store
pnpm test           # 663 tests
```

Demo logins (development only): owner `+919816000001`, cashier `+919816000002`, both `dukaano123`.
