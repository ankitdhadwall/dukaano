# Phase 4 — Billing & payments · **Server complete, clients not built**

Last updated: 2026-08-16 · Blueprint: [dukaano-blueprint.md](dukaano-blueprint.md) §18, §19, §28

## Acceptance criteria — 4 met, 1 partially

| # | Criterion (blueprint §28) | Status |
|---|---|---|
| 1 | All 9 row groups atomic | ✅ 8 of 9 written; group 9 is Phase-6 messaging |
| 2 | Bill identity holds | ✅ Asserted per sale and across the whole shop |
| 3 | Cash sale in < 20 s **measured on a real device** | ⚠️ **Server half only: 37 ms.** No device exists |
| 4 | Offline sale + sync verified | ✅ Through the Phase-3 push path |
| 5 | Double-tap safe | ✅ Sequential *and* genuinely concurrent |

**860 tests across 6 packages.** Lint, typecheck and build clean. `@dukaano/money` and
`@dukaano/business-logic` hold at **100% branch coverage**.

### On criterion 3, plainly

The blueprint measures the 20-second cash sale **on a real device**. There is no mobile app, so
that cannot be done and this phase does not claim it. What is measured is the server half — the two
product searches a shopkeeper makes while building a cart, plus the sale itself — at **37 ms**.
That is a necessary condition for the 20-second flow, not a demonstration of it. The criterion
stays open until Phase 5 puts a real app on a real phone.

## The nine row groups

A completed sale writes, in **one** transaction:

| # | Rows | Built |
|---|---|---|
| 1 | `sale` | ✅ |
| 2 | `sale_item` × N, with name/unit/price/cost snapshots | ✅ |
| 3 | `payment` × M — real money only | ✅ |
| 4 | `payment_allocation` × M | ✅ |
| 5 | `customer_ledger_entry` for the credit portion | ✅ |
| 6 | `inventory_transaction` × N | ✅ |
| 7 | `inventory_balance` × N, under lock | ✅ |
| 8 | `change_log` × K | ✅ |
| 9 | `message` QUEUED | ❌ Phase 6 |

Atomicity is not hand-rolled: the request already runs inside one tenant transaction, so every
write joins it and a throw anywhere rolls all of it back. A test proves it by failing a sale
partway through and asserting the sale, its items, its stock movements and its ledger entry are all
absent afterwards.

## The rule the whole phase is built around

**Udhaar produces a ledger entry and never a payment row** (§19.1, binding). The identity asserted
on every persisted sale:

```
total_paise = Σ payment(IN, not a reversal) + credit_paise
```

Counting only inbound, non-reversal payments is deliberate: the identity describes the bill **as
issued**. A later refund or reversal is a subsequent fact with its own row.

This is what makes the cash-drawer figure (§19.4) trustworthy — it is a plain sum over `payment`,
and it is right only because credit never entered that table. A test asserts no payment method
named `UDHAAR` or `CREDIT` has ever appeared.

## Design decisions forced by the database

Two came from constraints refusing what the code first tried, and both improved the model.

**A bill is never rewritten.** Cancellation originally zeroed `paid_paise` and `credit_paise`. The
CHECK constraint `paid + credit = total` refused it — correctly: those columns describe the bill as
issued, and the customer may hold a printed copy of exactly that. A cancellation is now expressed
entirely by compensating rows (stock back in, credit reversed, cash returned) plus a status. The
same reasoning now applies to returns.

**Nothing is deleted to make a query easier.** Reversing a payment originally deleted its
allocations. The application role holds no DELETE grant on `payment_allocation` and refused — also
correctly: an allocation records what a payment cleared *at the time*, which stays true after the
cheque bounced. "What is still open on this bill?" is derived instead, by ignoring allocations
whose payment was reversed and subtracting returned credit.

## Verified behaviour

The §19.2 worked example writes every row group with the right values · bill identity holds for
cash, UPI, card, two-method split, partial-with-udhaar and fully-udhaar · an overpayment is refused
rather than booked as revenue · credit with no customer is refused · a resubmitted sale bills once,
including two genuinely simultaneous submits · a repeated khata collection credits once · FIFO
allocation reproduces the §18.4 example · an overpayment on khata becomes an advance, not an error
· five concurrent payments to one customer all apply (E-27) · a reversal leaves the original
visible and marked · returns reverse credit **before** refunding cash (E-39) · cash refunded never
exceeds what was paid · cumulative returns are capped at what was sold · a discounted line refunds
its discounted value · a sale that drives stock negative is accepted and flagged (§14.8) · a credit
limit warns and can be overridden, never blocks (E-34) · archiving a customer who owes money is
blocked (E-8) · a cashier can bill but cannot cancel, cannot read the sales history, and can never
adjust the khata.

## Bugs found and fixed in this phase

**The sync path skipped schema validation entirely.** Queued sales were passed straight to the
domain service, so `occurredAt` arrived as a JSON string and an offline sale crashed on a date it
had every right to send. Beyond the coercion this was the real gap: §14.4 step 3 requires a queued
op to clear **the same Zod schema** an online request does, and a payload that has sat on a device
for a fortnight is untrusted input. Both sale and payment ops now parse through the shared schema.

**Two routes returned 200-with-empty for another shop's data.** `GET /v1/customers/:id/statement`
and `GET /v1/sales/:id/returns` relied on RLS yielding no rows, so nothing leaked — but "not yours"
became indistinguishable from "exists and has no history", where §23.3 requires it to be
indistinguishable from "does not exist". Caught by the tenant-isolation gate on the day the routes
were written; both now verify the parent belongs to the shop and 404.

**`sum()` over a BIGINT column returns `numeric`.** Prisma maps that to a Decimal object, which the
response serializer does not convert, so the cash-drawer total reached the client as `NaN`. Fixed
with an explicit `::bigint` cast.

## Not built

- **Every user interface**: cart, search-first billing screen, quantity pad, receipt render, the
  web bulk screens. There is no mobile or web app yet — Phase 5.
- **Row group 9, the queued receipt message** — Phase 6. The comment marking its place is in
  `sales.service.ts` so the gap is visible rather than forgotten.
- **Held bills** (§25 E-6 web fallback) and **cart persistence** (E-40) — both client-side state.
- **A `sale_return` sync op.** Sales and payments push through sync; returns do not yet, so a
  return created offline waits for connectivity. Worth closing when the mobile app is built and the
  real offline return flow is known.

## Local development

```bash
pnpm install
pnpm db:up
cd apps/api && pnpm exec prisma migrate deploy && pnpm exec prisma generate
pnpm db:seed
pnpm test           # 860 tests
```
