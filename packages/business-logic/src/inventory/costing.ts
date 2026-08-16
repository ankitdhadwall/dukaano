import {
  addMilli,
  asMilli,
  asPaise,
  divRoundHalfAwayFromZero,
  MILLI_PER_UNIT,
  ZERO_PAISE,
  type Milli,
  type Paise,
} from '@dukaano/money'

/**
 * Weighted-average (moving average) inventory costing — blueprint §17.2, assumption A-8.
 *
 * Why moving average rather than FIFO or batch costing: a Kirana shop buys the same sugar from
 * the same distributor at slightly different prices week to week and pours it into the same
 * sack. There are no distinguishable batches to cost against, so FIFO would be modelling a
 * fiction. Moving average matches physical reality, needs one number per product instead of a
 * lot table, and is what every Indian accountant already expects for such goods.
 *
 * FIFO/batch costing and expiry tracking are Phase-2+ items and are isolated behind this module
 * so that adding them later does not touch the inventory write path.
 */

export interface CostingState {
  /** Current quantity, in milli-units. MAY be negative (§17.3). */
  readonly qtyMilli: Milli
  /** Current weighted-average cost per whole unit, in paise. */
  readonly avgCostPaise: Paise
}

export interface InboundMovement {
  /** Quantity received, in milli-units. Must be positive. */
  readonly qtyMilli: Milli
  /** Cost per whole unit for this receipt, in paise. */
  readonly unitCostPaise: Paise
}

/**
 * Fold an inbound movement into the running average.
 *
 *   newAvg = (existingQty × existingAvg + incomingQty × incomingCost) / (existingQty + incomingQty)
 *
 * with everything computed in bigint at the 10^-3 quantity scale and rounded once, half away
 * from zero, exactly as line totals are.
 *
 * Three degenerate cases have to be handled explicitly, and each of them happens in a real shop:
 *
 *   1. **Existing quantity is zero.** Nothing to average against; the new cost simply becomes the
 *      average. Happens on every first purchase and every time a product sells out.
 *
 *   2. **Existing quantity is negative.** Blueprint §17.3 permits negative stock — refusing a sale
 *      that physically happened is worse than a wrong stock number. But averaging against a
 *      negative denominator is meaningless, and can even flip the sign of the cost. So a receipt
 *      that arrives while stock is negative *resets* the average to the incoming cost rather than
 *      computing nonsense. The shopkeeper is separately prompted to correct the count.
 *
 * Case 2 in particular is the one that a naive implementation gets wrong and that surfaces months
 * later as an inventory valuation nobody can explain.
 *
 * Note there is deliberately no third guard against a zero denominator: the two checks below
 * establish `state.qtyMilli > 0` and `movement.qtyMilli > 0`, so their sum is always positive.
 * An unreachable guard cannot be tested, and untestable defensive code is a liability rather
 * than a safety net — it reads as though a case is handled when nothing has verified it.
 */
export function applyInboundCost(state: CostingState, movement: InboundMovement): Paise {
  if (movement.qtyMilli <= 0) {
    throw new RangeError(
      `applyInboundCost expects a positive quantity; received ${movement.qtyMilli}. ` +
        `Outbound movements do not change the average cost.`,
    )
  }

  // Cases 1 and 2: nothing meaningful to average against.
  if (state.qtyMilli <= 0) return movement.unitCostPaise

  const existingValue = BigInt(state.qtyMilli) * BigInt(state.avgCostPaise)
  const incomingValue = BigInt(movement.qtyMilli) * BigInt(movement.unitCostPaise)
  // Always positive: both operands are guaranteed > 0 by the checks above.
  const totalQty = BigInt(state.qtyMilli) + BigInt(movement.qtyMilli)

  const averaged = divRoundHalfAwayFromZero(existingValue + incomingValue, totalQty)
  return asPaise(Number(averaged))
}

/**
 * The value of a stock position at its weighted-average cost.
 *
 * `qtyMilli` is at the 10^-3 scale and `avgCostPaise` is per whole unit, so the product must be
 * divided by 1000. Forgetting that is a 1000× valuation error — the kind that makes a report
 * obviously wrong, which is the good outcome; the bad one is a plausible-looking wrong number.
 *
 * A negative position yields a negative value, deliberately: the valuation report must show the
 * deficit rather than silently clamping to zero and hiding it.
 */
export function stockValue(state: CostingState): Paise {
  const exact = BigInt(state.qtyMilli) * BigInt(state.avgCostPaise)
  return asPaise(Number(divRoundHalfAwayFromZero(exact, BigInt(MILLI_PER_UNIT))))
}

/** Total valuation across many positions. */
export function totalStockValue(states: readonly CostingState[]): Paise {
  let total = 0n
  for (const state of states) total += BigInt(stockValue(state))
  return asPaise(Number(total))
}

/**
 * Apply a signed movement to a quantity, returning the resulting balance.
 *
 * Trivial arithmetic, but it exists so that the "balance after" value written onto every
 * inventory transaction comes from exactly one place, shared by the server and (in Phase 5) the
 * offline client. Two implementations of this that disagree by a rounding rule is precisely how
 * a device and the server end up reporting different stock.
 */
export function applyMovement(current: Milli, deltaMilli: Milli): Milli {
  return addMilli(current, deltaMilli)
}

/** Is this position at or below its low-stock threshold? */
export function isLowStock(qtyMilli: Milli, thresholdMilli: Milli): boolean {
  // A threshold of zero means "not tracked", not "always low" — otherwise every product a
  // shopkeeper has not configured would scream for attention and the alert becomes noise.
  if (thresholdMilli <= 0) return false
  return qtyMilli <= thresholdMilli
}

/**
 * Did a movement cross the low-stock threshold downwards?
 *
 * Notifications fire on the *crossing*, not on the state. A product sitting below its threshold
 * for a week must not re-notify on every sale — that is how a shopkeeper learns to ignore the
 * alerts entirely, at which point the feature has negative value.
 */
export function crossedBelowThreshold(
  beforeMilli: Milli,
  afterMilli: Milli,
  thresholdMilli: Milli,
): boolean {
  if (thresholdMilli <= 0) return false
  return beforeMilli > thresholdMilli && afterMilli <= thresholdMilli
}

/** Zero-valued costing state, for a product that has never been stocked. */
export const EMPTY_COSTING_STATE: CostingState = {
  qtyMilli: asMilli(0),
  avgCostPaise: ZERO_PAISE,
}
