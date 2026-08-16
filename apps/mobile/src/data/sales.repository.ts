import { asMilli, asPaise, computeBillTotals, creditPortion, type RoundingPolicy } from '@dukaano/money'
import { computeBusinessDate } from '@dukaano/business-logic'
import type { PaymentMethod } from '@dukaano/types'
import { enqueue } from './outbox'
import type { SqliteDatabase } from './sqlite'

/**
 * Recording a sale on the device (blueprint §14.1, §19.2).
 *
 * The offline mirror of `SalesService`, and it computes the bill with **the same
 * `@dukaano/money` functions the server uses**. Not a re-implementation: literally the same
 * package. If the phone and the server each had their own idea of how a 1.5 kg line at ₹44.50
 * rounds, every offline bill would arrive at the server subtly wrong and the shopkeeper would be
 * the one explaining it to a customer.
 *
 * Everything below happens in **one SQLite transaction** — sale, items, payments, the stock
 * decrement and the outbox row. There is no window in which goods left the shelf but nothing is
 * queued to say so.
 */

export interface CartLine {
  readonly productId: string
  readonly qtyMilli: number
  readonly unitPricePaise: number
  readonly discountPaise?: number
}

export interface CartPayment {
  readonly method: PaymentMethod
  readonly amountPaise: number
  readonly reference?: string
}

export interface RecordSaleRequest {
  readonly saleId: string
  readonly opId: string
  readonly customerId?: string
  readonly lines: readonly CartLine[]
  readonly payments?: readonly CartPayment[]
  readonly billDiscountPaise?: number
  readonly occurredAt?: Date
  readonly timezone?: string
  readonly businessDayStartHour?: number
  readonly roundingPolicy?: RoundingPolicy
  /** Supplied by the caller so ids are testable; defaults to crypto.randomUUID. */
  readonly newId?: () => string
}

export interface RecordedSale {
  readonly saleId: string
  readonly saleNumber: string
  readonly totalPaise: number
  readonly paidPaise: number
  readonly creditPaise: number
  readonly businessDate: string
  readonly wentNegative: readonly string[]
}

export class OfflineSaleError extends Error {
  constructor(
    readonly code: 'NO_LEASE' | 'UNKNOWN_PRODUCT' | 'OVERPAID' | 'CUSTOMER_REQUIRED' | 'EMPTY_CART',
    message: string,
  ) {
    super(message)
    this.name = 'OfflineSaleError'
  }
}

/**
 * Draw the next invoice number from the device's lease (§14.6).
 *
 * A receipt handed to a customer must carry its final number **now**, offline. Assigning it later
 * at sync time would mean the paper in the customer's hand and the record in the system disagree,
 * which no shopkeeper can defend across a counter. Gaps in the sequence are expected and the web
 * admin explains them once.
 */
export function drawInvoiceNumber(db: SqliteDatabase, series = 'INV'): string {
  const [lease] = db.all<{ range_to: number; next_value: number }>(
    'SELECT range_to, next_value FROM number_lease WHERE series = ?',
    [series],
  )

  if (!lease || lease.next_value > lease.range_to) {
    // Refused rather than invented. A locally-numbered receipt would collide with another
    // device's block and two customers would hold bills bearing the same number.
    throw new OfflineSaleError(
      'NO_LEASE',
      'This device has no invoice numbers left. Connect to get more.',
    )
  }

  db.run('UPDATE number_lease SET next_value = next_value + 1 WHERE series = ?', [series])
  return `${series}-${String(lease.next_value).padStart(4, '0')}`
}

/** How many numbers remain. Under 20 the client requests a fresh lease (§14.6). */
export function remainingLeaseNumbers(db: SqliteDatabase, series = 'INV'): number {
  const [lease] = db.all<{ range_to: number; next_value: number }>(
    'SELECT range_to, next_value FROM number_lease WHERE series = ?',
    [series],
  )
  if (!lease) return 0
  return Math.max(0, lease.range_to - lease.next_value + 1)
}

