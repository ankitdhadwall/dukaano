/* eslint-disable no-restricted-syntax -- This is the ONE module permitted to construct
   Intl.NumberFormat. Blueprint §22.5 confines currency and quantity formatting here so Indian
   digit grouping is applied in exactly one place; the lint rule that bans it everywhere else
   points callers at these functions. */

import { milliToDecimalString, paiseToDecimalString, type Milli, type Paise } from '@dukaano/money'
import type { Locale } from '@dukaano/types'

/**
 * Presentation formatting for money, quantity, numbers and dates.
 *
 * Every value shown to a human goes through here. Exports and receipts that must be
 * machine-readable use the plain serializers in @dukaano/money instead.
 */

const intlLocale = (locale: Locale): string => (locale === 'hi' ? 'hi-IN' : 'en-IN')

/**
 * Indian digit grouping: ₹1,00,000 — lakhs and crores, not thousands.
 *
 * `Intl.NumberFormat('en-IN')` implements this correctly. Writing a manual grouping helper (a
 * common shortcut) reliably gets the crore boundary wrong.
 *
 * Devanagari numerals are deliberately NOT used, in either locale. Indian shopkeepers read
 * ₹1,250 — a price written ₹१,२५० is slower to read for essentially every user, including
 * fluent Hindi readers. This is a considered decision, recorded here so it is not "fixed" later.
 */
const currencyFormatters = new Map<string, Intl.NumberFormat>()

function currencyFormatter(locale: Locale, withDecimals: boolean): Intl.NumberFormat {
  const cacheKey = `${locale}:${withDecimals}`
  let formatter = currencyFormatters.get(cacheKey)
  if (!formatter) {
    formatter = new Intl.NumberFormat(intlLocale(locale), {
      style: 'currency',
      currency: 'INR',
      numberingSystem: 'latn', // never Devanagari digits — see above
      minimumFractionDigits: withDecimals ? 2 : 0,
      maximumFractionDigits: withDecimals ? 2 : 0,
    })
    currencyFormatters.set(cacheKey, formatter)
  }
  return formatter
}

export interface FormatMoneyOptions {
  /**
   * Hide paise when the amount is a whole number of rupees. A Kirana shopkeeper reads "₹460"
   * far faster than "₹460.00", and most bills land on whole rupees. Defaults to true.
   */
  readonly compact?: boolean
}

/**
 * Format integer paise for display.
 *
 *   formatMoney(46000, 'hi')              → '₹460'
 *   formatMoney(46050, 'hi')              → '₹460.50'
 *   formatMoney(12500075, 'en')           → '₹1,25,000.75'
 *   formatMoney(46000, 'en', { compact: false }) → '₹460.00'
 */
export function formatMoney(paise: Paise, locale: Locale, options?: FormatMoneyOptions): string {
  const compact = options?.compact ?? true
  const isWholeRupees = paise % 100 === 0
  const withDecimals = !(compact && isWholeRupees)
  return currencyFormatter(locale, withDecimals).format(Number(paiseToDecimalString(paise)))
}

/** Format paise without the ₹ symbol — for table columns that carry the symbol in the header. */
export function formatMoneyPlain(paise: Paise, locale: Locale): string {
  return formatMoney(paise, locale).replace(/^₹\s?/, '')
}

/**
 * Format a quantity with its unit.
 *
 *   formatQuantity(1500, 'KG', 'hi')  → '1.5 किलो'
 *   formatQuantity(2000, 'PIECE', 'en') → '2 Piece'
 *
 * Trailing zeros are trimmed: a receipt reading "1.500 kg" looks like a machine wrote it.
 */
export function formatQuantity(milli: Milli, unitLabel: string, _locale: Locale): string {
  return `${milliToDecimalString(milli, { trimTrailingZeros: true })} ${unitLabel}`.trim()
}

/** Bare quantity, no unit. */
export function formatQuantityValue(milli: Milli): string {
  return milliToDecimalString(milli, { trimTrailingZeros: true })
}

const dateFormatters = new Map<string, Intl.DateTimeFormat>()

function dateFormatter(
  locale: Locale,
  timeZone: string,
  options: Intl.DateTimeFormatOptions,
): Intl.DateTimeFormat {
  const cacheKey = `${locale}:${timeZone}:${JSON.stringify(options)}`
  let formatter = dateFormatters.get(cacheKey)
  if (!formatter) {
    formatter = new Intl.DateTimeFormat(intlLocale(locale), {
      timeZone,
      numberingSystem: 'latn',
      ...options,
    })
    dateFormatters.set(cacheKey, formatter)
  }
  return formatter
}

/** `dd/MM/yyyy` in the shop timezone. */
export function formatDate(date: Date, locale: Locale, timeZone = 'Asia/Kolkata'): string {
  return dateFormatter(locale, timeZone, {
    day: '2-digit',
    month: '2-digit',
    year: 'numeric',
  }).format(date)
}

/** `dd MMM yyyy` with a localized month name — used on statements and receipts. */
export function formatDateLong(date: Date, locale: Locale, timeZone = 'Asia/Kolkata'): string {
  return dateFormatter(locale, timeZone, {
    day: 'numeric',
    month: 'short',
    year: 'numeric',
  }).format(date)
}

/** `dd/MM/yyyy, hh:mm am/pm` in the shop timezone. */
export function formatDateTime(date: Date, locale: Locale, timeZone = 'Asia/Kolkata'): string {
  return dateFormatter(locale, timeZone, {
    day: '2-digit',
    month: '2-digit',
    year: 'numeric',
    hour: 'numeric',
    minute: '2-digit',
    hour12: true,
  }).format(date)
}

/**
 * Format an Indian mobile number for display: `+91 98765 43210`.
 *
 * Storage is always E.164 (§25 E-16); this is presentation only.
 */
export function formatPhone(e164: string): string {
  const match = /^\+91(\d{5})(\d{5})$/.exec(e164)
  return match ? `+91 ${match[1]} ${match[2]}` : e164
}

/**
 * Mask a phone number for logs and provider payloads: `+91 98XXX X3210`.
 * Blueprint §23.4 — customer phone numbers are PII and never appear in full in a log line.
 */
export function maskPhone(e164: string): string {
  const match = /^\+91(\d{2})\d{3}\s?\d(\d{4})$/.exec(e164.replace(/\s/g, ''))
  return match ? `+91 ${match[1]}XXX X${match[2]}` : '+91XXXXXXXXXX'
}
