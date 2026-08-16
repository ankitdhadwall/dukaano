import { describe, expect, it } from 'vitest'
import * as money from './index'

/**
 * Guards the public API surface.
 *
 * @dukaano/money is imported by the API, the web admin and the React Native client. Removing or
 * renaming an export is a breaking change across three apps, so the surface is asserted
 * explicitly — a rename shows up as a failing test rather than as a build error in a downstream
 * package weeks later.
 */
describe('public API surface', () => {
  const EXPECTED_EXPORTS = [
    // constants
    'PAISE_PER_RUPEE',
    'MONEY_DECIMALS',
    'MILLI_PER_UNIT',
    'QUANTITY_DECIMALS',
    'BASIS_POINTS_SCALE',
    'MAX_SAFE_SCALED_VALUE',
    'ROUNDING_POLICIES',
    // errors
    'MoneyError',
    'InvalidScaledValueError',
    'MoneyOverflowError',
    'InvalidDivisorError',
    'InvalidAllocationError',
    // brands
    'asPaise',
    'asMilli',
    'asBasisPoints',
    'isValidScaledValue',
    'fromBigInt',
    'ZERO_PAISE',
    'ZERO_MILLI',
    // rounding
    'divRoundHalfAwayFromZero',
    'roundToNearestStep',
    // arithmetic
    'addPaise',
    'subPaise',
    'negatePaise',
    'absPaise',
    'multiplyPaise',
    'comparePaise',
    'minPaise',
    'maxPaise',
    'addMilli',
    'subMilli',
    'negateMilli',
    'compareMilli',
    'percentOf',
    'toBasisPoints',
    'allocate',
    // bill math
    'lineTotal',
    'computeLine',
    'lineDiscountFromRate',
    'computeBillTotals',
    'distributeBillDiscount',
    'creditPortion',
    // parsing & serialization
    'parseMoneyInput',
    'parseQuantityInput',
    'toDecimalString',
    'paiseToDecimalString',
    'milliToDecimalString',
  ] as const

  it.each(EXPECTED_EXPORTS)('exports %s', (name) => {
    expect(money[name as keyof typeof money]).toBeDefined()
  })

  it('exports nothing beyond the documented surface', () => {
    expect(Object.keys(money).sort()).toEqual([...EXPECTED_EXPORTS].sort())
  })

  it('exposes the India cash round-off policies', () => {
    expect(money.ROUNDING_POLICIES).toEqual({
      NONE: 0,
      NEAREST_RUPEE: 100,
      NEAREST_5_RUPEES: 500,
    })
  })

  it('computes the blueprint §19.2 worked example end to end', () => {
    // Bill ₹1,000. Customer pays ₹600 by UPI. ₹400 goes to the khata.
    const bill = money.computeBillTotals([
      { unitPricePaise: money.asPaise(50_000), qtyMilli: money.asMilli(2_000) },
    ])
    expect(bill.totalPaise).toBe(100_000)
    expect(money.creditPortion(bill.totalPaise, money.asPaise(60_000))).toBe(40_000)
  })
})
