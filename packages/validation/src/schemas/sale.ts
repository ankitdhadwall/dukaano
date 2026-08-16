import { z } from 'zod'
import { PAYMENT_METHODS, type PaymentMethod } from '@dukaano/types'

/**
 * Billing schemas (blueprint §19).
 *
 * The rule that shapes this whole file, and the one most likely to be undone by a well-meaning
 * change: **udhaar is not a payment method.** It is a selection in the UI that produces a customer
 * ledger entry, and it never produces a `payment` row. Adding `'UDHAAR'` to `PAYMENT_METHODS` is
 * the single most likely way to reintroduce the double-counting bug the design exists to prevent
 * — credit counted as revenue, a shop's day looking twice as good as it was.
 *
 * On the wire, credit is simply what is left over: `total − Σ payments`. It is never sent.
 */

const paise = (field: string) =>
  z
    .number({ required_error: `errors.${field}.required`, invalid_type_error: `errors.${field}.invalid` })
    .int(`errors.${field}.invalid`)
    .min(0, `errors.${field}.negative`)
    .max(Number.MAX_SAFE_INTEGER)

const milli = z.number().int('errors.quantity.invalid').max(Number.MAX_SAFE_INTEGER)

export const paymentMethodSchema = z.enum(
  PAYMENT_METHODS as unknown as [PaymentMethod, ...PaymentMethod[]],
  { errorMap: () => ({ message: 'errors.payment.invalidMethod' }) },
)

/**
 * One cart line.
 *
 * `unitPricePaise` is sent by the client rather than looked up server-side, and that is
 * deliberate (§25 E-4): **the cart price wins.** The customer was quoted it. If the owner changed
 * the shelf price while the item sat in the cart, the change applies to the *next* sale — silently
 * re-pricing a bill the customer already agreed to is how a shop loses an argument at the counter.
 */
export const saleItemSchema = z.object({
  productId: z.string().uuid('errors.product.invalidId'),
  qtyMilli: milli.refine((v) => v > 0, { message: 'errors.sale.quantityRequired' }),
  unitPricePaise: paise('price'),
  discountPaise: paise('price').optional(),
})
export type SaleItemInput = z.infer<typeof saleItemSchema>

/**
 * One tender against the bill. Zero of these means the whole bill is udhaar.
 *
 * A split payment is simply more than one of these — "₹600 UPI, ₹400 udhaar" is one entry here
 * plus a credit remainder, and "₹600 cash, ₹400 card" is two entries with no remainder.
 */
export const salePaymentSchema = z.object({
  method: paymentMethodSchema,
  amountPaise: paise('amount').refine((v) => v > 0, { message: 'errors.payment.amountRequired' }),
  /** Optional UPI reference — never mandatory (§10 J5). */
  reference: z.string().trim().max(60).optional(),
})
export type SalePaymentInput = z.infer<typeof salePaymentSchema>

export const createSaleSchema = z
  .object({
    /** Client-generated UUIDv7 so an offline sale keeps its identity through sync (§14.3). */
    id: z.string().uuid().optional(),
    /**
     * The idempotency key that makes a double-tapped submit safe (§25 E-5).
     *
     * The button is disabled on first press *and* the request carries this, because the button is
     * a UI courtesy and this is the guarantee. A retried submit returns the first result rather
     * than billing the customer twice.
     */
    opId: z.string().uuid('errors.sync.invalidOpId').optional(),
    customerId: z.string().uuid('errors.customer.invalidId').optional(),
    items: z.array(saleItemSchema).min(1, 'errors.sale.emptyCart').max(200),
    billDiscountPaise: paise('price').optional(),
    payments: z.array(salePaymentSchema).max(5).optional(),
    /** Drawn from the device's number lease so the printed number is final offline (§14.6). */
    saleNumber: z.string().trim().min(1).max(30).optional(),
    /** Business time. May be backdated for an offline sale; the server decides the business date. */
    occurredAt: z.coerce.date().optional(),
    notes: z.string().trim().max(500).optional(),
    source: z.enum(['MOBILE', 'WEB']).optional(),
    /**
     * Acknowledges an over-limit warning (§25 E-34). Never a hard block — a shopkeeper who decides
     * to extend more credit to a regular knows something the credit limit does not.
     */
    overrideCreditLimit: z.boolean().optional(),
  })
  /*
   * A bill that is not fully paid is credit, and credit needs someone to owe it. Checked here so
   * the shopkeeper gets "choose a customer to record udhaar" rather than a database constraint
   * error — the CHECK constraint behind it is the backstop, not the message.
   */
  .refine(
    (sale) => {
      const paid = (sale.payments ?? []).reduce((sum, p) => sum + p.amountPaise, 0)
      const gross = sale.items.reduce(
        (sum, item) => sum + item.unitPricePaise * (item.qtyMilli / 1000) - (item.discountPaise ?? 0),
        0,
      )
      // Approximate on purpose: the server recomputes the exact total in integer arithmetic. This
      // only catches the obvious "no customer and clearly not paid in full" case early.
      return paid >= gross - (sale.billDiscountPaise ?? 0) - 1 || sale.customerId !== undefined
    },
    { message: 'errors.sale.customerRequiredForCredit', path: ['customerId'] },
  )
