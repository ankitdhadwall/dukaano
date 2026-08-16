import { InvalidDivisorError } from './errors'

/**
 * Divide two bigints, rounding halves **away from zero**.
 *
 * Blueprint §15.1 commits to "half-up, applied once, at the line level". That statement assumed
 * non-negative quantities. Signed values are unavoidable in practice — cancellations, returns,
 * refunds and negative stock adjustments all produce them — so this implementation refines the
 * decision to **half away from zero**, which is the symmetric variant:
 *
 *     divRoundHalfAwayFromZero(-x, d) === -divRoundHalfAwayFromZero(x, d)
 *
 * That symmetry is not cosmetic. It is what guarantees a cancellation reverses a sale to
 * *exactly* zero. Under half-toward-positive-infinity, reversing a line that rounded up would
 * leave a one-paisa residue, and those residues accumulate in the customer ledger until a
 * shopkeeper's khata is off by rupees with no traceable cause. This property is asserted as a
 * test invariant in round.test.ts and again at the bill level in line.test.ts.
 *
 * Recorded as an amendment to the §15.1 DECISION; see docs/architecture/adr-0002-money-rounding.md.
 *
 * @param numerator   Any bigint, positive or negative.
 * @param denominator Must be strictly positive.
 */
export function divRoundHalfAwayFromZero(numerator: bigint, denominator: bigint): bigint {
  if (denominator <= 0n) throw new InvalidDivisorError(denominator)

  const negative = numerator < 0n
  const magnitude = negative ? -numerator : numerator

  // (2|n| + d) / 2d, using bigint truncating division. Because the dividend is always
  // non-negative here, truncation is floor, which yields exact half-up on the magnitude.
  const rounded = (magnitude * 2n + denominator) / (denominator * 2n)

  return negative ? -rounded : rounded
}

/**
 * Round a scaled integer to the nearest multiple of `step`, halves away from zero.
 *
 * Used for India's cash round-off convention: `roundToNearestStep(19_37n, 100n)` → `19_00n`
 * (₹19.37 → ₹19.00) and `roundToNearestStep(19_63n, 100n)` → `20_00n`.
 *
 * @param value Any bigint.
 * @param step  Must be strictly positive. A step of 1 is a no-op.
 */
export function roundToNearestStep(value: bigint, step: bigint): bigint {
  if (step <= 0n) throw new InvalidDivisorError(step)
  return divRoundHalfAwayFromZero(value, step) * step
}
