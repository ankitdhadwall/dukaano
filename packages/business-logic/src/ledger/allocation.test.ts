import { describe, expect, it } from 'vitest'
import {
  AGEING_BUCKETS,
  ageingBucket,
  allocateFifo,
  applyLedgerEntry,
  ledgerEntryRequiresReason,
  signedLedgerAmount,
} from './allocation'

describe('allocateFifo', () => {
  it('clears the oldest bill first — the blueprint §18.4 worked example', () => {
    // ₹300 against INV-0098 (₹120) and INV-0113 (₹460).
    const result = allocateFifo(30_000, [
      { saleId: 'INV-0098', outstandingPaise: 12_000 },
      { saleId: 'INV-0113', outstandingPaise: 46_000 },
    ])

    expect(result.allocations).toEqual([
      { saleId: 'INV-0098', amountPaise: 12_000 },
      { saleId: 'INV-0113', amountPaise: 18_000 },
    ])
    expect(result.unallocatedPaise).toBe(0)
  })

  it('stops once the payment runs out, leaving later bills untouched', () => {
    const result = allocateFifo(5_000, [
      { saleId: 'a', outstandingPaise: 12_000 },
      { saleId: 'b', outstandingPaise: 46_000 },
    ])

    expect(result.allocations).toEqual([{ saleId: 'a', amountPaise: 5_000 }])
    expect(result.unallocatedPaise).toBe(0)
  })

  it('holds the remainder as an advance when the payment exceeds what is owed', () => {
    // ₹500 against ₹300 of bills. The customer has paid forward; this is not an error (E-33).
    const result = allocateFifo(50_000, [{ saleId: 'a', outstandingPaise: 30_000 }])

    expect(result.allocations).toEqual([{ saleId: 'a', amountPaise: 30_000 }])
    expect(result.unallocatedPaise).toBe(20_000)
  })

  it('treats a payment with no open bills as entirely an advance', () => {
    expect(allocateFifo(50_000, [])).toEqual({ allocations: [], unallocatedPaise: 50_000 })
  })

  it('emits no row for a bill that is already settled', () => {
    // A zero-amount allocation would clutter "which bills did this payment clear?" with bills it
    // did not touch.
    const result = allocateFifo(10_000, [
      { saleId: 'settled', outstandingPaise: 0 },
      { saleId: 'open', outstandingPaise: 10_000 },
    ])

    expect(result.allocations).toEqual([{ saleId: 'open', amountPaise: 10_000 }])
  })

  it('skips a bill that is somehow in credit rather than allocating negatively', () => {
    const result = allocateFifo(10_000, [
      { saleId: 'over', outstandingPaise: -500 },
      { saleId: 'open', outstandingPaise: 10_000 },
    ])

    expect(result.allocations).toEqual([{ saleId: 'open', amountPaise: 10_000 }])
  })

  it('allocates nothing for a zero payment', () => {
    expect(allocateFifo(0, [{ saleId: 'a', outstandingPaise: 10_000 }])).toEqual({
      allocations: [],
      unallocatedPaise: 0,
    })
  })

  it('never allocates more than the payment', () => {
    const bills = Array.from({ length: 20 }, (_, i) => ({
      saleId: `bill-${i}`,
      outstandingPaise: 1_000,
    }))
    const result = allocateFifo(7_500, bills)

    const total = result.allocations.reduce((sum, a) => sum + a.amountPaise, 0)
    expect(total + result.unallocatedPaise).toBe(7_500)
    expect(total).toBeLessThanOrEqual(7_500)
  })

  it('conserves the payment exactly, whatever the bill shape', () => {
    // The invariant that matters: money is neither created nor destroyed by allocation.
    for (const amount of [1, 99, 12_345, 1_000_000]) {
      for (const shape of [[3_000], [3_000, 4_000, 5_000], [1], []]) {
        const result = allocateFifo(
          amount,
          shape.map((outstandingPaise, i) => ({ saleId: `s${i}`, outstandingPaise })),
        )
        const allocated = result.allocations.reduce((sum, a) => sum + a.amountPaise, 0)
        expect(allocated + result.unallocatedPaise).toBe(amount)
      }
    }
  })

  it('rejects a negative or fractional payment rather than guessing', () => {
    expect(() => allocateFifo(-100, [])).toThrow(RangeError)
    expect(() => allocateFifo(10.5, [])).toThrow(RangeError)
  })
})

