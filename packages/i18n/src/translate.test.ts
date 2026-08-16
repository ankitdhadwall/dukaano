import { describe, expect, it } from 'vitest'
import { catalogueKeys, createTranslator, resolveLocale, translate } from './translate'

/**
 * Locale resolution and the translator binding (blueprint §22.3).
 *
 * These were shipped untested, which the coverage gate caught — and `resolveLocale` in particular
 * deserved better, because it encodes a product decision rather than a technical one.
 */

describe('resolveLocale', () => {
  it('prefers the first usable candidate, in priority order', () => {
    // §22.3: user preference → shop default → device/Accept-Language → 'hi'
    expect(resolveLocale(['en', 'hi'])).toBe('en')
    expect(resolveLocale([null, 'hi', 'en'])).toBe('hi')
  })

  it('skips nulls, undefineds and empty strings rather than treating them as a choice', () => {
    expect(resolveLocale([null, undefined, '', 'en'])).toBe('en')
  })

  it('takes the language subtag from a regional tag', () => {
    // A device reporting hi-IN or en-GB is expressing a language we support.
    expect(resolveLocale(['hi-IN'])).toBe('hi')
    expect(resolveLocale(['en-GB'])).toBe('en')
    expect(resolveLocale(['EN-US'])).toBe('en')
  })

  it('ignores languages the app does not have', () => {
    // Falls through to the next candidate rather than half-rendering in a language with no
    // catalogue behind it.
    expect(resolveLocale(['fr', 'de', 'en'])).toBe('en')
  })

  it('falls back to Hindi, not English', () => {
    /*
     * The decision this function exists for. Hindi is the default for a shopkeeper in Himachal;
     * an English-first setup screen tells them within about five seconds that the product is not
     * for them, and they do not come back to find out otherwise.
     */
    expect(resolveLocale([])).toBe('hi')
    expect(resolveLocale([null, undefined])).toBe('hi')
    expect(resolveLocale(['fr', 'de'])).toBe('hi')
  })

  it('handles a malformed tag without throwing', () => {
    // Accept-Language is attacker-controllable input on the web admin. It must not be able to
    // crash locale resolution.
    expect(resolveLocale(['-'])).toBe('hi')
    expect(resolveLocale(['--'])).toBe('hi')
    expect(resolveLocale(['hi-'])).toBe('hi')
  })
})

describe('createTranslator', () => {
  it('binds a locale once and translates with it', () => {
    const t = createTranslator('hi')
    expect(t('common.appName')).toBe(translate('hi', 'common.appName'))
    expect(t('nav.khata')).toBe('खाता')
  })

  it('passes interpolation options through', () => {
    const t = createTranslator('en')
    expect(t('errors.permission.denied', { action: 'cancel a sale' })).toContain('cancel a sale')
  })

  it('handles plural options through the binding', () => {
    const t = createTranslator('en')
    expect(t('count.items', { count: 1 })).toBe('1 item')
    expect(t('count.items', { count: 5 })).toBe('5 items')
  })

  it('produces independent translators per locale', () => {
    const hi = createTranslator('hi')
    const en = createTranslator('en')
    expect(hi('nav.stock')).not.toBe(en('nav.stock'))
  })
})

describe('catalogueKeys', () => {
  it('lists every key in a catalogue', () => {
    const keys = catalogueKeys('en')
    expect(keys.length).toBeGreaterThan(50)
    expect(keys).toContain('common.appName')
    expect(keys).toContain('errors.sale.emptyCart')
  })

  it('returns the same key set for both locales', () => {
    // The parity guarantee that stops a feature shipping English-only and being "translated
    // later" — asserted here as well as in catalogues.test.ts because this is the function the
    // admin template editor will read.
    expect([...catalogueKeys('en')].sort()).toEqual([...catalogueKeys('hi')].sort())
  })
})
