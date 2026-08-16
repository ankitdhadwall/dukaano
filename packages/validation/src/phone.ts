/**
 * Indian mobile-number normalization (blueprint §34, §25 E-16).
 *
 * The problem this solves, in the shopkeeper's words: the same customer gets written into the
 * khata three different ways over three months, and ends up as three customers with three
 * separate balances. By the time anyone notices, nobody can say which balance is real.
 *
 * Every one of these is the same person, and all of them are typed by real users:
 *
 *   9876543210        +919876543210      +91 98765 43210
 *   09876543210       919876543210       98765-43210
 *   +91-9876543210    91 9876543210      +91 (98765) 43210
 *
 * Canonical storage form is E.164: `+919876543210`. Normalization happens on write, before the
 * uniqueness check — not at read time, which would leave duplicates already in the table.
 *
 * Deliberately NOT using libphonenumber: it is ~500 KB, which is a meaningful share of the JS
 * bundle on a 2 GB Android device, and Dukaano only needs one country's mobile rules. If we ever
 * support a second country this decision gets revisited — that is recorded in
 * docs/architecture/adr-0003-phone-normalization.md.
 */

export const INDIA_COUNTRY_CODE = '91'
export const INDIA_DIAL_PREFIX = `+${INDIA_COUNTRY_CODE}`

export type PhoneParseResult =
  | { readonly ok: true; readonly e164: string; readonly national: string }
  | { readonly ok: false; readonly errorKey: string }

/**
 * Indian mobile numbers are 10 digits and begin with 6, 7, 8 or 9.
 *
 * Landlines (which start with other digits and vary in length) are intentionally rejected:
 * Dukaano's whole customer-messaging story is WhatsApp and SMS, and neither reaches a landline.
 * Accepting one would let a shopkeeper save a number that can never receive a reminder, and they
 * would discover that only when the money did not come in.
 */
const NATIONAL_MOBILE = /^[6-9]\d{9}$/

/**
 * Normalize an arbitrary user-typed Indian mobile number to E.164.
 *
 * @param raw Anything a shopkeeper might type or paste.
 */
export function normalizeIndianPhone(raw: string): PhoneParseResult {
  if (typeof raw !== 'string') return { ok: false, errorKey: 'errors.phone.invalid' }

  // Strip everything that is not a digit or a leading plus.
  const trimmed = raw.trim()
  if (trimmed === '') return { ok: false, errorKey: 'errors.phone.required' }

  const hadPlus = trimmed.startsWith('+')
  let digits = trimmed.replace(/\D/g, '')

  // Peel the country code / trunk prefix, most specific first.
  if (digits.length === 12 && digits.startsWith(INDIA_COUNTRY_CODE)) {
    digits = digits.slice(2)
  } else if (digits.length === 13 && digits.startsWith(`0${INDIA_COUNTRY_CODE}`)) {
    // 0091 98765 43210 — the old ISD dialling habit.
    digits = digits.slice(3)
  } else if (digits.length === 11 && digits.startsWith('0')) {
    // 09876543210 — the STD trunk prefix.
    digits = digits.slice(1)
  } else if (hadPlus && digits.length > 10 && !digits.startsWith(INDIA_COUNTRY_CODE)) {
    // An explicitly international number for some other country. We do not guess.
    return { ok: false, errorKey: 'errors.phone.notIndian' }
  }

  if (!NATIONAL_MOBILE.test(digits)) {
    return {
      ok: false,
      errorKey: digits.length === 10 ? 'errors.phone.notMobile' : 'errors.phone.invalid',
    }
  }

  return { ok: true, e164: `${INDIA_DIAL_PREFIX}${digits}`, national: digits }
}

/** Throwing form, for code paths that have already validated. */
export function toE164(raw: string): string {
  const result = normalizeIndianPhone(raw)
  if (!result.ok) throw new TypeError(`Not a valid Indian mobile number: ${raw}`)
  return result.e164
}

/** Predicate form, for Zod refinements and UI enablement. */
export function isValidIndianPhone(raw: string): boolean {
  return normalizeIndianPhone(raw).ok
}

/**
 * The last four digits, for the search-by-last-4 flow (blueprint §35).
 * Typing `8254` finds Ramesh Sharma 98XXXX8254 — the way a shopkeeper actually remembers
 * a customer's number.
 */
export function lastFour(e164: string): string {
  return e164.slice(-4)
}

/**
 * Is this search term a phone-number fragment rather than a name?
 *
 * Drives customer search: three or more digits means search the phone column, otherwise search
 * the name. Doing both unconditionally is measurably slower on a shop with 2,000 customers.
 */
export function looksLikePhoneFragment(term: string): boolean {
  const digits = term.replace(/\D/g, '')
  return digits.length >= 3 && digits.length === term.replace(/[\s\-+()]/g, '').length
}
