# Phase 2 — Catalogue & Inventory · **Partially complete**

Last updated: 2026-08-16 · Blueprint: [dukaano-blueprint.md](dukaano-blueprint.md) §28

## Acceptance criteria — 3 of 4 met

| # | Criterion (blueprint §28) | Status |
|---|---|---|
| 1 | Product search under 100 ms at 5,000 products | ✅ **5.6 ms worst case, 4.7 ms median** — measured end-to-end over HTTP |
| 2 | Every stock change has a transaction | ✅ `InventoryService` is the only writer; opening stock, adjustments and corrections all append |
| 3 | `balance == Σ transactions` | ✅ Asserted after ~5,100 creates and adjustments, and on the seeded shop |
| 4 | 5,000-row import with per-row error report | ❌ **Not built** — see below |

**516 tests across 6 packages.** Lint, typecheck and build clean.

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

**Costing** (`@dukaano/business-logic/inventory`, 100% coverage) — moving average, stock
valuation, low-stock crossing detection. The case worth naming: a receipt arriving while stock is
*negative* resets the average to the incoming cost rather than averaging against a negative
denominator, which can flip the sign of the cost and corrupt the valuation months later.

**Inventory service** — the single writer of stock. `SELECT … FOR UPDATE` on the balance row,
deterministic lock ordering by product id across multi-line movements (unordered locking deadlocks
roughly 1 in a few hundred concurrent multi-line sales), server-assigned `balance_after`,
reason enforcement, low-stock crossing, and a reconciliation endpoint that **reports rather than
auto-heals** — a mismatch means a write-path bug, and healing it would hide the defect.

**Products service** — bilingual create/update/archive, quick-create for billing, and ranked
search: exact short code → exact SKU → name prefix → alias prefix → contains. Aliases rank equal
to names, which is what makes `chini` → चीनी work.

## Verified behaviour

Search finds Sugar by `sug`, `SUG01`, `SUG`, `chini`, `cheeni`, `shakkar` and `चीनी` · an exact
short-code match outranks an alphabetically-earlier name match · 10 concurrent deductions on one
product produce exactly 10 transactions and the correct balance · negative stock is permitted and
reported, not blocked · the moving average is quantity-weighted (25 kg @ ₹100 + 25 kg @ ₹110 →
₹105) and untouched by outbound movements · a unit change is blocked while stock is non-zero ·
archiving is soft and frees the SKU for reuse · a Cashier cannot adjust stock or read valuation.

**The isolation gate did its job.** Adding four id-bearing routes made
`tenant-isolation.spec.ts` fail on the day they were written, exactly as designed. The matrix now
covers them, including an assertion that a cross-tenant `PATCH` returning 404 leaves the victim's
price genuinely unchanged.

## Not built — deferred with reasons

**CSV/XLSX bulk import** (criterion 4). The wizard is a four-step flow — upload, column mapping,
preview with per-row validation and duplicate resolution, then a commit that produces a
downloadable failed-row file. It is a substantial piece and the API-side half is only useful
alongside the web grid it feeds, which does not exist yet. Deferred to the start of Phase 3 so it
can be built against a real UI rather than guessed at.

Also outstanding from Phase 2 scope:

- Categories and units CRUD endpoints (the data model and seed exist; no controller yet)
- Master-catalogue adoption endpoint (`POST /v1/products/from-master`) — the one-tap
  "add 40 common items" flow that is the main mitigation for cold-start churn (risk R-1)
- Bulk entry grid (web UI — no web app yet)
- The scheduled nightly reconciliation job (the endpoint exists; nothing calls it on a timer)

Still outstanding from Phase 1: **the five ADRs** for the recorded blueprint deviations.

## Local development

```bash
pnpm install
pnpm db:up
cd apps/api && pnpm exec prisma migrate deploy && pnpm exec prisma generate
pnpm db:seed        # Dhadwal Confectionery & General Store
pnpm test           # 516 tests
```

Demo logins (development only): owner `+919816000001`, cashier `+919816000002`, both `dukaano123`.
