import { describe, expect, it } from 'vitest'
import { asMilli, asPaise } from '@dukaano/money'
import {
  EMPTY_COSTING_STATE,
  applyInboundCost,
  applyMovement,
  crossedBelowThreshold,
  isLowStock,
  stockValue,
  totalStockValue,
  type CostingState,
} from './costing'

const m = asMilli
const p = asPaise
const state = (qty: number, cost: number): CostingState => ({
  qtyMilli: m(qty),
  avgCostPaise: p(cost),
})

describe('applyInboundCost', () => {
  it('sets the average from the first purchase', () => {
    expect(applyInboundCost(EMPTY_COSTING_STATE, { qtyMilli: m(25_000), unitCostPaise: p(4400) })).toBe(
      4400,
    )
  })

  it('weights by quantity, not by receipt count', () => {
    // 25 kg at ₹44 then 25 kg at ₹48 → ₹46.00
    expect(applyInboundCost(state(25_000, 4400), { qtyMilli: m(25_000), unitCostPaise: p(4800) })).toBe(
      4600,
    )
    // 45 kg at ₹44 then 5 kg at ₹64 → weighted to ₹46.00, NOT the ₹54 midpoint
    expect(applyInboundCost(state(45_000, 4400), { qtyMilli: m(5_000), unitCostPaise: p(6400) })).toBe(
      4600,
    )
  })

  it('barely moves the average on a small receipt into a large position', () => {
    // The property a shopkeeper relies on: one expensive sack does not reprice the whole stock.
    const next = applyInboundCost(state(100_000, 4400), { qtyMilli: m(1_000), unitCostPaise: p(9900) })
    expect(next).toBeGreaterThan(4400)
    expect(next).toBeLessThan(4500)
  })

  it('rounds half away from zero, consistently with line totals', () => {
    // 1 kg @ ₹10.00 + 2 kg @ ₹10.01 → 30.02/3 = ₹10.006… → 1001 paise
    expect(applyInboundCost(state(1_000, 1000), { qtyMilli: m(2_000), unitCostPaise: p(1001) })).toBe(
      1001,
    )
  })

  it('resets the average when the position is empty', () => {
    // A sold-out product has no cost to average against.
    expect(applyInboundCost(state(0, 4400), { qtyMilli: m(10_000), unitCostPaise: p(5000) })).toBe(5000)
  })

  it('resets the average when the position is NEGATIVE rather than computing nonsense', () => {
    /*
     * The case a naive implementation gets wrong.
     *
     * Negative stock is permitted (§17.3) — refusing a sale that physically happened is worse
     * than a wrong count. But averaging against a negative denominator is meaningless and can
     * flip the sign of the cost, producing a negative unit cost that silently corrupts the
     * valuation report months later. So a receipt arriving while stock is negative takes the
     * incoming cost outright.
     */
    const next = applyInboundCost(state(-2_000, 4400), { qtyMilli: m(10_000), unitCostPaise: p(5000) })
    expect(next).toBe(5000)
    expect(next).toBeGreaterThan(0)
  })

  it('never yields a negative average cost, for any signed starting position', () => {
    for (const qty of [-50_000, -1_000, -1, 0, 1, 1_000, 50_000]) {
      const next = applyInboundCost(state(qty, 4400), { qtyMilli: m(5_000), unitCostPaise: p(5000) })
      expect(next, `starting qty ${qty}`).toBeGreaterThanOrEqual(0)
    }
  })

  it('handles a free receipt (zero cost) without corrupting the average', () => {
    // Distributor samples and promotional stock really do arrive at zero cost.
    expect(applyInboundCost(state(10_000, 5000), { qtyMilli: m(10_000), unitCostPaise: p(0) })).toBe(
      2500,
    )
  })

  it.each([0, -1000])('rejects a non-positive inbound quantity: %s', (qty) => {
    expect(() => applyInboundCost(state(10_000, 4400), { qtyMilli: m(qty), unitCostPaise: p(5000) })).toThrow(
      RangeError,
    )
  })
})