export type CreateSaleInput = z.infer<typeof createSaleSchema>

export const cancelSaleSchema = z.object({
  /** Mandatory. A cancelled bill is a question someone will ask about later (§25 E-12). */
  reason: z.string().trim().min(1, 'errors.sale.cancelReasonRequired').max(200),
})
export type CancelSaleInput = z.infer<typeof cancelSaleSchema>

/**
 * A khata collection — money received against a customer's outstanding balance, not against one
 * bill. Allocated across open bills oldest-first (§18.4).
 */
export const recordPaymentSchema = z.object({
  id: z.string().uuid().optional(),
  opId: z.string().uuid('errors.sync.invalidOpId').optional(),
  customerId: z.string().uuid('errors.customer.invalidId'),
  method: paymentMethodSchema,
  amountPaise: paise('amount').refine((v) => v > 0, { message: 'errors.payment.amountRequired' }),
  reference: z.string().trim().max(60).optional(),
  note: z.string().trim().max(500).optional(),
  occurredAt: z.coerce.date().optional(),
  /**
   * Override the FIFO allocation. Web only — the mobile flow always allocates oldest-first,
   * because choosing bills on a phone during a counter transaction is not a real workflow.
   */
  allocations: z
    .array(z.object({ saleId: z.string().uuid(), amountPaise: paise('amount') }))
    .max(50)
    .optional(),
})
export type RecordPaymentInput = z.infer<typeof recordPaymentSchema>

export const reversePaymentSchema = z.object({
  /** Required: a reversal is a correction, and a correction without a reason is unexplainable. */
  reason: z.string().trim().min(1, 'errors.payment.reversalReasonRequired').max(200),
})
export type ReversePaymentInput = z.infer<typeof reversePaymentSchema>

/**
 * A return (§25 E-11, E-39).
 *
 * `refundCashPaise` is what the shopkeeper hands back in money. The rest reverses credit. The
 * server enforces that cash refunded never exceeds what was actually paid on the bill — refunding
 * cash against a purchase that was mostly udhaar would hand over money the shop never received.
 */
export const createReturnSchema = z.object({
  id: z.string().uuid().optional(),
  opId: z.string().uuid('errors.sync.invalidOpId').optional(),
  items: z
    .array(
      z.object({
        saleItemId: z.string().uuid('errors.sale.invalidItemId'),
        qtyMilli: milli.refine((v) => v > 0, { message: 'errors.sale.quantityRequired' }),
      }),
    )
    .min(1, 'errors.sale.emptyReturn')
    .max(200),
  refundCashPaise: paise('amount').optional(),
  reason: z.string().trim().max(200).optional(),
  occurredAt: z.coerce.date().optional(),
})
export type CreateReturnInput = z.infer<typeof createReturnSchema>

/** A manual khata correction. Owner-only, reason required, permanently visible (§18.2). */
export const ledgerAdjustmentSchema = z.object({
  customerId: z.string().uuid('errors.customer.invalidId'),
  entryType: z.enum(['ADJUSTMENT_DEBIT', 'ADJUSTMENT_CREDIT', 'WRITE_OFF'], {
    errorMap: () => ({ message: 'errors.khata.invalidAdjustment' }),
  }),
  magnitudePaise: paise('amount').refine((v) => v > 0, { message: 'errors.payment.amountRequired' }),
  reason: z.string().trim().min(1, 'errors.khata.reasonRequired').max(200),
  note: z.string().trim().max(500).optional(),
})
export type LedgerAdjustmentInput = z.infer<typeof ledgerAdjustmentSchema>

// --- customers ---------------------------------------------------------------------------------

/**
 * A customer.
 *
 * Only the name is required. A khata regular is often known by face and first name, and demanding
 * a phone number before the shopkeeper can record what someone owes would push them straight back
 * to the paper notebook — which is the competitor that actually matters.
 */
export const createCustomerSchema = z.object({
  id: z.string().uuid().optional(),
  clientUpdatedAt: z.coerce.date().optional(),
  name: z.string().trim().min(1, 'errors.customer.nameRequired').max(80),
  phone: z.string().trim().max(20).optional().nullable(),
  address: z.string().trim().max(200).optional(),
  notes: z.string().trim().max(500).optional(),
  /** A warning threshold, never a hard block (§25 E-34). */
  creditLimitPaise: paise('amount').optional().nullable(),
  /** Migrating a paper khata. Written as an OPENING_BALANCE ledger entry, never a bare balance. */
  openingBalancePaise: paise('amount').optional(),
})
export type CreateCustomerInput = z.infer<typeof createCustomerSchema>

export const updateCustomerSchema = z.object({
  clientUpdatedAt: z.coerce.date().optional(),
  name: z.string().trim().min(1, 'errors.customer.nameRequired').max(80).optional(),
  phone: z.string().trim().max(20).optional().nullable(),
  address: z.string().trim().max(200).optional(),
  notes: z.string().trim().max(500).optional(),
  creditLimitPaise: paise('amount').optional().nullable(),
})
export type UpdateCustomerInput = z.infer<typeof updateCustomerSchema>
