/**
 * @dukaano/money — integer-paise money and integer-milli quantity arithmetic.
 *
 * Zero dependencies. No I/O. No framework imports. Pure functions only, so the React Native
 * client and the NestJS server run byte-identical math (blueprint §29), and so 100% branch
 * coverage is cheap enough to be a hard CI gate (blueprint §26.1).
 *
 * Every rupee and every gram in Dukaano flows through this module.
 */

export {
  PAISE_PER_RUPEE,
  MONEY_DECIMALS,
  MILLI_PER_UNIT,
  QUANTITY_DECIMALS,
  BASIS_POINTS_SCALE,
  MAX_SAFE_SCALED_VALUE,
  ROUNDING_POLICIES,
  type RoundingPolicy,
} from './constants'

export {
  MoneyError,
  InvalidScaledValueError,
  MoneyOverflowError,
  InvalidDivisorError,
  InvalidAllocationError,
} from './errors'

export {
  asPaise,
  asMilli,
  asBasisPoints,
  isValidScaledValue,
  fromBigInt,
  ZERO_PAISE,
  ZERO_MILLI,
  type Paise,
  type Milli,
  type BasisPoints,
} from './brand'

export { divRoundHalfAwayFromZero, roundToNearestStep } from './round'

export {
  addPaise,
  subPaise,
  negatePaise,
  absPaise,
  multiplyPaise,
  comparePaise,
  minPaise,
  maxPaise,
  addMilli,
  subMilli,
  negateMilli,
  compareMilli,
  percentOf,
  toBasisPoints,
  allocate,
} from './arithmetic'

export {
  lineTotal,
  computeLine,
  lineDiscountFromRate,
  computeBillTotals,
  distributeBillDiscount,
  creditPortion,
  type LineInput,
  type LineTotals,
  type BillTotals,
} from './line'

export { parseMoneyInput, parseQuantityInput, type ParseResult } from './parse'

export { toDecimalString, paiseToDecimalString, milliToDecimalString } from './serialize'
