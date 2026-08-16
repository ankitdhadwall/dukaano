import { describe, expect, it } from 'vitest'
import {
  absPaise,
  addMilli,
  addPaise,
  allocate,
  compareMilli,
  comparePaise,
  maxPaise,
  minPaise,
  multiplyPaise,
  negateMilli,
  negatePaise,
  percentOf,
  subMilli,
  subPaise,
  toBasisPoints,
} from './arithmetic'
import { asBasisPoints, asMilli, asPaise } from './brand'
import { InvalidAllocationError, MoneyOverflowError } from './errors'

const p = asPaise
const m = asMilli
const bp = asBasisPoints

describe('money arithmetic', () => {
  it('adds a variadic list, treating an empty list as zero', () => {
    expect(addPaise()).toBe(0)
    expect(addPaise(p(100), p(250), p(75))).toBe(425)
    expect(addPaise(p(-100), p(100))).toBe(0)
  })

  it('subtracts, allowing a negative result (returns and reversals produce them)', () => {
    expect(subPaise(p(1000), p(400))).toBe(600)
    expect(subPaise(p(400), p(1000))).toBe(-600)
  })

  it('negates and takes absolute values', () => {
    expect(negatePaise(p(4450))).toBe(-4450)
    expect(negatePaise(p(-4450))).toBe(4450)
    expect(negatePaise(p(0))).toBe(0)
    expect(absPaise(p(-4450))).toBe(4450)
    expect(absPaise(p(4450))).toBe(4450)
  })

  it('multiplies by a whole factor', () => {
    expect(multiplyPaise(p(1150), 3)).toBe(3450)
    expect(multiplyPaise(p(1150), 0)).toBe(0)
    expect(multiplyPaise(p(1150), -2)).toBe(-2300)
  })

  it('rejects a fractional factor, pointing the caller at lineTotal', () => {
    expect(() => multiplyPaise(p(1150), 1.5)).toThrow(InvalidAllocationError)
    expect(() => multiplyPaise(p(1150), 1.5)).toThrow(/lineTotal/)
  })

  it('detects overflow instead of silently losing precision', () => {
    expect(() => multiplyPaise(p(Number.MAX_SAFE_INTEGER), 2)).toThrow(MoneyOverflowError)
    expect(() => addPaise(p(Number.MAX_SAFE_INTEGER), p(1))).toThrow(MoneyOverflowError)
  })

  it('compares and picks extremes', () => {
    expect(comparePaise(p(100), p(200))).toBe(-1)
    expect(comparePaise(p(200), p(100))).toBe(1)
    expect(comparePaise(p(100), p(100))).toBe(0)
    expect(minPaise(p(100), p(200))).toBe(100)
    expect(minPaise(p(200), p(100))).toBe(100)
    expect(maxPaise(p(100), p(200))).toBe(200)
    expect(maxPaise(p(200), p(100))).toBe(200)
  })
})

describe('quantity arithmetic', () => {
  it('adds and subtracts milli-units', () => {
    expect(addMilli()).toBe(0)
    expect(addMilli(m(1500), m(750))).toBe(2250) // 1.5 kg + 750 g
    expect(subMilli(m(5000), m(3000))).toBe(2000)
  })

  it('goes negative — negative stock is an allowed state (blueprint §17.3)', () => {
    expect(subMilli(m(3000), m(5000))).toBe(-2000)
    expect(negateMilli(m(1500))).toBe(-1500)
  })

  it('compares quantities', () => {
    expect(compareMilli(m(100), m(200))).toBe(-1)
    expect(compareMilli(m(200), m(100))).toBe(1)
    expect(compareMilli(m(100), m(100))).toBe(0)
  })
})

