# Phase 5 — Customers & Khata · **Complete**

Last updated: 2026-08-16 · Blueprint: [dukaano-blueprint.md](dukaano-blueprint.md) §18, §28

## A note on numbering

Blueprint Phase 5 is **Customers & Khata** — not the mobile app. The services were built in
Phase 4 because billing on credit is impossible without a ledger to put the credit in. This
document exists to prove Phase 5's *own* acceptance criteria explicitly rather than leaving them
implied by the billing suite.

The mobile app is the deferred UI half of **Phase 4** ("web and mobile, mobile offline from day
one"), and it is what still holds open the one unmet criterion in the whole project: the
20-second cash sale measured on a real device.

## Acceptance criteria — 4 of 4 met

| Criterion (blueprint §28) | Status |
|---|---|
| Ledger property test green | ✅ 40 randomised operations, seeded and reproducible |
| Concurrent payments correct | ✅ 20 simultaneous collections, none lost |
| §18.3 example reproduced **exactly** | ✅ Including the cancellation appending a fourth row |
| Archive-with-balance blocked | ✅ Plus the write-off and advance cases |

**877 tests across 6 packages.** Lint, typecheck and build clean.

## The §18.3 example, reproduced exactly

The blueprint's worked example is asserted row for row, not approximated:

```
OPENING_BALANCE   +84,000  →   84,000     (₹840 carried forward from paper)
SALE_CREDIT       +46,000  →  130,000     (INV-0113)
PAYMENT_RECEIVED  −30,000  →  100,000     (₹300 cash)
```

Then, verbatim from §18.3 — *"Cancelling INV-0113 tomorrow appends a fourth row
(`SALE_CANCELLED −₹460 → ₹540`); it does not edit row two."*

```
SALE_CANCELLED    −46,000  →   54,000
```

The test asserts the fourth row appears **and** that row two is byte-for-byte what it was before.

## Append-only, proved rather than asserted

`pg_stat_user_tables` counts row operations per table, cumulatively for the life of the database
and unaffected by `TRUNCATE`. So this is not a claim about one suite — it is a claim about every
test that has ever run:

| Table | Inserts | Updates |
|---|---:|---:|
| `customer_ledger_entry` | 290 | **0** |
| `inventory_transaction` | 85,669 | **0** |
| `customer_balance` (mutable, for contrast) | 48 | 290 |

The test cannot pass vacuously: it first requires real inserts on both append-only tables **and**
real updates on `customer_balance`, so a stats collector that was not recording would fail the
guard rather than silently produce reassuring zeros.

## The ledger property test

Forty randomised operations — credit sales, khata collections, cancellations and owner
corrections — against one customer, from a seeded PRNG so a failure is reproducible. A property
test whose inputs cannot be re-created is a flake generator, not a test.

Two properties are asserted afterwards:

1. **`balance == Σ entries`** — the snapshot equals the sum of the log.
2. **Every stamped `balance_after_paise` reproduces the replayed running total**, computed with a
   window function in insertion order. This is what makes a statement coherent to read: the
   shopkeeper can point at any line and the number beside it is the balance at that moment.

## Verified behaviour

Twenty simultaneous collections to one customer all apply and the balance is exactly their sum
(§25 E-27) — without the `FOR UPDATE` lock some would read the same starting balance and overwrite
each other, money received and then erased · `9816022221`, `+91 98160 22222`, `098160 22223` and
`91-9816022224` all normalise to E.164 · three written spellings of one number are refused as
duplicates (§25 E-16) · a customer with **no phone** is allowed, because a khata regular is often
known by face and demanding a number pushes the shopkeeper back to paper · a landline is rejected,
because it can never receive a reminder · searching the last four digits finds them, which is how
a regular is actually remembered · archiving is blocked while money is owed (§25 E-8) · a
`WRITE_OFF` clears the balance, permits the archive, and stays permanently visible in the ledger ·
a customer holding an **advance** may be archived, because the shop owes them and nothing is being
hidden from the shop's own books.

## Still open across the project

**The 20-second cash sale on a real device** (Phase 4, criterion 3). The server half measures
37 ms; there is no app yet. This is the only acceptance criterion in Phases 1–5 that is not met,
and it is met by building the mobile client.

Also outstanding: row group 9 (the queued receipt message, Phase 6), a `sale_return` sync op, and
every user interface.
