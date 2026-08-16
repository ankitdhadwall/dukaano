import { asBasisPoints, fromBigInt, type BasisPoints, type Milli, type Paise } from './brand'
import { BASIS_POINTS_SCALE } from './constants'
import { InvalidAllocationError } from './errors'
import { divRoundHalfAwayFromZero } from './round'

/**
 * Arithmetic over scaled integers.
 *
 * Every operation converts to bigint, computes exactly, then narrows back through `fromBigInt`,
 * which throws on overflow. The intermediate widening matters: a unit price of ₹1,00,000
 * (10,000,000 paise) times 1,000 units (1,000,000 milli) is 10^13 — comfortably inside the
 * safe-integer range, but the product of two such values during a percentage calculation is not.
 * Doing the multiply in bigint removes the class of bug entirely rather than reasoning about
 * where the boundary sits.
 */

// --- Money -------------------------------------------------------------------------------

/** Sum any number of paise values. Returns 0 for an empty list. */
export function addPaise(...values: readonly Paise[]): Paise {
  let total = 0n
  for (const v of values) total += BigInt(v)
  return fromBigInt<Paise>(total)
}

/** `a - b`, in paise. */
export function subPaise(a: Paise, b: Paise): Paise {
  return fromBigInt<Paise>(BigInt(a) - BigInt(b))
}

/** Negate a paise value. Used when writing reversing entries. */
export function negatePaise(value: Paise): Paise {
  return fromBigInt<Paise>(-BigInt(value))
}

/** Absolute value of a paise amount. */
export function absPaise(value: Paise): Paise {
  const b = BigInt(value)
  return fromBigInt<Paise>(b < 0n ? -b : b)
}

/** Multiply a paise amount by a whole-number factor (e.g. a piece count). */
export function multiplyPaise(value: Paise, factor: number): Paise {
  if (!Number.isSafeInteger(factor)) {
    throw new InvalidAllocationError(
      `multiplyPaise expects an integer factor; received ${factor}. For fractional quantities ` +
        `use lineTotal(unitPrice, qtyMilli), which carries the 10^-3 quantity scale.`,
    )
  }
  return fromBigInt<Paise>(BigInt(value) * BigInt(factor))
}

/** Compare two paise values. Returns -1, 0 or 1. */
export function comparePaise(a: Paise, b: Paise): -1 | 0 | 1 {
  return a < b ? -1 : a > b ? 1 : 0
}

/** Smaller of two paise values. */
export function minPaise(a: Paise, b: Paise): Paise {
  return a <= b ? a : b
}

/** Larger of two paise values. */
export function maxPaise(a: Paise, b: Paise): Paise {
  return a >= b ? a : b
}

// --- Quantity ----------------------------------------------------------------------------

/** Sum any number of milli-unit quantities. */
export function addMilli(...values: readonly Milli[]): Milli {
  let total = 0n
  for (const v of values) total += BigInt(v)
  return fromBigInt<Milli>(total)
}

/** `a - b`, in milli-units. */
export function subMilli(a: Milli, b: Milli): Milli {
  return fromBigInt<Milli>(BigInt(a) - BigInt(b))
}

/** Negate a quantity. Used to turn a sale line into an inventory delta. */
export function negateMilli(value: Milli): Milli {
  return fromBigInt<Milli>(-BigInt(value))
}

/** Compare two quantities. Returns -1, 0 or 1. */
export function compareMilli(a: Milli, b: Milli): -1 | 0 | 1 {
  return a < b ? -1 : a > b ? 1 : 0
}

// --- Percentages -------------------------------------------------------------------------

/**
 * Apply a basis-point rate to a paise amount, rounding halves away from zero.
 *
 * Basis points (1 bp = 0.01%) are used rather than floats so that "12.5% discount" is the exact
 * integer 1250 and survives a round-trip through JSON, Postgres and SQLite unchanged.
 *
 *   percentOf(asPaise(100_00), asBasisPoints(1250)) → 1250 paise (₹12.50 of ₹100.00)
 */
