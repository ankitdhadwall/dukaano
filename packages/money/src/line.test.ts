import { describe, expect, it } from 'vitest'
import {
  computeBillTotals,
  computeLine,
  creditPortion,
  distributeBillDiscount,
  lineDiscountFromRate,
  lineTotal,
  type LineInput,
} from './line'
import { asBasisPoints, asMilli, asPaise, ZERO_PAISE } from './brand'

const p = asPaise
const m = asMilli

describe('lineTotal', () => {
  it.each([
    // [unitPricePaise, qtyMilli, expected, description]
    [4400, 1000, 4400, '₹44/kg × 1 kg'],
    [4400, 1500, 6600, '₹44/kg × 1.5 kg'],
    [4400, 750, 3300, '₹44/kg × 750 g'],
    [4400, 250, 1100, '₹44/kg × 250 g'],
    [5000, 2000, 10000, '₹50 × 2 pieces'],
    [1050, 333, 350, '₹10.50/kg × 0.333 kg = ₹3.4965 → ₹3.50 (half-up)'],
    [1050, 332, 349, '₹10.50/kg × 0.332 kg = ₹3.486 → ₹3.49'],
    [100, 1, 0, '₹1/kg × 1 g = 0.1 paise → 0 (sub-paisa rounds away)'],
    [100, 5, 1, '₹1/kg × 5 g = 0.5 paise → 1 (half-up)'],
    [0, 5000, 0, 'a free item'],
    [4400, 0, 0, 'zero quantity'],
  ])('%s paise/unit × %s milli → %s paise (%s)', (price, qty, expected) => {
    expect(lineTotal(p(price), m(qty))).toBe(expected)
  })

  it('reverses exactly for a negative quantity — this is what makes a return net to zero', () => {
    for (const [price, qty] of [
      [4400, 1500],
      [1050, 333],
      [100, 5],
      [3333, 777],
    ] as const) {
      const forward = lineTotal(p(price), m(qty))
      const reverse = lineTotal(p(price), m(-qty))
      expect(forward + reverse).toBe(0)
    }
  })

  it('does not lose precision at scales that would break float math', () => {
    // 10,000,000 paise (₹1 lakh) per unit × 1,000 units. In float this is fine, but the
    // intermediate product is 10^13 — the point is that bigint makes the bound irrelevant.
    expect(lineTotal(p(10_000_000), m(1_000_000))).toBe(10_000_000_000)
  })
})

describe('computeLine', () => {
  it('resolves gross, discount and net', () => {
    expect(computeLine({ unitPricePaise: p(5000), qtyMilli: m(2000) })).toEqual({
      grossPaise: 10000,
      discountPaise: 0,
      netPaise: 10000,
    })
  })

  it('applies an absolute line discount', () => {
    expect(
      computeLine({ unitPricePaise: p(5000), qtyMilli: m(2000), discountPaise: p(1000) }),
    ).toEqual({ grossPaise: 10000, discountPaise: 1000, netPaise: 9000 })
  })
})

describe('lineDiscountFromRate', () => {
  it('converts a percentage into absolute paise', () => {
    expect(lineDiscountFromRate(p(10000), asBasisPoints(1000))).toBe(1000) // 10% of ₹100
    expect(lineDiscountFromRate(p(4999), asBasisPoints(500))).toBe(250) // 5% of ₹49.99 → ₹2.50
  })
})

