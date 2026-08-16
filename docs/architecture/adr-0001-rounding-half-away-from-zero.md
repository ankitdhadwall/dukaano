# ADR-0001 — Rounding is half away from zero, not half-up

**Status:** Accepted · **Date:** 2026-08-16 · **Refines:** Blueprint §15.2

## Context

The blueprint specifies "round half-up" for every division that produces money: line discounts,
tax splits, bill-discount distribution across lines, moving-average cost.

"Half-up" is ambiguous once negative numbers exist, and it has two common readings:

- **Half up toward positive infinity** — `−2.5 → −2`
- **Half away from zero** — `−2.5 → −3`

Negative money is not hypothetical in Dukaano. It appears in returns, in cancellations, in credit
notes, and in ledger adjustments. Every one of those is expressed as the arithmetic negation of an
earlier positive amount.

Take a ₹0.25 line discount split across two lines under half-up-toward-infinity:

```
  forward:   +25 paise / 2  →  +13, +12      (sums to +25)
  reversal:  −25 paise / 2  →  −12, −13      (sums to −25)
```

The totals reverse correctly, but the **per-line** figures do not: line 1 was charged 13 and
credited 12. A one-paise residue is left on each line, with the opposite residue on the other. On a
single bill that is invisible. Across a year of returns it accumulates into a stock valuation and a
profit report that disagree with the sum of their own line items, and nothing in the system points
at where the difference came from.

Half away from zero is *symmetric about zero*: `f(−x) = −f(x)` for every `x`. A cancellation is
exactly the negation of the original, line by line.

## Decision

`divRoundHalfAwayFromZero` is the single division primitive in `@dukaano/money`. Every money and
quantity division in the system routes through it. There is no other rounding function, and
`Math.round` (which is half-up-toward-infinity) is banned by lint outside the money package.

It is implemented in bigint, on the magnitude, with the sign reapplied afterwards:

```ts
const rounded = (magnitude * 2n + denominator) / (denominator * 2n)
return negative ? -rounded : rounded
```

Sign is stripped before rounding rather than compensated for after, which is what makes the
symmetry structural rather than something the tests have to keep watching.

`roundToNearestStep` — cash rounding to the nearest 50 paise — uses the same primitive, so a cash
sale and its refund also reverse to exactly zero.

## Consequences

**Good.** Cancellation and return reverse to exactly zero at line granularity, not merely at the
total. The property is testable directly (`f(−x) === −f(x)` over a generated range) rather than
by enumerating cases. It matches how a shopkeeper reasons about a refund: give back what was taken.

**Bad.** It differs from `Math.round`, from `toFixed`, and from most spreadsheet defaults. Anyone
reconciling a Dukaano figure against Excel by hand can find a one-paise disagreement on a negative
amount, and will reasonably suspect us first. The lint ban plus this ADR are the mitigation; a
support runbook entry will be needed the first time a shopkeeper asks.

**Bad.** It contradicts the wording in blueprint §15.2, which now needs to be read alongside this
ADR rather than alone. §15.2 stays as written — rewriting the contract to match the implementation
would erase the fact that the discrepancy was found and reasoned about.

## Alternatives rejected

**Banker's rounding (half to even).** Statistically unbiased over many roundings, and standard in
some financial contexts. Rejected because it is *not* symmetric about zero either — `2.5 → 2` but
`−2.5 → −2` — so it fails the reversal property, which is the specific problem being solved. It is
also unexplainable to a shopkeeper: "sometimes it rounds up and sometimes down" reads as a bug.

**Keep half-up and add a compensating adjustment on reversals.** Requires every reversal path to
know it is a reversal and to look up the original allocation. That is more code, on the refund
path, which is exactly the path that is hardest to test and most upsetting when wrong.