describe('stockValue', () => {
  it('divides by the quantity scale — a 1000x error otherwise', () => {
    // 45 kg at ₹44/kg = ₹1,980.00
    expect(stockValue(state(45_000, 4400))).toBe(198_000)
    // 1.5 kg at ₹44/kg = ₹66.00
    expect(stockValue(state(1_500, 4400))).toBe(6_600)
    // 250 pieces at ₹1.00 = ₹250.00
    expect(stockValue(state(250_000, 100))).toBe(25_000)
  })

  it('reports a negative position as negative rather than clamping it to zero', () => {
    // Hiding the deficit would make the valuation report quietly wrong.
    expect(stockValue(state(-2_000, 4400))).toBe(-8_800)
  })

  it('is zero for an empty position', () => {
    expect(stockValue(EMPTY_COSTING_STATE)).toBe(0)
  })

  it('sums across positions', () => {
    expect(totalStockValue([state(45_000, 4400), state(1_500, 4400), state(250_000, 100)])).toBe(
      198_000 + 6_600 + 25_000,
    )
    expect(totalStockValue([])).toBe(0)
  })
})

describe('applyMovement', () => {
  it('adds a signed delta', () => {
    expect(applyMovement(m(45_000), m(-2_000))).toBe(43_000)
    expect(applyMovement(m(45_000), m(25_000))).toBe(70_000)
  })

  it('reproduces the blueprint §13 worked example', () => {
    // Opening 50 kg → sale 2 kg → sale 1.5 kg → purchase 25 kg → 71.5 kg
    let qty = m(50_000)
    qty = applyMovement(qty, m(-2_000))
    qty = applyMovement(qty, m(-1_500))
    qty = applyMovement(qty, m(25_000))
    expect(qty).toBe(71_500)
  })

  it('goes negative, because a sale that happened is still recorded', () => {
    expect(applyMovement(m(3_000), m(-5_000))).toBe(-2_000)
  })
})

describe('isLowStock', () => {
  it('flags at or below the threshold', () => {
    expect(isLowStock(m(3_000), m(5_000))).toBe(true)
    expect(isLowStock(m(5_000), m(5_000))).toBe(true)
    expect(isLowStock(m(5_001), m(5_000))).toBe(false)
  })

  it('treats a zero threshold as "not tracked", not "always low"', () => {
    // Otherwise every unconfigured product screams for attention and the alert becomes noise.
    expect(isLowStock(m(0), m(0))).toBe(false)
    expect(isLowStock(m(100), m(0))).toBe(false)
  })

  it('flags a negative position', () => {
    expect(isLowStock(m(-2_000), m(5_000))).toBe(true)
  })
})

describe('crossedBelowThreshold', () => {
  it('fires on the crossing', () => {
    expect(crossedBelowThreshold(m(6_000), m(4_000), m(5_000))).toBe(true)
  })

  it('does NOT re-fire while already below', () => {
    // A product sitting below threshold for a week must not notify on every sale — that is how a
    // shopkeeper learns to ignore alerts entirely.
    expect(crossedBelowThreshold(m(4_000), m(3_000), m(5_000))).toBe(false)
    expect(crossedBelowThreshold(m(5_000), m(4_000), m(5_000))).toBe(false)
  })

  it('does not fire when stock goes up', () => {
    expect(crossedBelowThreshold(m(3_000), m(20_000), m(5_000))).toBe(false)
  })

  it('does not fire when the threshold is untracked', () => {
    expect(crossedBelowThreshold(m(6_000), m(0), m(0))).toBe(false)
  })

  it('fires exactly once across a run of sales', () => {
    const threshold = m(5_000)
    let qty = m(10_000)
    let fires = 0
    for (const sale of [2_000, 2_000, 2_000, 2_000, 1_000]) {
      const before = qty
      qty = applyMovement(qty, m(-sale))
      if (crossedBelowThreshold(before, qty, threshold)) fires += 1
    }
    expect(fires).toBe(1)
  })
})
