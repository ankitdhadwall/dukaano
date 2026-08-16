import { LEDGER_ENTRY_TYPES, type LedgerEntryType } from '@dukaano/types'

/**
 * Khata arithmetic — how a payment clears bills, and how a ledger entry moves a balance
 * (blueprint §18).
 *
 * Two rules shape everything here:
 *
 *   **`amount_paise` is signed.** Positive increases what the customer owes, negative decreases
 *   it. Callers never choose the sign; it is derived from the entry type, because that is a fact
 *   about the type rather than a decision at the call site. A `PAYMENT_RECEIVED` that increased a
 *   balance would be a bookkeeping catastrophe discovered weeks later by a customer who was
 *   overcharged, and the only defence that scales is making the sign underivable by hand.
 *
 *   **The ledger is append-only.** Nothing here mutates. A correction is a new entry.
 */

/** An open bill, oldest first. */
export interface OpenBill {
  readonly saleId: string
  /** What remains unpaid on this bill, in paise. Always positive for an open bill. */
  readonly outstandingPaise: number
}

export interface Allocation {
  readonly saleId: string
  readonly amountPaise: number
}

export interface AllocationResult {
  readonly allocations: readonly Allocation[]
  /**
   * What the payment could not be applied to — an **advance**, not an error (§25 E-33).
   *
   * A customer handing over ₹500 against ₹300 of bills has paid ₹200 forward. The shop owes it to
   * them, the balance goes negative, and the UI shows "₹200 जमा / advance". Refusing the payment
   * or silently keeping the change would both be wrong.
   */
  readonly unallocatedPaise: number
}

/**
 * Allocate a payment across open bills, oldest first (§18.4).
 *
 * FIFO is the default because it is what a shopkeeper means by "chukta kar diya" — the old debt
 * clears first — and because any other order makes the ageing report incomprehensible. The web
 * admin can override the allocation manually; this is the automatic path.
 *
 * `bills` must already be ordered oldest first. Sorting here would need a date on every bill and
 * would silently produce a different answer than the caller's query ordering, which is the sort of
 * disagreement that shows up as two screens reporting different open bills.
 */
export function allocateFifo(amountPaise: number, bills: readonly OpenBill[]): AllocationResult {
  if (!Number.isInteger(amountPaise)) {
    throw new RangeError(`Payment amount must be integer paise, received ${amountPaise}`)
  }
  if (amountPaise < 0) {
    throw new RangeError(`Payment amount must not be negative, received ${amountPaise}`)
  }

  const allocations: Allocation[] = []
  let remaining = amountPaise

  for (const bill of bills) {
    if (remaining === 0) break
    // A bill with nothing outstanding contributes no allocation row. Emitting a zero-amount row
    // would clutter "which bills did this payment clear?" with bills it did not touch.
    if (bill.outstandingPaise <= 0) continue

    const applied = Math.min(remaining, bill.outstandingPaise)
    allocations.push({ saleId: bill.saleId, amountPaise: applied })
    remaining -= applied
  }

  return { allocations, unallocatedPaise: remaining }
}

/**
 * The signed ledger amount for an entry type, given a positive magnitude.
 *
 * Callers pass what the shopkeeper typed — always positive — and the sign comes from the type.
 * `DEBIT` increases what the customer owes; `CREDIT` decreases it.
 */
export function signedLedgerAmount(entryType: LedgerEntryType, magnitudePaise: number): number {
  if (!Number.isInteger(magnitudePaise)) {
    throw new RangeError(`Ledger amount must be integer paise, received ${magnitudePaise}`)
  }
  if (magnitudePaise < 0) {
    throw new RangeError(
      `Ledger amounts are passed as positive magnitudes; the sign comes from the entry type. ` +
        `Received ${magnitudePaise} for ${entryType}.`,
    )
  }

  return LEDGER_ENTRY_TYPES[entryType].sign === 'DEBIT' ? magnitudePaise : -magnitudePaise
}

/** Does this entry type require a reason? Owner corrections and write-offs do (§18.2). */
export function ledgerEntryRequiresReason(entryType: LedgerEntryType): boolean {
  return LEDGER_ENTRY_TYPES[entryType].requiresReason
}

/**
 * The running balance after applying an entry.
 *
 * Trivial arithmetic, deliberately named: `balance_after_paise` is stamped **inside the balance
 * row lock** (§18.1 rule 4), and having one function for it makes every call site visibly the
 * same computation rather than an open-coded `+` that could drift.
 */
export function applyLedgerEntry(currentBalancePaise: number, signedAmountPaise: number): number {
  return currentBalancePaise + signedAmountPaise
}

/**
 * Ageing buckets for the khata report, by days since the bill's business date.
 *
 * The boundaries are the ones a shopkeeper already thinks in — this week, this fortnight, this
 * month, older — rather than the 30/60/90 of formal accounts receivable, which means nothing to a
 * shop extending credit until the next salary day.
 */
export const AGEING_BUCKETS = [
  { key: 'current', maxDays: 7 },
  { key: 'week2', maxDays: 15 },
  { key: 'month1', maxDays: 30 },
  { key: 'older', maxDays: Number.POSITIVE_INFINITY },
] as const

export type AgeingBucketKey = (typeof AGEING_BUCKETS)[number]['key']

/** Which bucket a bill falls into, given its age in whole days. */
export function ageingBucket(ageInDays: number): AgeingBucketKey {
  for (const bucket of AGEING_BUCKETS) {
    if (ageInDays <= bucket.maxDays) return bucket.key
  }
  // Unreachable: the final bucket's bound is Infinity. Returned rather than thrown so a caller
  // passing NaN gets the most conservative bucket instead of an exception on a report screen.
  return 'older'
}
