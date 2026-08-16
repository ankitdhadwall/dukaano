/**
 * @dukaano/i18n — bilingual copy, and every human-facing formatter.
 *
 * Blueprint §22: Hindi is a first-class locale, not a translation layer. Both catalogues ship in
 * every release and a missing Hindi key fails CI (catalogues.test.ts).
 */

export {
  translate,
  createTranslator,
  resolveLocale,
  catalogueKeys,
  CATALOGUES,
  type Catalogue,
  type TranslateParams,
  type TranslateOptions,
} from './translate'

export { en } from './catalogues/en'
export { hi } from './catalogues/hi'

export {
  formatMoney,
  formatMoneyPlain,
  formatQuantity,
  formatQuantityValue,
  formatDate,
  formatDateLong,
  formatDateTime,
  formatPhone,
  maskPhone,
  type FormatMoneyOptions,
} from './formatters'
