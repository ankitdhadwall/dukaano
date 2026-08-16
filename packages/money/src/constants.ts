/**
 * Scale constants for Dukaano's integer money and quantity representation.
 *
 * Blueprint §15.1 (binding DECISION):
 *   - Money is a 64-bit integer count of **paise**.   ₹44.50  → 4450
 *   - Quantity is a 64-bit integer count of **milli-units** (scale 10^-3).
 *       1.25 kg → 1250 · 750 g (unit=kg) → 750 · 2.5 L → 2500
 *
 * Why integers rather than NUMERIC/Decimal: SQLite has no decimal type. If the React Native
 * client computes stock in REAL while Postgres computes in NUMERIC, the two drift and every
 * reconciliation run reports phantom mismatches. Integer scaling is the only representation
 * that is bit-identical on both runtimes.
 */

/** Paise in one rupee. */
export const PAISE_PER_RUPEE = 100

/** Decimal places carried by a money value (a paisa is the smallest unit). */
export const MONEY_DECIMALS = 2

/** Milli-units in one whole unit (kg, litre, piece, …). */
export const MILLI_PER_UNIT = 1000

/** Decimal places carried by a quantity value — grams and millilitres. */
export const QUANTITY_DECIMALS = 3

/** Basis-point scale. 100 bp = 1%. Used for percentage discounts and tax rates. */
export const BASIS_POINTS_SCALE = 10_000

/**
 * Hard technical ceiling for any money or quantity value.
 *
 * This is a representation limit, not a business rule — "a bill may not exceed ₹1 lakh" belongs
 * in @dukaano/validation, not here. Values are transported as plain JSON integers, so they must
 * stay inside the IEEE-754 safe-integer range even though all intermediate arithmetic here is
 * performed in bigint.
 */
export const MAX_SAFE_SCALED_VALUE = Number.MAX_SAFE_INTEGER

/** Bill-level round-off policies (blueprint §15.1, §25 E-23). India-specific cash convention. */
export const ROUNDING_POLICIES = {
  /** Total is used exactly as computed. */
  NONE: 0,
  /** Round the bill to the nearest whole rupee. */
  NEAREST_RUPEE: PAISE_PER_RUPEE,
  /** Round the bill to the nearest ₹5. */
  NEAREST_5_RUPEES: 5 * PAISE_PER_RUPEE,
} as const

export type RoundingPolicy = keyof typeof ROUNDING_POLICIES