describe('percentOf', () => {
  it.each([
    [10000, 1250, 1250], // 12.5% of ₹100.00 = ₹12.50
    [10000, 10000, 10000], // 100%
    [10000, 0, 0], // 0%
    [4999, 1000, 500], // 10% of ₹49.99 = ₹4.999 → ₹5.00 (half-up)
    [4994, 1000, 499], // 10% of ₹49.94 = ₹4.994 → ₹4.99
  ])('%s paise at %s bp → %s paise', (amount, rate, expected) => {
    expect(percentOf(p(amount), bp(rate))).toBe(expected)
  })

  it('mirrors for negative amounts, so a reversal is exact', () => {
    expect(percentOf(p(-4999), bp(1000))).toBe(-500)
  })
})

describe('toBasisPoints', () => {
  it.each([
    [12.5, 1250],
    [100, 10000],
    [0, 0],
    [0.01, 1],
    [33.33, 3333],
  ])('%s%% → %s bp', (percent, expected) => {
    expect(toBasisPoints(percent)).toBe(expected)
  })

  it('rejects non-finite input', () => {
    expect(() => toBasisPoints(NaN)).toThrow(InvalidAllocationError)
    expect(() => toBasisPoints(Infinity)).toThrow(InvalidAllocationError)
  })

  it('rejects a negative percentage via the basis-point brand', () => {
    expect(() => toBasisPoints(-5)).toThrow()
  })
})

describe('allocate', () => {
  it('distributes without losing or inventing a paisa', () => {
    // ₹10.00 across three equal lines cannot divide evenly; the leftover paisa must land
    // somewhere deterministic rather than vanishing.
    const shares = allocate(p(1000), [1, 1, 1])
    expect(shares).toEqual([334, 333, 333])
    expect(shares.reduce((a, b) => a + b, 0)).toBe(1000)
  })

  it('weights proportionally', () => {
    const shares = allocate(p(1000), [700, 300])
    expect(shares).toEqual([700, 300])
  })

  it('breaks remainder ties by index, so every device produces the same split', () => {
    // 100 / 7 = 14 each with 2 paise left over; equal remainders, so the first two indices win.
    expect(allocate(p(100), [1, 1, 1, 1, 1, 1, 1])).toEqual([15, 15, 14, 14, 14, 14, 14])
    expect(allocate(p(100), [1, 1, 1, 1, 1, 1, 1]).reduce((a, b) => a + b, 0)).toBe(100)
  })

  it('never gives a share to a zero-weight bucket', () => {
    const shares = allocate(p(1000), [1, 0, 1])
    expect(shares[1]).toBe(0)
    expect(shares.reduce((a, b) => a + b, 0)).toBe(1000)
  })

  it('carries the sign for reversals, and reverses exactly', () => {
    const forward = allocate(p(1000), [1, 1, 1])
    const backward = allocate(p(-1000), [1, 1, 1])
    expect(backward).toEqual(forward.map((s) => -s))
    expect(backward.reduce((a, b) => a + b, 0)).toBe(-1000)
  })

  it('handles a single bucket and a zero total', () => {
    expect(allocate(p(1000), [5])).toEqual([1000])
    expect(allocate(p(0), [1, 1])).toEqual([0, 0])
  })

  it('sums to the original for a large randomized sweep', () => {
    let seed = 42
    const rand = (n: number) => {
      seed = (seed * 1103515245 + 12345) % 2147483648
      return seed % n
    }
    for (let i = 0; i < 500; i++) {
      const total = rand(1_000_000)
      const weights = Array.from({ length: 1 + rand(12) }, () => rand(1000))
      if (weights.reduce((a, b) => a + b, 0) === 0) continue
      const shares = allocate(p(total), weights)
      expect(shares.reduce((a, b) => a + b, 0)).toBe(total)
    }
  })

  it.each([
    [[], 'no weights'],
    [[0, 0], 'all weights zero'],
  ])('rejects %s (%s)', (weights) => {
    expect(() => allocate(p(1000), weights)).toThrow(InvalidAllocationError)
  })

  it.each([[-1], [1.5], [NaN]])('rejects the invalid weight %s', (bad) => {
    expect(() => allocate(p(1000), [1, bad])).toThrow(InvalidAllocationError)
  })
})