export function recordSale(db: SqliteDatabase, request: RecordSaleRequest): RecordedSale {
  if (request.lines.length === 0) {
    throw new OfflineSaleError('EMPTY_CART', 'Add at least one item to the bill.')
  }

  const newId = request.newId ?? (() => globalThis.crypto.randomUUID())
  const occurredAt = request.occurredAt ?? new Date()

  const totals = computeBillTotals(
    request.lines.map((line) => ({
      unitPricePaise: asPaise(line.unitPricePaise),
      qtyMilli: asMilli(line.qtyMilli),
      discountPaise: asPaise(line.discountPaise ?? 0),
    })),
    asPaise(request.billDiscountPaise ?? 0),
    request.roundingPolicy ?? 'NONE',
  )

  const paidPaise = (request.payments ?? []).reduce((sum, p) => sum + p.amountPaise, 0)
  const credit = creditPortion(totals.totalPaise, asPaise(paidPaise))

  if (credit < 0) {
    throw new OfflineSaleError(
      'OVERPAID',
      'The payment is more than the bill total. Give the change from the drawer.',
    )
  }
  if (credit > 0 && !request.customerId) {
    throw new OfflineSaleError('CUSTOMER_REQUIRED', 'Choose a customer to record udhaar.')
  }

  /*
   * The business date is computed on the device, in the shop's timezone.
   *
   * A sale rung up at 00:30 in a shop whose day starts at 04:00 belongs to the previous day's
   * takings (§25 E-20). Deriving it here rather than at sync time is what keeps a night's trading
   * on the right day even when the phone does not reconnect until morning.
   */
  const businessDate = computeBusinessDate(
    occurredAt,
    request.timezone ?? 'Asia/Kolkata',
    request.businessDayStartHour ?? 0,
  )

  return db.transaction(() => {
    const saleNumber = drawInvoiceNumber(db)
    const wentNegative: string[] = []

    db.run(
      `INSERT INTO sale (
         id, sale_number, customer_id, status, subtotal_paise, line_discount_paise,
         bill_discount_paise, rounding_adjustment_paise, total_paise, paid_paise, credit_paise,
         business_date, occurred_at, sync_state
       ) VALUES (?, ?, ?, 'COMPLETED', ?, ?, ?, ?, ?, ?, ?, ?, ?, 'pending')`,
      [
        request.saleId,
        saleNumber,
        request.customerId ?? null,
        totals.subtotalPaise,
        totals.lineDiscountPaise,
        totals.billDiscountPaise,
        totals.roundingAdjustmentPaise,
        totals.totalPaise,
        paidPaise,
        credit,
        businessDate,
        occurredAt.getTime(),
      ],
    )

    request.lines.forEach((line, index) => {
      const [product] = db.all<{ name_en: string | null; name_hi: string | null; unit_code: string }>(
        'SELECT name_en, name_hi, unit_code FROM product WHERE id = ?',
        [line.productId],
      )
      if (!product) {
        throw new OfflineSaleError('UNKNOWN_PRODUCT', `Product ${line.productId} is not on this device`)
      }

      const gross = Math.round((line.unitPricePaise * line.qtyMilli) / 1000)
      db.run(
        `INSERT INTO sale_item (
           id, sale_id, product_id, product_name_snapshot, unit_snapshot,
           qty_milli, unit_price_paise, discount_paise, line_total_paise, sort_order
         ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        [
          newId(),
          request.saleId,
          line.productId,
          product.name_en ?? product.name_hi ?? 'Unknown',
          product.unit_code,
          line.qtyMilli,
          line.unitPricePaise,
          line.discountPaise ?? 0,
          gross - (line.discountPaise ?? 0),
          index,
        ],
      )

      /*
       * Decrement the local stock optimistically.
       *
       * The server owns this number and will overwrite it on the next pull (§14.7) — but the
       * shopkeeper is looking at the shelf now, and a stock figure that does not move until the
       * phone reconnects is worse than one that is briefly optimistic.
       *
       * Negative is allowed and recorded, exactly as on the server (§17.3, §14.8): the goods
       * left, and refusing the sale to protect a count would destroy the financial record.
       */
      db.run(
        `INSERT INTO inventory_balance (product_id, qty_milli) VALUES (?, ?)
         ON CONFLICT(product_id) DO UPDATE SET qty_milli = qty_milli - ?`,
        [line.productId, -line.qtyMilli, line.qtyMilli],
      )

      const [balance] = db.all<{ qty_milli: number }>(
        'SELECT qty_milli FROM inventory_balance WHERE product_id = ?',
        [line.productId],
      )
      if ((balance?.qty_milli ?? 0) < 0) wentNegative.push(line.productId)
    })

    for (const payment of request.payments ?? []) {
      db.run(
        `INSERT INTO payment (id, sale_id, customer_id, direction, method, amount_paise, reference, occurred_at, sync_state)
         VALUES (?, ?, ?, 'IN', ?, ?, ?, ?, 'pending')`,
        [
          newId(),
          request.saleId,
          request.customerId ?? null,
          payment.method,
          payment.amountPaise,
          payment.reference ?? null,
          occurredAt.getTime(),
        ],
      )
    }

    // The customer's balance moves locally too, so the khata screen is right immediately. Also
    // pull-only and overwritten by the server; also better than a stale number on screen.
    if (credit > 0 && request.customerId) {
      db.run(
        `INSERT INTO customer_balance (customer_id, outstanding_paise, last_activity_at) VALUES (?, ?, ?)
         ON CONFLICT(customer_id) DO UPDATE SET
           outstanding_paise = outstanding_paise + ?, last_activity_at = ?`,
        [request.customerId, credit, occurredAt.getTime(), credit, occurredAt.getTime()],
      )
    }

    /*
     * The outbox row, in this same transaction. The whole design rests on this line.
     *
     * The payload is exactly what `POST /v1/sales` accepts, so the server applies a queued sale
     * through the identical code path as an online one (§14.4 step 4).
     */
    enqueue(db, {
      opId: request.opId,
      entity: 'sale',
      entityId: request.saleId,
      opType: 'create',
      payload: {
        saleNumber,
        customerId: request.customerId,
        items: request.lines.map((line) => ({
          productId: line.productId,
          qtyMilli: line.qtyMilli,
          unitPricePaise: line.unitPricePaise,
          discountPaise: line.discountPaise,
        })),
        payments: request.payments,
        billDiscountPaise: request.billDiscountPaise,
        occurredAt: occurredAt.toISOString(),
        source: 'MOBILE',
      },
      now: occurredAt.getTime(),
    })

    return {
      saleId: request.saleId,
      saleNumber,
      totalPaise: totals.totalPaise,
      paidPaise,
      creditPaise: credit,
      businessDate,
      wentNegative,
    }
  })
}

/** Today's takings, computed on-device so the home screen works with no signal. */
export function todayTotals(db: SqliteDatabase, businessDate: string) {
  const [row] = db.all<{
    sales: number
    total_paise: number | null
    credit_paise: number | null
  }>(
    `SELECT count(*) AS sales, sum(total_paise) AS total_paise, sum(credit_paise) AS credit_paise
     FROM sale WHERE business_date = ? AND status = 'COMPLETED'`,
    [businessDate],
  )

  const [cash] = db.all<{ cash_paise: number | null }>(
    `SELECT sum(p.amount_paise) AS cash_paise
     FROM payment p JOIN sale s ON s.id = p.sale_id
     WHERE s.business_date = ? AND p.direction = 'IN' AND p.method = 'CASH'`,
    [businessDate],
  )

  return {
    saleCount: row?.sales ?? 0,
    totalPaise: row?.total_paise ?? 0,
    creditPaise: row?.credit_paise ?? 0,
    cashPaise: cash?.cash_paise ?? 0,
  }
}