export function percentOf(amount: Paise, rate: BasisPoints): Paise {
  const product = BigInt(amount) * BigInt(rate)
  return fromBigInt<Paise>(divRoundHalfAwayFromZero(product, BigInt(BASIS_POINTS_SCALE)))
}

/** Convert a human percentage to basis points. `toBasisPoints(12.5)` → 1250. */
export function toBasisPoints(percent: number): BasisPoints {
  if (!Number.isFinite(percent)) {
    throw new InvalidAllocationError(`Percentage must be finite, received ${percent}`)
  }
  // Multiply then round, so 12.5 → 1250 exactly and 0.005 → 1 (0.005% ≈ 0.5bp → 1bp).
  return asBasisPoints(Math.round(percent * 100))
}

// --- Allocation --------------------------------------------------------------------------

/**
 * Split a paise amount across weighted buckets without losing or inventing a single paisa.
 *
 * Uses the largest-remainder method: floor every share, then hand the leftover paise out one at
 * a time to the buckets with the largest fractional remainders (ties broken by index, so the
 * result is deterministic and reproducible on any device).
 *
 * This is what distributes a bill-level discount across sale lines. The naive approach —
 * multiplying each line by a percentage and rounding independently — produces a set of lines
 * that does not add up to the bill total, which is exactly the discrepancy a shopkeeper notices
 * and loses trust over.
 *
 *   allocate(asPaise(1000), [1, 1, 1]) → [334, 333, 333]   (sums to 1000, not 999 or 1002)
 *
 * @param total   Amount to distribute. May be negative (a reversal); shares carry the sign.
 * @param weights Non-negative integer weights, at least one of which must be positive.
 */
export function allocate(total: Paise, weights: readonly number[]): Paise[] {
  if (weights.length === 0) {
    throw new InvalidAllocationError('allocate() requires at least one weight.')
  }
  for (const w of weights) {
    if (!Number.isSafeInteger(w) || w < 0) {
      throw new InvalidAllocationError(
        `allocate() weights must be non-negative safe integers; received ${w}.`,
      )
    }
  }

  const weightsBig = weights.map(BigInt)
  const totalWeight = weightsBig.reduce((acc, w) => acc + w, 0n)
  if (totalWeight === 0n) {
    throw new InvalidAllocationError('allocate() requires a non-zero total weight.')
  }

  const totalBig = BigInt(total)
  const negative = totalBig < 0n
  const magnitude = negative ? -totalBig : totalBig

  // Floor share plus remainder, computed on the magnitude so the sign is applied uniformly.
  const shares: bigint[] = []
  const remainders: { index: number; remainder: bigint }[] = []
  let distributed = 0n

  for (let i = 0; i < weightsBig.length; i++) {
    const weight = weightsBig[i] as bigint
    const numerator = magnitude * weight
    const share = numerator / totalWeight
    shares.push(share)
    // A zero-weight bucket is excluded from leftover distribution outright. The largest-remainder
    // method already guarantees it could never win a paisa (its remainder is always 0, and
    // leftover is strictly less than the count of non-zero remainders), but relying on that proof
    // at every call site is worse than one explicit guard here.
    if (weight > 0n) remainders.push({ index: i, remainder: numerator % totalWeight })
    distributed += share
  }

  let leftover = magnitude - distributed
  remainders.sort((a, b) => {
    if (a.remainder === b.remainder) return a.index - b.index // deterministic across devices
    return b.remainder > a.remainder ? 1 : -1 // descending remainder
  })

  for (const { index } of remainders) {
    if (leftover <= 0n) break
    shares[index] = (shares[index] as bigint) + 1n
    leftover -= 1n
  }

  return shares.map((s) => fromBigInt<Paise>(negative ? -s : s))
}
