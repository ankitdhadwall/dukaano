import { MAX_SAFE_SCALED_VALUE } from './constants'
import { InvalidScaledValueError, MoneyOverflowError } from './errors'

/**
 * Nominal ("branded") types for the two scaled integer representations.
 *
 * The brand exists purely at the type level — a Paise value *is* a number at runtime — but it
 * makes the most dangerous bug class in this codebase a compile error: passing a quantity where
 * a money value is expected, or passing rupees where paise is expected. Both would otherwise
 * type-check perfectly and be off by a factor of 100 or 1000.
 */
declare const scaleBrand: unique symbol

/** An integer count of paise. ₹44.50 → `4450 as Paise`. */
export type Paise = number & { readonly [scaleBrand]: 'Paise' }

/** An integer count of milli-units. 1.25 kg → `1250 as Milli`. */
export type Milli = number & { readonly [scaleBrand]: 'Milli' }

/** An integer count of basis points. 12.5% → `1250 as BasisPoints`. */
export type BasisPoints = number & { readonly [scaleBrand]: 'BasisPoints' }

const isSafeInt = (value: unknown): value is number =>
  typeof value === 'number' && Number.isSafeInteger(value)

/**
 * Assert that a raw number is a valid paise value and brand it.
 * Use at every boundary where untyped data enters: DB rows, JSON bodies, sync payloads.
 */
export function asPaise(value: number): Paise {
  if (!isSafeInt(value)) throw new InvalidScaledValueError(value, 'paise')
  return value as Paise
}

/** Assert that a raw number is a valid milli-unit quantity and brand it. */
export function asMilli(value: number): Milli {
  if (!isSafeInt(value)) throw new InvalidScaledValueError(value, 'milli')
  return value as Milli
}

/** Assert that a raw number is a valid basis-point value and brand it. Must be >= 0. */
export function asBasisPoints(value: number): BasisPoints {
  if (!isSafeInt(value) || value < 0) throw new InvalidScaledValueError(value, 'basisPoints')
  return value as BasisPoints
}

/** Non-throwing predicate form, for validation layers that collect errors rather than throw. */
export function isValidScaledValue(value: unknown): value is number {
  return isSafeInt(value)
}

/** Zero, pre-branded. Avoids `0 as Paise` casts sprinkled through call sites. */
export const ZERO_PAISE = 0 as Paise
/** Zero quantity, pre-branded. */
export const ZERO_MILLI = 0 as Milli

/**
 * Narrow a bigint arithmetic result back to a branded safe integer.
 * Every arithmetic helper funnels through here, so overflow can never escape silently.
 */
export function fromBigInt<T extends Paise | Milli>(value: bigint): T {
  if (value > BigInt(MAX_SAFE_SCALED_VALUE) || value < -BigInt(MAX_SAFE_SCALED_VALUE)) {
    throw new MoneyOverflowError(value)
  }
  return Number(value) as T
}
