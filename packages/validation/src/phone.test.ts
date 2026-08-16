import { describe, expect, it } from 'vitest'
import {
  isValidIndianPhone,
  lastFour,
  looksLikePhoneFragment,
  normalizeIndianPhone,
  toE164,
} from './phone'

describe('normalizeIndianPhone — the duplicate-customer defence', () => {
  it.each([
    ['9876543210', 'bare 10 digits'],
    ['+919876543210', 'E.164'],
    ['919876543210', 'country code, no plus'],
    ['09876543210', 'STD trunk prefix'],
    ['0919876543210', 'old ISD dialling habit'],
    ['+91 98765 43210', 'spaced'],
    ['+91-98765-43210', 'hyphenated'],
    ['98765 43210', 'spaced national'],
    ['98765-43210', 'hyphenated national'],
    ['+91 (98765) 43210', 'parenthesised'],
    ['  9876543210  ', 'padded'],
    ['+91 9876543210', 'plus, space, national'],
  ])('normalizes %s (%s) to the same E.164', (input) => {
    const result = normalizeIndianPhone(input)
    expect(result.ok).toBe(true)
    if (result.ok) {
      expect(result.e164).toBe('+919876543210')
      expect(result.national).toBe('9876543210')
    }
  })

  it('collapses every written form of one number to a single key', () => {
    // This is the whole point: one customer, one balance. Without it the same person becomes
    // three khata entries over three months and nobody can say which balance is real.
    const forms = ['9876543210', '+919876543210', '09876543210', '+91 98765 43210', '91-9876543210']
    const normalized = new Set(
      forms.map((f) => {
        const r = normalizeIndianPhone(f)
        return r.ok ? r.e164 : `INVALID:${f}`
      }),
    )
    expect(normalized.size).toBe(1)
  })

  it.each([
    ['6000000000', 'starts with 6'],
    ['7000000000', 'starts with 7'],
    ['8254123456', 'starts with 8'],
    ['9999999999', 'starts with 9'],
  ])('accepts %s (%s)', (input) => {
    expect(normalizeIndianPhone(input).ok).toBe(true)
  })

  it.each([
    ['5876543210', 'errors.phone.notMobile', 'landline range — cannot receive WhatsApp or SMS'],
    ['1234567890', 'errors.phone.notMobile', 'starts with 1'],
    ['0000000000', 'errors.phone.notMobile', 'all zeros'],
    ['987654321', 'errors.phone.invalid', 'nine digits'],
    ['98765432101', 'errors.phone.invalid', 'eleven digits'],
    ['abcdefghij', 'errors.phone.invalid', 'letters'],
    ['', 'errors.phone.required', 'empty'],
    ['   ', 'errors.phone.required', 'whitespace'],
  ])('rejects %s with %s (%s)', (input, expectedKey) => {
    const result = normalizeIndianPhone(input)
    expect(result.ok).toBe(false)
    if (!result.ok) expect(result.errorKey).toBe(expectedKey)
  })

  it('refuses to guess at an explicitly international number', () => {
    // A US number would otherwise be silently mangled into something that looks Indian.
    const result = normalizeIndianPhone('+14155552671')
    expect(result.ok).toBe(false)
    if (!result.ok) expect(result.errorKey).toBe('errors.phone.notIndian')
  })

  it('defends against non-string input from untyped call sites', () => {
    expect(normalizeIndianPhone(null as unknown as string).ok).toBe(false)
    expect(normalizeIndianPhone(9876543210 as unknown as string).ok).toBe(false)
  })
})

describe('toE164', () => {
  it('returns the canonical form', () => {
    expect(toE164('98765 43210')).toBe('+919876543210')
  })

  it('throws for callers that have already validated and were wrong', () => {
    expect(() => toE164('123')).toThrow(TypeError)
  })
})

describe('isValidIndianPhone', () => {
  it('is a predicate over the same rules', () => {
    expect(isValidIndianPhone('9876543210')).toBe(true)
    expect(isValidIndianPhone('5876543210')).toBe(false)
  })
})

describe('lastFour', () => {
  it('extracts the digits a shopkeeper actually remembers', () => {
    expect(lastFour('+919876548254')).toBe('8254')
  })
})

describe('looksLikePhoneFragment', () => {
  it('routes a digit search to the phone column', () => {
    expect(looksLikePhoneFragment('8254')).toBe(true)
    expect(looksLikePhoneFragment('98765')).toBe(true)
    expect(looksLikePhoneFragment('+91 98765')).toBe(true)
  })

  it('routes a name search to the name column', () => {
    expect(looksLikePhoneFragment('Ramesh')).toBe(false)
    expect(looksLikePhoneFragment('राम')).toBe(false)
    expect(looksLikePhoneFragment('12')).toBe(false) // too short to be useful
    expect(looksLikePhoneFragment('shop 123')).toBe(false)
  })
})
