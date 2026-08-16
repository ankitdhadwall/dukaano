import type { Milli, Paise } from './brand'
import { MONEY_DECIMALS, QUANTITY_DECIMALS } from './constants'
import { InvalidScaledValueError } from './errors'

/**
 * Non-localized serialization of scaled integers to plain decimal strings.
 *
 * This is the primitive that @dukaano/i18n's `formatMoney`/`formatQuantity` build on, and it is
 * what CSV/XLSX exports write — an export must be machine-readable, so it gets "1250.75", never
 * "₹1,250.75". Anything shown to a human goes through @dukaano/i18n instead, which applies Indian
 * digit grouping and the shop's locale (blueprint §22.5).
 */

/** Convert a scaled integer to a fixed-point decimal string. `toDecimalString(4450, 2)` → "44.50". */
export function toDecimalString(scaled: number, decimals: number): string {
  if (!Number.isSafeInteger(scaled)) throw new InvalidScaledValueError(scaled, 'paise')
  if (!Number.isInteger(decimals) || decimals < 0) {
    throw new InvalidScaledValueError(decimals, 'step')
  }
  if (decimals === 0) return String(scaled)

  const negative = scaled < 0
  const digits = String(Math.abs(scaled)).padStart(decimals + 1, '0')
  const intPart = digits.slice(0, digits.length - decimals)
  const fracPart = digits.slice(digits.length - decimals)

  return `${negative ? '-' : ''}${intPart}.${fracPart}`
}

/** `4450` → `"44.50"`. Always two decimals, no currency symbol, no grouping. */
export function paiseToDecimalString(value: Paise): string {
  return toDecimalString(value, MONEY_DECIMALS)
}

/**
 * `1250` → `"1.250"`, or `"1.25"` with `trimTrailingZeros`.
 *
 * Trailing zeros matter for readability: a shopkeeper reading "1.250 kg" on a receipt finds it
 * odd, while an export column benefits from the fixed width. Both callers exist, so both forms do.
 */
export function milliToDecimalString(value: Milli, opts?: { trimTrailingZeros?: boolean }): string {
  const fixed = toDecimalString(value, QUANTITY_DECIMALS)
  if (!opts?.trimTrailingZeros) return fixed
  return fixed.replace(/\.?0+$/, '')
}
