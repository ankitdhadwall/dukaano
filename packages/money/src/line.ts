import { fromBigInt, ZERO_PAISE, type BasisPoints, type Milli, type Paise } from './brand'
import { MILLI_PER_UNIT, ROUNDING_POLICIES, type RoundingPolicy } from './constants'
import { addPaise, allocate, percentOf, subPaise } from './arithmetic'
import { divRoundHalfAwayFromZero, roundToNearestStep } from './round'

/**
 * Bill arithmetic — the single implementation of how a Dukaano bill adds up.
 *
 * Blueprint §15.1 (binding): rounding is applied **once, at the line level**. Subtotals are a
 * plain sum of already-rounded line totals and are never re-rounded, and the bill-level
 * round-off is stored as an explicit `roundingAdjustmentPaise` field rather than being an
 * implicit truncation of the displayed total.
 *
 * The invariant every caller may rely on, asserted by property tests over randomly generated
 * carts in line.test.ts and again as an integration assertion on every persisted sale:
 *
 *     subtotalPaise - billDiscountPaise + roundingAdjustmentPaise === totalPaise
 *
 * Sign policing (a discount may not exceed its line, a bill may not be negative) is deliberately
 * NOT done here — those are business rules that belong to @dukaano/validation, and returns and
 * reversals legitimately produce negative values that this module must compute correctly.
 */

/** One priced line, before bill-level adjustments. */
export interface LineInput {
  /** Price per whole unit, in paise. ₹44/kg → 4400. */
  readonly unitPricePaise: Paise
  /** Quantity in milli-units. 1.5 kg → 1500. */
  readonly qtyMilli: Milli
  /** Absolute per-line discount in paise. Defaults to zero. */
  readonly discountPaise?: Paise
}

/** A line after its own arithmetic is resolved. */
export interface LineTotals {
  readonly grossPaise: Paise
  readonly discountPaise: Paise
  readonly netPaise: Paise
}

/** The complete, auditable breakdown of a bill. */
export interface BillTotals {
  /** Sum of line net amounts. Never re-rounded. */
  readonly subtotalPaise: Paise
  /** Sum of the per-line discounts, carried for reporting. */
  readonly lineDiscountPaise: Paise
  /** Bill-level discount applied on top of the subtotal. */
  readonly billDiscountPaise: Paise
  /** Signed cash round-off. Zero under the NONE policy. */
  readonly roundingAdjustmentPaise: Paise
  /** What the customer actually pays. */
  readonly totalPaise: Paise
}

/**
 * Extended price for one line: `unitPrice × quantity`, rounded once, halves away from zero.
 *
 * The multiply happens in bigint before the divide, so no precision is lost at the 10^-3
 * quantity scale regardless of how large either operand is.
 *
 *   lineTotal(4400, 1500) → 6600   — ₹44.00/kg × 1.5 kg = ₹66.00
 *   lineTotal(4400, 750)  → 3300   — ₹44.00/kg × 750 g  = ₹33.00
 *   lineTotal(1050, 333)  → 350    — ₹10.50/kg × 0.333 kg = ₹3.4965, rounds to ₹3.50
 */
export function lineTotal(unitPricePaise: Paise, qtyMilli: Milli): Paise {
  const exact = BigInt(unitPricePaise) * BigInt(qtyMilli)
  return fromBigInt<Paise>(divRoundHalfAwayFromZero(exact, BigInt(MILLI_PER_UNIT)))
}

/** Resolve one line to gross / discount / net. */
export function computeLine(line: LineInput): LineTotals {
  const grossPaise = lineTotal(line.unitPricePaise, line.qtyMilli)
  const discountPaise = line.discountPaise ?? ZERO_PAISE
  return { grossPaise, discountPaise, netPaise: subPaise(grossPaise, discountPaise) }
}

/** Convert a percentage discount on a line into an absolute paise discount. */
export function lineDiscountFromRate(grossPaise: Paise, rate: BasisPoints): Paise {
  return percentOf(grossPaise, rate)
}

/**
 * Compute the full bill breakdown.
 *
 * @param lines            Priced lines. An empty cart yields an all-zero bill, which is valid.
 * @param billDiscountPaise Absolute discount applied to the subtotal. Defaults to zero.
 * @param roundingPolicy   India cash round-off. Defaults to NONE.
 */
export function computeBillTotals(
  lines: readonly LineInput[],
  billDiscountPaise: Paise = ZERO_PAISE,
  roundingPolicy: RoundingPolicy = 'NONE',
): BillTotals {
  const resolved = lines.map(computeLine)

  const subtotalPaise = addPaise(...resolved.map((l) => l.netPaise))
  const lineDiscountPaise = addPaise(...resolved.map((l) => l.discountPaise))
  const afterDiscount = subPaise(subtotalPaise, billDiscountPaise)

  const step = ROUNDING_POLICIES[roundingPolicy]
  const totalPaise =
    step === 0
      ? afterDiscount
      : fromBigInt<Paise>(roundToNearestStep(BigInt(afterDiscount), BigInt(step)))

  return {
    subtotalPaise,
    lineDiscountPaise,
    billDiscountPaise,
    // Derived, never independently computed — this is what makes the identity hold by construction.
    roundingAdjustmentPaise: subPaise(totalPaise, afterDiscount),
    totalPaise,
  }
}

/**
 * Spread a bill-level discount back across lines, weighted by each line's net amount.
 *
 * Needed for the Phase-2 gross-profit report: profit is computed per line, so a bill-level
 * discount has to be attributed somewhere. Largest-remainder allocation guarantees the parts sum
 * to exactly the discount — no drifting paisa, and no line silently absorbing a rounding residue.
 *
 * Lines with a zero (or negative) net receive nothing.
 */
export function distributeBillDiscount(
  billDiscountPaise: Paise,
  lineNets: readonly Paise[],
): Paise[] {
  if (lineNets.length === 0) return []
  if (billDiscountPaise === 0) return lineNets.map(() => ZERO_PAISE)

  const weights = lineNets.map((net): number => (net > 0 ? net : 0))
  const totalWeight = weights.reduce((a, b) => a + b, 0)
  // Nothing positive to weight against (a fully-returned or all-zero cart): attribute nothing
  // rather than dividing arbitrarily. The caller keeps the discount at bill level.
  if (totalWeight === 0) return lineNets.map(() => ZERO_PAISE)

  return allocate(billDiscountPaise, weights)
}

/**
 * The credit (udhaar) portion of a bill: `total - paid`.
 *
 * Blueprint §19.1 (binding): udhaar produces a customer-ledger entry, never a payment row. This
 * helper is the only place that number is derived, so the invariant
 * `total = Σ payments + credit` cannot be restated inconsistently elsewhere.
 */
export function creditPortion(totalPaise: Paise, paidPaise: Paise): Paise {
  return subPaise(totalPaise, paidPaise)
}
