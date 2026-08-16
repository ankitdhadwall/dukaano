import { DEFAULT_LOCALE, LOCALES, type Locale } from '@dukaano/types'
import { en } from './catalogues/en'
import { hi } from './catalogues/hi'

/**
 * The Dukaano translator.
 *
 * Zero dependencies, by design. This module is imported by the NestJS API (to localize error
 * messages, receipts and customer messages), by Next.js, and by React Native — and it must run
 * identically in all three. Pulling i18next into the server just to interpolate a string would
 * add a runtime to every one of them.
 *
 * The catalogue format and key conventions are deliberately **i18next-compatible** (`key_one`
 * / `key_other` plural suffixes, `{{name}}` interpolation) so the client apps can hand the same
 * JSON to react-i18next for their React integration without a second set of translation files.
 *
 * Pluralization uses `Intl.PluralRules`, which is real CLDR data — Hindi has `one` and `other`,
 * and a naive `count === 1 ? x : y` gets Hindi wrong for 0 (Hindi treats 0 as `one`). That is
 * exactly the kind of bug that makes a product feel foreign to its users.
 */

export type Catalogue = Readonly<Record<string, string>>

const CATALOGUES: Readonly<Record<Locale, Catalogue>> = { en, hi }

export type TranslateParams = Readonly<Record<string, string | number>>

/**
 * An intersection rather than an `interface … extends`: `count?: number` includes `undefined`,
 * which is not assignable to the parent's `string | number` index signature. The intersection
 * expresses the same shape without tripping that check.
 */
export type TranslateOptions = TranslateParams & {
  /** Drives plural selection. Also available to the template as `{{count}}`. */
  count?: number
}

const pluralRules = new Map<Locale, Intl.PluralRules>()

function pluralCategory(locale: Locale, count: number): Intl.LDMLPluralRule {
  let rules = pluralRules.get(locale)
  if (!rules) {
    rules = new Intl.PluralRules(locale === 'hi' ? 'hi-IN' : 'en-IN')
    pluralRules.set(locale, rules)
  }
  return rules.select(count)
}

/** Replace `{{token}}` placeholders. An unknown token is left intact so it is visible in QA. */
function interpolate(template: string, params: TranslateParams): string {
  return template.replace(/\{\{(\w+)\}\}/g, (match, token: string) => {
    const value = params[token]
    return value === undefined ? match : String(value)
  })
}

/**
 * Resolve a key to a localized string.
 *
 * Fallback chain: requested locale → default locale (`hi`) → English → the key itself.
 *
 * Returning the **key** rather than an empty string on a total miss is deliberate: a screen
 * showing `khata.receivePayment` is obviously broken and gets reported, whereas a blank button
 * looks like a rendering glitch and ships. A CI check (see catalogues.test.ts) makes a missing
 * Hindi key a build failure, so this path should never be reached in production.
 */
export function translate(locale: Locale, key: string, options: TranslateOptions = {}): string {
  const { count, ...rest } = options
  const params: TranslateParams = count === undefined ? rest : { ...rest, count }

  const candidates: string[] = []
  if (count !== undefined) {
    candidates.push(`${key}_${pluralCategory(locale, count)}`)
    // i18next also recognises the bare `_other` form as the catch-all.
    candidates.push(`${key}_other`)
  }
  candidates.push(key)

  for (const localeCandidate of dedupe([locale, DEFAULT_LOCALE, 'en' as Locale])) {
    const catalogue = CATALOGUES[localeCandidate]
    for (const candidate of candidates) {
      const template = catalogue[candidate]
      if (template !== undefined) return interpolate(template, params)
    }
  }

  return key
}

function dedupe<T>(values: readonly T[]): T[] {
  return [...new Set(values)]
}

/** Bind a locale once, e.g. per request or per shop. */
export function createTranslator(locale: Locale): (key: string, options?: TranslateOptions) => string {
  return (key, options) => translate(locale, key, options)
}

/**
 * Resolve the locale to use, following blueprint §22.3:
 *   user preference → shop default → device/Accept-Language → 'hi'
 *
 * Hindi is the fallback, not English. A shopkeeper who sees an English-first setup concludes the
 * product is not for them within about five seconds.
 */
export function resolveLocale(
  candidates: readonly (string | null | undefined)[],
): Locale {
  for (const candidate of candidates) {
    if (!candidate) continue
    // Accept 'hi', 'hi-IN', 'en-GB' — take the language subtag only.
    const language = candidate.split('-')[0]?.toLowerCase()
    if (language && (LOCALES as readonly string[]).includes(language)) return language as Locale
  }
  return DEFAULT_LOCALE
}

/** Every key defined in a catalogue. Used by the parity test and by the admin template editor. */
export function catalogueKeys(locale: Locale): readonly string[] {
  return Object.keys(CATALOGUES[locale])
}

export { CATALOGUES }
