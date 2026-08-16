import { asMilli, asPaise, type Milli, type Paise } from './brand'
import { MONEY_DECIMALS, QUANTITY_DECIMALS } from './constants'

/**
 * Parsing of shopkeeper-typed input into scaled integers.
 *
 * These functions return a discriminated result rather than throwing, because they sit on the
 * validation path: a form needs to collect and display every field error at once, not abort on
 * the first bad one. Callers that already know the value is trustworthy (a DB row, a value that
 * passed Zod) should use `asPaise` / `asMilli` instead.
 *
 * Deliberately NOT using parseFloat: "0.1 + 0.2" is exactly why this package exists. All parsing
 * is string surgery on the digits, so what the shopkeeper typed is what gets stored.
 */

export type ParseResult<T> =
  | { readonly ok: true; readonly value: T }
  | { readonly ok: false; readonly errorKey: string; readonly params?: Record<string, unknown> }

const err = (errorKey: string, params?: Record<string, unknown>): ParseResult<never> =>
  params ? { ok: false, errorKey, params } : { ok: false, errorKey }

/**
 * Strip presentation characters a shopkeeper may paste or type: the rupee sign, spaces,
 * non-breaking spaces, and Indian digit-group commas (₹1,25,000.50).
 */
function normalizeNumericInput(raw: string): string {
  return raw
    .replace(/[\u20B9\s\u00A0\u202F]/g, '') // rupee sign, whitespace, NBSP, narrow NBSP
    .replace(/,/g, '')
    .trim()
}

/** Shared decimal-string → scaled-integer conversion. */
function parseScaled(
  raw: string,
  decimals: number,
  opts: { allowNegative: boolean; kind: 'money' | 'quantity' },
): ParseResult<number> {
  if (typeof raw !== 'string') return err(`errors.${opts.kind}.invalid`)

  const cleaned = normalizeNumericInput(raw)
  if (cleaned === '') return err(`errors.${opts.kind}.required`)

  const pattern = opts.allowNegative ? /^-?\d*(?:\.\d*)?$/ : /^\d*(?:\.\d*)?$/
  if (!pattern.test(cleaned)) return err(`errors.${opts.kind}.invalid`)

  const negative = cleaned.startsWith('-')
  const unsigned = negative ? cleaned.slice(1) : cleaned

  const [intPartRaw = '', fracPartRaw = ''] = unsigned.split('.')
  // "." or "-." alone carries no digits.
  if (intPartRaw === '' && fracPartRaw === '') return err(`errors.${opts.kind}.invalid`)

  if (fracPartRaw.length > decimals) {
    return err(`errors.${opts.kind}.tooManyDecimals`, { max: decimals, received: fracPartRaw.length })
  }

  const intPart = intPartRaw === '' ? '0' : intPartRaw
  const fracPart = fracPartRaw.padEnd(decimals, '0')
  const digits = `${intPart}${fracPart}`

  // Reject values that cannot round-trip as JSON numbers before they enter the system.
  const asBig = BigInt(digits)
  if (asBig > BigInt(Number.MAX_SAFE_INTEGER)) return err(`errors.${opts.kind}.tooLarge`)

  const value = Number(asBig)
  return { ok: true, value: negative ? -value : value }
}

/**
 * Parse a money string into paise.
 *
 *   '44.50'    → 4450     '₹1,25,000' → 12500000     '.5' → 50     '44' → 4400
 *   '44.555'   → error (money carries 2 decimals)
 *   '-10'      → error unless `allowNegative`
 */
export function parseMoneyInput(raw: string, opts?: { allowNegative?: boolean }): ParseResult<Paise> {
  const result = parseScaled(raw, MONEY_DECIMALS, {
    allowNegative: opts?.allowNegative ?? false,
    kind: 'money',
  })
  return result.ok ? { ok: true, value: asPaise(result.value) } : result
}

/**
 * Parse a quantity string into milli-units.
 *
 * @param decimals How many decimal places this product's unit permits. A `piece` unit passes 0
 *                 so "1.5 pieces" is rejected at the source rather than silently truncated;
 *                 `kg` and `litre` pass 3. Defaults to the full quantity scale.
 *
 *   parseQuantityInput('1.25')        → 1250
 *   parseQuantityInput('0.750')       → 750
 *   parseQuantityInput('1.5', 0)      → error (this unit is whole-number only)
 */
export function parseQuantityInput(
  raw: string,
  decimals: number = QUANTITY_DECIMALS,
  opts?: { allowNegative?: boolean },
): ParseResult<Milli> {
  if (!Number.isInteger(decimals) || decimals < 0 || decimals > QUANTITY_DECIMALS) {
    return err('errors.quantity.invalidUnitPrecision', { decimals })
  }

  const result = parseScaled(raw, decimals, {
    allowNegative: opts?.allowNegative ?? false,
    kind: 'quantity',
  })
  if (!result.ok) return result

  // parseScaled scaled to `decimals`; lift to the canonical 10^-3 storage scale.
  const lift = 10 ** (QUANTITY_DECIMALS - decimals)
  return { ok: true, value: asMilli(result.value * lift) }
}
