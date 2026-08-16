import { describe, expect, it } from 'vitest'
import { milliToDecimalString, paiseToDecimalString, toDecimalString } from './serialize'
import { asMilli, asPaise } from './brand'
import { InvalidScaledValueError } from './errors'
import { parseMoneyInput, parseQuantityInput } from './parse'

describe('toDecimalString', () => {
  it.each([
    [4450, 2, '44.50'],
    [4400, 2, '44.00'],
    [1, 2, '0.01'],
    [0, 2, '0.00'],
    [-4450, 2, '-44.50'],
    [-1, 2, '-0.01'],
    [12500075, 2, '125000.75'],
    [1250, 3, '1.250'],
    [1, 3, '0.001'],
    [4450, 0, '4450'],
  ])('%s at %s decimals → %s', (scaled, decimals, expected) => {
    expect(toDecimalString(scaled, decimals)).toBe(expected)
  })

  it('rejects a non-integer value', () => {
    expect(() => toDecimalString(44.5, 2)).toThrow(InvalidScaledValueError)
  })

  it.each([-1, 1.5])('rejects the invalid decimal count %s', (decimals) => {
    expect(() => toDecimalString(4450, decimals)).toThrow(InvalidScaledValueError)
  })
})

describe('paiseToDecimalString', () => {
  it('always emits two decimals, with no symbol or grouping — this is the export format', () => {
    expect(paiseToDecimalString(asPaise(125000075))).toBe('1250000.75')
    expect(paiseToDecimalString(asPaise(0))).toBe('0.00')
    expect(paiseToDecimalString(asPaise(-500))).toBe('-5.00')
  })
})

describe('milliToDecimalString', () => {
  it('emits three decimals by default (fixed width for exports)', () => {
    expect(milliToDecimalString(asMilli(1250))).toBe('1.250')
    expect(milliToDecimalString(asMilli(750))).toBe('0.750')
    expect(milliToDecimalString(asMilli(0))).toBe('0.000')
  })

  it.each([
    [1250, '1.25'],
    [1000, '1'],
    [750, '0.75'],
    [1, '0.001'],
    [0, '0'],
    [100000, '100'],
    [10100, '10.1'],
  ])('trims trailing zeros on request: %s → %s', (milli, expected) => {
    expect(milliToDecimalString(asMilli(milli), { trimTrailingZeros: true })).toBe(expected)
  })

  it('keeps the sign when trimming', () => {
    expect(milliToDecimalString(asMilli(-1500), { trimTrailingZeros: true })).toBe('-1.5')
  })
})

describe('parse → serialize round trip', () => {
  it('returns exactly what the shopkeeper typed, for money', () => {
    for (const input of ['0.00', '0.01', '44.50', '1250.75', '99999.99', '8.20', '1.10']) {
      const parsed = parseMoneyInput(input)
      expect(parsed.ok).toBe(true)
      if (parsed.ok) expect(paiseToDecimalString(parsed.value)).toBe(input)
    }
  })

  it('returns exactly what the shopkeeper typed, for quantity', () => {
    for (const input of ['0.000', '0.001', '1.250', '2.500', '750.000']) {
      const parsed = parseQuantityInput(input)
      expect(parsed.ok).toBe(true)
      if (parsed.ok) expect(milliToDecimalString(parsed.value)).toBe(input)
    }
  })
})
