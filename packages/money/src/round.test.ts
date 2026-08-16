import { describe, expect, it } from 'vitest'
import { divRoundHalfAwayFromZero, roundToNearestStep } from './round'
import { InvalidDivisorError } from './errors'

describe('divRoundHalfAwayFromZero', () => {
  it.each([
    // [numerator, denominator, expected, why]
    [0n, 10n, 0n, 'zero'],
    [4n, 10n, 0n, '0.4 rounds down'],
    [5n, 10n, 1n, '0.5 rounds up (half-up on the magnitude)'],
    [6n, 10n, 1n, '0.6 rounds up'],
    [14n, 10n, 1n, '1.4 rounds down'],
    [15n, 10n, 2n, '1.5 rounds up'],
    [25n, 10n, 3n, '2.5 rounds up, NOT to even — this is not banker rounding'],
    [10n, 10n, 1n, 'exact'],
    [1n, 1n, 1n, 'denominator of one is identity'],
  ])('%s / %s → %s (%s)', (num, den, expected) => {
    expect(divRoundHalfAwayFromZero(num, den)).toBe(expected)
  })

  it.each([
    [-4n, 10n, 0n],
    [-5n, 10n, -1n],
    [-15n, 10n, -2n],
    [-25n, 10n, -3n],
  ])('%s / %s → %s (negatives mirror positives)', (num, den, expected) => {
    expect(divRoundHalfAwayFromZero(num, den)).toBe(expected)
  })

  it('is exactly symmetric about zero — the property that makes cancellations reverse to zero', () => {
    // This is the invariant that justifies half-away-from-zero over half-toward-+infinity.
    // Under the latter, -0.5 would round to 0 while +0.5 rounds to 1, and reversing a sale
    // would leave a one-paisa residue in the customer ledger.
    for (let n = -5000; n <= 5000; n += 7) {
      for (const d of [3n, 7n, 100n, 1000n]) {
        const positive = divRoundHalfAwayFromZero(BigInt(n), d)
        const negated = divRoundHalfAwayFromZero(BigInt(-n), d)
        expect(negated).toBe(-positive)
      }
    }
  })

  it('never drifts more than half a unit from the true quotient', () => {
    for (let n = -1000; n <= 1000; n += 3) {
      const d = 7n
      const result = divRoundHalfAwayFromZero(BigInt(n), d)
      const error = Math.abs(Number(result) - n / 7)
      expect(error).toBeLessThanOrEqual(0.5)
    }
  })

  it('handles values far beyond the float safe-integer range', () => {
    const huge = 10n ** 30n + 5n
    expect(divRoundHalfAwayFromZero(huge, 10n)).toBe(10n ** 29n + 1n)
  })

  it.each([0n, -1n, -1000n])('rejects a non-positive denominator: %s', (den) => {
    expect(() => divRoundHalfAwayFromZero(100n, den)).toThrow(InvalidDivisorError)
  })
})

describe('roundToNearestStep', () => {
  it.each([
    // India cash round-off: step 100 paise = nearest ₹1
    [1937n, 100n, 1900n],
    [1963n, 100n, 2000n],
    [1950n, 100n, 2000n],
    [1900n, 100n, 1900n],
    // step 500 paise = nearest ₹5
    [1937n, 500n, 2000n],
    [1749n, 500n, 1500n],
    [1750n, 500n, 2000n],
    // step 1 = no-op
    [1937n, 1n, 1937n],
  ])('rounds %s to nearest %s → %s', (value, step, expected) => {
    expect(roundToNearestStep(value, step)).toBe(expected)
  })

  it('mirrors for negative values (refund round-off)', () => {
    expect(roundToNearestStep(-1937n, 100n)).toBe(-1900n)
    expect(roundToNearestStep(-1963n, 100n)).toBe(-2000n)
  })

  it.each([0n, -100n])('rejects a non-positive step: %s', (step) => {
    expect(() => roundToNearestStep(1000n, step)).toThrow(InvalidDivisorError)
  })
})