describe('computeBillTotals', () => {
  const cart: LineInput[] = [
    { unitPricePaise: p(5000), qtyMilli: m(2000) }, // ₹50 × 2   = ₹100.00
    { unitPricePaise: p(3000), qtyMilli: m(2000) }, // ₹30 × 2   = ₹60.00
    { unitPricePaise: p(4000), qtyMilli: m(1000) }, // ₹40 × 1   = ₹40.00
  ]

  it('sums line nets without re-rounding the subtotal', () => {
    const bill = computeBillTotals(cart)
    expect(bill.subtotalPaise).toBe(20000)
    expect(bill.totalPaise).toBe(20000)
    expect(bill.roundingAdjustmentPaise).toBe(0)
    expect(bill.lineDiscountPaise).toBe(0)
  })

  it('handles an empty cart as an all-zero bill', () => {
    expect(computeBillTotals([])).toEqual({
      subtotalPaise: 0,
      lineDiscountPaise: 0,
      billDiscountPaise: 0,
      roundingAdjustmentPaise: 0,
      totalPaise: 0,
    })
  })

  it('accumulates per-line discounts separately for reporting', () => {
    const bill = computeBillTotals([
      { unitPricePaise: p(5000), qtyMilli: m(2000), discountPaise: p(500) },
      { unitPricePaise: p(3000), qtyMilli: m(2000), discountPaise: p(250) },
    ])
    expect(bill.lineDiscountPaise).toBe(750)
    expect(bill.subtotalPaise).toBe(15250) // 10000-500 + 6000-250
  })

  it('applies a bill-level discount on top of the subtotal', () => {
    const bill = computeBillTotals(cart, p(2000))
    expect(bill.billDiscountPaise).toBe(2000)
    expect(bill.totalPaise).toBe(18000)
  })

  it.each([
    // [subtotal-producing price, policy, expected total, expected adjustment]
    ['NONE', 19_37, 1937, 0],
    ['NEAREST_RUPEE', 19_37, 1900, -37],
    ['NEAREST_RUPEE', 19_63, 2000, 37],
    ['NEAREST_RUPEE', 19_50, 2000, 50],
    ['NEAREST_5_RUPEES', 19_37, 2000, 63],
    ['NEAREST_5_RUPEES', 17_49, 1500, -249],
  ] as const)('round-off policy %s on %s → total %s, adjustment %s', (policy, price, total, adj) => {
    const bill = computeBillTotals([{ unitPricePaise: p(price), qtyMilli: m(1000) }], ZERO_PAISE, policy)
    expect(bill.totalPaise).toBe(total)
    expect(bill.roundingAdjustmentPaise).toBe(adj)
  })

  it('holds the bill identity for a randomized sweep of carts', () => {
    // subtotal - billDiscount + roundingAdjustment === total
    // This is the invariant asserted again on every persisted sale in the API integration suite.
    let seed = 1337
    const rand = (n: number) => {
      seed = (seed * 1103515245 + 12345) % 2147483648
      return seed % n
    }
    const policies = ['NONE', 'NEAREST_RUPEE', 'NEAREST_5_RUPEES'] as const

    for (let i = 0; i < 1000; i++) {
      const lines: LineInput[] = Array.from({ length: 1 + rand(8) }, () => ({
        unitPricePaise: p(rand(500_00)),
        qtyMilli: m(1 + rand(10_000)),
        discountPaise: p(rand(200)),
      }))
      const billDiscount = p(rand(5000))
      const policy = policies[rand(policies.length)] ?? 'NONE'

      const bill = computeBillTotals(lines, billDiscount, policy)

      expect(bill.subtotalPaise - bill.billDiscountPaise + bill.roundingAdjustmentPaise).toBe(
        bill.totalPaise,
      )
      // Round-off never moves the total by more than half a step.
      const halfStep = policy === 'NONE' ? 0 : policy === 'NEAREST_RUPEE' ? 50 : 250
      expect(Math.abs(bill.roundingAdjustmentPaise)).toBeLessThanOrEqual(halfStep)
    }
  })
})

describe('distributeBillDiscount', () => {
  it('spreads a discount across lines weighted by net, summing to exactly the discount', () => {
    const parts = distributeBillDiscount(p(1000), [p(5000), p(3000), p(2000)])
    expect(parts).toEqual([500, 300, 200])
    expect(parts.reduce((a, b) => a + b, 0)).toBe(1000)
  })

  it('never drops a paisa on an indivisible split', () => {
    const parts = distributeBillDiscount(p(100), [p(1), p(1), p(1)])
    expect(parts.reduce((a, b) => a + b, 0)).toBe(100)
  })

  it('returns an empty array for an empty cart', () => {
    expect(distributeBillDiscount(p(1000), [])).toEqual([])
  })

  it('returns zeros when there is no discount', () => {
    expect(distributeBillDiscount(ZERO_PAISE, [p(5000), p(3000)])).toEqual([0, 0])
  })

  it('attributes nothing when no line has a positive net, rather than dividing arbitrarily', () => {
    expect(distributeBillDiscount(p(1000), [p(0), p(-500)])).toEqual([0, 0])
  })

  it('ignores negative-net lines when weighting', () => {
    const parts = distributeBillDiscount(p(1000), [p(1000), p(-500), p(1000)])
    expect(parts).toEqual([500, 0, 500])
  })
})

describe('creditPortion', () => {
  it('derives the udhaar remainder — the ₹1,000 split-payment case from blueprint §19.2', () => {
    expect(creditPortion(p(100_000), p(60_000))).toBe(40_000)
  })

  it('is zero for a fully paid bill', () => {
    expect(creditPortion(p(100_000), p(100_000))).toBe(0)
  })

  it('goes negative for an overpayment, which the ledger records as an advance (§25 E-33)', () => {
    expect(creditPortion(p(100_000), p(120_000))).toBe(-20_000)
  })
})
