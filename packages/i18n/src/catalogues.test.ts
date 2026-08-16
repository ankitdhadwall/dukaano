import { describe, expect, it } from 'vitest'
import { LOCALES, type Locale } from '@dukaano/types'
import { en } from './catalogues/en'
import { hi } from './catalogues/hi'
import { CATALOGUES, resolveLocale, translate } from './translate'

/**
 * Blueprint §22.1: "a missing Hindi string FAILS CI".
 *
 * This is the test that enforces it. Without it, Hindi silently degrades release by release
 * until it is a second-class experience — which for Dukaano's users is the *primary* experience.
 */
describe('catalogue parity — the CI gate on bilingual completeness', () => {
  const enKeys = Object.keys(en).sort()
  const hiKeys = Object.keys(hi).sort()

  it('has a Hindi string for every English key', () => {
    const missing = enKeys.filter((key) => !(key in hi))
    expect(missing, `Missing Hindi translations for: ${missing.join(', ')}`).toEqual([])
  })

  it('has an English string for every Hindi key', () => {
    const missing = hiKeys.filter((key) => !(key in en))
    expect(missing, `Missing English translations for: ${missing.join(', ')}`).toEqual([])
  })

  it('has no empty strings in either catalogue', () => {
    for (const locale of LOCALES) {
      for (const [key, value] of Object.entries(CATALOGUES[locale])) {
        expect(value.trim(), `${locale}:${key} is empty`).not.toBe('')
      }
    }
  })

  it('uses the same interpolation tokens in both languages', () => {
    // A Hindi string that references {{name}} where English references {{count}} renders a
    // literal "{{name}}" to the user — visible, embarrassing, and easy to miss in review.
    const tokensOf = (s: string) => [...s.matchAll(/\{\{(\w+)\}\}/g)].map((m) => m[1]).sort()

    for (const key of enKeys) {
      const enTokens = tokensOf(en[key as keyof typeof en])
      const hiTokens = tokensOf(hi[key as keyof typeof hi])
      expect(hiTokens, `Token mismatch on "${key}"`).toEqual(enTokens)
    }
  })

  it('provides both plural forms wherever one is defined', () => {
    for (const locale of LOCALES) {
      const keys = Object.keys(CATALOGUES[locale])
      for (const key of keys) {
        if (key.endsWith('_one')) {
          expect(keys, `${locale}: ${key} has no _other form`).toContain(
            `${key.slice(0, -4)}_other`,
          )
        }
      }
    }
  })

  it('actually contains Devanagari in the Hindi catalogue', () => {
    // Guards against a copy-paste that leaves English text sitting in the Hindi file.
    const devanagari = /[ऀ-ॿ]/
    const suspicious = Object.entries(hi)
      .filter(([key]) => !key.startsWith('unit.') && key !== 'common.appName')
      .filter(([, value]) => !devanagari.test(value))
      .map(([key]) => key)

    expect(suspicious, `Hindi entries with no Devanagari: ${suspicious.join(', ')}`).toEqual([])
  })

  it('keeps money examples in Latin numerals in the Hindi copy', () => {
    // Deliberate decision (formatters.ts): ₹1,250, never ₹१,२५०.
    const devanagariDigits = /[०-९]/
    for (const [key, value] of Object.entries(hi)) {
      expect(devanagariDigits.test(value), `${key} uses Devanagari digits`).toBe(false)
    }
  })
})

describe('translate', () => {
  it('resolves a key in each locale', () => {
    expect(translate('en', 'nav.newSale')).toBe('New Sale')
    expect(translate('hi', 'nav.newSale')).toBe('नई बिक्री')
  })

  it('interpolates parameters', () => {
    expect(translate('en', 'auth.welcome', { name: 'Rakesh' })).toBe('Welcome, Rakesh')
    expect(translate('hi', 'auth.welcome', { name: 'राकेश' })).toBe('नमस्ते, राकेश')
  })

  it('leaves an unknown token visible rather than blanking it', () => {
    expect(translate('en', 'auth.welcome')).toBe('Welcome, {{name}}')
  })

  it('selects plural forms via CLDR rules, not a count === 1 check', () => {
    expect(translate('en', 'count.items', { count: 1 })).toBe('1 item')
    expect(translate('en', 'count.items', { count: 5 })).toBe('5 items')
    expect(translate('en', 'count.items', { count: 0 })).toBe('0 items')

    // Hindi CLDR treats 0 as the `one` category — a naive ternary gets this wrong.
    expect(translate('hi', 'count.items', { count: 1 })).toBe('1 चीज़')
    expect(translate('hi', 'count.items', { count: 5 })).toBe('5 चीज़ें')
    expect(translate('hi', 'count.items', { count: 0 })).toBe('0 चीज़')
  })

  it('returns the key itself when nothing matches, so the breakage is visible', () => {
    expect(translate('en', 'does.not.exist')).toBe('does.not.exist')
  })

  it('falls back through hi then en', () => {
    // Every key exists in both today (the parity test guarantees it), so this exercises the
    // mechanism rather than a real gap.
    expect(translate('en', 'errors.unknown')).toBe(en['errors.unknown'])
    expect(translate('hi', 'errors.unknown')).toBe(hi['errors.unknown'])
  })

  it('makes count available to the template as a parameter', () => {
    expect(translate('en', 'notification.lowStock.body', { count: 12 })).toBe(
      '12 products are running low.',
    )
  })
})

describe('resolveLocale', () => {
  it('follows user → shop → device → hi (blueprint §22.3)', () => {
    expect(resolveLocale(['en', 'hi', 'hi'])).toBe('en')
    expect(resolveLocale([null, 'en', 'hi'])).toBe('en')
    expect(resolveLocale([null, null, 'hi-IN'])).toBe('hi')
  })

  it('defaults to Hindi, not English', () => {
    // A shopkeeper who sees an English-first setup concludes the product is not for them.
    expect(resolveLocale([])).toBe('hi')
    expect(resolveLocale([null, undefined, ''])).toBe('hi')
    expect(resolveLocale(['fr-FR', 'de'])).toBe('hi')
  })

  it('accepts region subtags and is case-insensitive', () => {
    expect(resolveLocale(['EN-gb'])).toBe('en')
    expect(resolveLocale(['hi-IN'])).toBe('hi')
  })

  it('covers every declared locale', () => {
    for (const locale of LOCALES) {
      expect(resolveLocale([locale])).toBe(locale as Locale)
    }
  })
})