describe('signedLedgerAmount', () => {
  it.each([
    ['OPENING_BALANCE', 84_000, 84_000],
    ['SALE_CREDIT', 46_000, 46_000],
    ['PAYMENT_REVERSED', 30_000, 30_000],
    ['ADJUSTMENT_DEBIT', 5_000, 5_000],
  ] as const)('%s increases what the customer owes', (type, magnitude, expected) => {
    expect(signedLedgerAmount(type, magnitude)).toBe(expected)
  })

  it.each([
    ['PAYMENT_RECEIVED', 30_000, -30_000],
    ['RETURN_CREDIT', 12_000, -12_000],
    ['SALE_CANCELLED', 46_000, -46_000],
    ['ADJUSTMENT_CREDIT', 5_000, -5_000],
    ['WRITE_OFF', 100_000, -100_000],
  ] as const)('%s decreases what the customer owes', (type, magnitude, expected) => {
    expect(signedLedgerAmount(type, magnitude)).toBe(expected)
  })

  it('refuses a pre-signed amount', () => {
    /*
     * The sign is a fact about the entry type, not a decision at the call site. A caller that
     * could pass −30000 for PAYMENT_RECEIVED would produce +30000 in the ledger the day someone
     * "fixed" a double negative — a payment that increased the customer's debt, discovered weeks
     * later by an overcharged customer.
     */
    expect(() => signedLedgerAmount('PAYMENT_RECEIVED', -30_000)).toThrow(RangeError)
  })

  it('rejects a fractional amount', () => {
    expect(() => signedLedgerAmount('SALE_CREDIT', 100.5)).toThrow(RangeError)
  })

  it('handles zero for both signs', () => {
    expect(signedLedgerAmount('SALE_CREDIT', 0)).toBe(0)
    expect(signedLedgerAmount('PAYMENT_RECEIVED', 0)).toBe(-0)
  })
})

describe('ledgerEntryRequiresReason', () => {
  it('requires a reason for owner corrections and write-offs', () => {
    expect(ledgerEntryRequiresReason('ADJUSTMENT_DEBIT')).toBe(true)
    expect(ledgerEntryRequiresReason('ADJUSTMENT_CREDIT')).toBe(true)
    expect(ledgerEntryRequiresReason('WRITE_OFF')).toBe(true)
    expect(ledgerEntryRequiresReason('PAYMENT_REVERSED')).toBe(true)
  })

  it('does not require one for entries a normal sale produces', () => {
    expect(ledgerEntryRequiresReason('SALE_CREDIT')).toBe(false)
    expect(ledgerEntryRequiresReason('PAYMENT_RECEIVED')).toBe(false)
  })
})

describe('applyLedgerEntry', () => {
  it('reproduces the blueprint §18.3 worked example', () => {
    // Opening ₹840 → credit sale +₹460 → payment −₹300 → cancellation −₹460.
    let balance = 84_000
    balance = applyLedgerEntry(balance, signedLedgerAmount('SALE_CREDIT', 46_000))
    expect(balance).toBe(130_000)

    balance = applyLedgerEntry(balance, signedLedgerAmount('PAYMENT_RECEIVED', 30_000))
    expect(balance).toBe(100_000)

    balance = applyLedgerEntry(balance, signedLedgerAmount('SALE_CANCELLED', 46_000))
    expect(balance).toBe(54_000)
  })

  it('goes negative for an advance rather than clamping at zero', () => {
    expect(applyLedgerEntry(30_000, signedLedgerAmount('PAYMENT_RECEIVED', 50_000))).toBe(-20_000)
  })
})

describe('ageingBucket', () => {
  it('uses boundaries a shopkeeper thinks in, not 30/60/90', () => {
    expect(ageingBucket(0)).toBe('current')
    expect(ageingBucket(7)).toBe('current')
    expect(ageingBucket(8)).toBe('week2')
    expect(ageingBucket(15)).toBe('week2')
    expect(ageingBucket(16)).toBe('month1')
    expect(ageingBucket(30)).toBe('month1')
    expect(ageingBucket(31)).toBe('older')
    expect(ageingBucket(400)).toBe('older')
  })

  it('puts an unusable age in the most conservative bucket rather than throwing', () => {
    // A report screen must not crash because one bill has a malformed date.
    expect(ageingBucket(Number.NaN)).toBe('older')
  })

  it('has a final bucket that catches everything', () => {
    expect(AGEING_BUCKETS[AGEING_BUCKETS.length - 1]?.maxDays).toBe(Number.POSITIVE_INFINITY)
  })
})
