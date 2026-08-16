import { describe, expect, it } from 'vitest'
import {
  asBasisPoints,
  asMilli,
  asPaise,
  fromBigInt,
  isValidScaledValue,
  ZERO_MILLI,
  ZERO_PAISE,
  type Paise,
} from './brand'
import { InvalidScaledValueError, MoneyOverflowError } from './errors'
import { MAX_SAFE_SCALED_VALUE } from './constants'

describe('asPaise', () => {
  it.each([0, 1, -1, 4450, MAX_SAFE_SCALED_VALUE, -MAX_SAFE_SCALED_VALUE])(
    'accepts the safe integer %s',
    (v) => {
      expect(asPaise(v)).toBe(v)
    },
  )

  it.each([
    [44.5, 'a fractional value — money is always whole paise'],
    [NaN, 'NaN'],
    [Infinity, 'Infinity'],
    [-Infinity, '-Infinity'],
    [Number.MAX_SAFE_INTEGER + 1, 'beyond the safe-integer range'],
  ])('rejects %s (%s)', (v) => {
    expect(() => asPaise(v)).toThrow(InvalidScaledValueError)
  })

  it('reports which representation was expected, for the error message', () => {
    try {
      asPaise(1.5)
      expect.unreachable('should have thrown')
    } catch (e) {
      expect(e).toBeInstanceOf(InvalidScaledValueError)
      expect((e as InvalidScaledValueError).expected).toBe('paise')
      expect((e as InvalidScaledValueError).code).toBe('INVALID_SCALED_VALUE')
      expect((e as InvalidScaledValueError).messageKey).toBe('errors.money.invalidValue')
    }
  })
})

describe('asMilli', () => {
  it('accepts whole milli-units', () => {
    expect(asMilli(1250)).toBe(1250)
    expect(asMilli(-1250)).toBe(-1250)
  })

  it('rejects a fractional milli value — 10^-3 is the finest granularity we transact in', () => {
    expect(() => asMilli(1250.5)).toThrow(InvalidScaledValueError)
  })
})

describe('asBasisPoints', () => {
  it('accepts non-negative integers', () => {
    expect(asBasisPoints(0)).toBe(0)
    expect(asBasisPoints(1250)).toBe(1250)
  })

  it('rejects negative rates — a negative discount is a surcharge and needs its own field', () => {
    expect(() => asBasisPoints(-1)).toThrow(InvalidScaledValueError)
  })

  it('rejects fractional basis points', () => {
    expect(() => asBasisPoints(12.5)).toThrow(InvalidScaledValueError)
  })
})

describe('isValidScaledValue', () => {
  it.each([0, 1, -1, 4450])('returns true for %s', (v) => {
    expect(isValidScaledValue(v)).toBe(true)
  })

  it.each([1.5, NaN, Infinity, '4450', null, undefined, {}])('returns false for %s', (v) => {
    expect(isValidScaledValue(v)).toBe(false)
  })
})

describe('fromBigInt', () => {
  it('narrows an in-range bigint', () => {
    expect(fromBigInt<Paise>(4450n)).toBe(4450)
    expect(fromBigInt<Paise>(-4450n)).toBe(-4450)
    expect(fromBigInt<Paise>(BigInt(MAX_SAFE_SCALED_VALUE))).toBe(MAX_SAFE_SCALED_VALUE)
  })

  it.each([
    [BigInt(MAX_SAFE_SCALED_VALUE) + 1n, 'positive overflow'],
    [-BigInt(MAX_SAFE_SCALED_VALUE) - 1n, 'negative overflow'],
  ])('throws on %s (%s) rather than silently losing precision', (v) => {
    expect(() => fromBigInt<Paise>(v)).toThrow(MoneyOverflowError)
  })

  it('carries the offending value on the error for diagnostics', () => {
    const tooBig = BigInt(MAX_SAFE_SCALED_VALUE) * 1000n
    try {
      fromBigInt<Paise>(tooBig)
      expect.unreachable('should have thrown')
    } catch (e) {
      expect((e as MoneyOverflowError).result).toBe(tooBig)
      expect((e as MoneyOverflowError).code).toBe('MONEY_OVERFLOW')
      expect((e as MoneyOverflowError).name).toBe('MoneyOverflowError')
      expect(e).toBeInstanceOf(Error)
    }
  })
})

describe('zero constants', () => {
  it('are plain zeros, pre-branded to avoid casts at call sites', () => {
    expect(ZERO_PAISE).toBe(0)
    expect(ZERO_MILLI).toBe(0)
  })
})
