import { Injectable, Logger } from '@nestjs/common'
import { randomUUID } from 'node:crypto'
import {
  asMilli,
  asPaise,
  computeBillTotals,
  creditPortion,
  type RoundingPolicy,
} from '@dukaano/money'
import { computeBusinessDate } from '@dukaano/business-logic'
import type { CancelSaleInput, CreateSaleInput } from '@dukaano/validation'
import { BusinessRuleError, NotFoundError } from '../../common/errors/domain-error'
import { currentContext, tenantClient } from '../../common/prisma/tenant-context'
import { ChangeLogService } from '../sync/change-log.service'
import { InventoryService } from '../inventory/inventory.service'
import { LedgerService } from '../khata/ledger.service'

/**
 * The sale transaction (blueprint §19.2) — the heart of the product.
 *
 * A completed sale writes **nine row groups in one database transaction**:
 *
 *   1. `sale`                     5. `customer_ledger_entry` (credit portion)
 *   2. `sale_item` × N            6. `inventory_transaction` × N
 *   3. `payment` × M              7. `inventory_balance` × N
 *   4. `payment_allocation` × M   8. `change_log` × K
 *                                 9. `message` (Phase 6 — queued, not sent)
 *
 * Either the whole sale exists or none of it does. There is no state in which stock left but the
 * bill did not, or a customer owes money for a sale nobody can find.
 *
 * Atomicity is free here rather than hand-rolled: the request already runs inside one tenant
 * transaction (`TenantTransactionInterceptor`), so every write below joins it and a throw anywhere
 * rolls all of it back before the exception filter is reached.
 *
 * The identity this class exists to preserve, asserted on every persisted sale (§19.1):
 *
 *     total_paise = Σ payment(IN).amount_paise + credit_paise
 */
@Injectable()
export class SalesService {
  private readonly logger = new Logger(SalesService.name)

  constructor(
    private readonly inventory: InventoryService,
    private readonly ledger: LedgerService,
    private readonly changeLog: ChangeLogService,
  ) {}

  async create(shopId: string, input: CreateSaleInput) {
    const context = currentContext()
    const userId = context?.userId ?? null
    if (!userId) throw new Error('A sale requires an authenticated user')

    const tx = tenantClient()
    const saleId = input.id ?? randomUUID()

    // A sale created offline arrives with the id it already has on the device. If it is already
    // here, the first attempt succeeded and its response was lost — return that, do not bill again.
    const existing = await tx.sale.findFirst({ where: { id: saleId, shopId }, select: { id: true } })
    if (existing) return this.findById(shopId, saleId)

    const settings = await tx.shopSettings.findUnique({
      where: { shopId },
      select: { roundingPolicy: true, businessDayStartHour: true, negativeStockPolicy: true },
    })
    const shop = await tx.shop.findFirst({ where: { id: shopId }, select: { timezone: true } })

    const products = await this.loadProducts(shopId, input.items.map((item) => item.productId))

    // ── Bill arithmetic. One implementation, in @dukaano/money, shared with the client. ──────
    const totals = computeBillTotals(
      input.items.map((item) => ({
        unitPricePaise: asPaise(item.unitPricePaise),
        qtyMilli: asMilli(item.qtyMilli),
        discountPaise: asPaise(item.discountPaise ?? 0),
      })),
      asPaise(input.billDiscountPaise ?? 0),
      (settings?.roundingPolicy ?? 'NONE') as RoundingPolicy,
    )

    const paidPaise = (input.payments ?? []).reduce((sum, p) => sum + p.amountPaise, 0)
    const credit = creditPortion(totals.totalPaise, asPaise(paidPaise))

    if (credit < 0) {
      /*
       * Overpayment on a bill is not an advance — it is a mistake at the counter.
       *
       * An advance is money handed over against *future* purchases and is recorded as a khata
       * collection, where it becomes a negative balance. Tendering ₹500 on a ₹300 bill means the
       * shopkeeper owes ₹200 in change from the drawer, which is not a thing the system records.
       * Accepting it here would silently invent revenue the shop never kept.
       */
      throw new BusinessRuleError(
        'OVERPAYMENT',
        'errors.sale.overpaid',
        { total: totals.totalPaise, paid: paidPaise },
        'Payments exceed the bill total; record the excess as a khata advance instead',
      )
    }

    if (credit > 0 && !input.customerId) {
      throw new BusinessRuleError('CUSTOMER_REQUIRED', 'errors.sale.customerRequiredForCredit')
    }

    let creditLimitWarning: { limitPaise: number; wouldBePaise: number } | undefined
    if (credit > 0 && input.customerId) {
      creditLimitWarning = await this.checkCreditLimit(shopId, input.customerId, credit, input)
    }

    const occurredAt = input.occurredAt ?? new Date()
    // Stored, never re-derived by a report: re-deriving would let a timezone change rewrite
    // history (§25 E-19, E-20).
    const businessDate = computeBusinessDate(
      occurredAt,
      shop?.timezone ?? 'Asia/Kolkata',
      settings?.businessDayStartHour ?? 0,
    )

    const saleNumber = input.saleNumber ?? (await this.nextSaleNumber(shopId))

    // ── 1. sale ───────────────────────────────────────────────────────────────────────────────
    await tx.sale.create({
      data: {
        id: saleId,
        shopId,
        saleNumber,
        customerId: input.customerId ?? null,
        status: 'COMPLETED',
        subtotalPaise: BigInt(totals.subtotalPaise),
        lineDiscountPaise: BigInt(totals.lineDiscountPaise),
        billDiscountPaise: BigInt(totals.billDiscountPaise),
        roundingAdjustmentPaise: BigInt(totals.roundingAdjustmentPaise),
        totalPaise: BigInt(totals.totalPaise),
        paidPaise: BigInt(paidPaise),
        creditPaise: BigInt(credit),
        businessDate: new Date(`${businessDate}T00:00:00.000Z`),
        occurredAt,
        source: input.source ?? 'MOBILE',
        notes: input.notes ?? null,
        createdByUserId: userId,
        deviceId: context?.deviceId ?? null,
        opId: input.opId ?? null,
      },
    })

    // ── 2. sale_item × N ──────────────────────────────────────────────────────────────────────
    const itemRows = input.items.map((item, index) => {
      // `loadProducts` threw for anything missing, so this is always present — read rather than
      // asserted so a future change to that method cannot turn a wrong assumption into a bill line
      // with an undefined product name.
      const product = products.get(item.productId)
      if (!product) throw new NotFoundError('Product', item.productId)
      const gross = (BigInt(item.unitPricePaise) * BigInt(item.qtyMilli) + 500n) / 1000n
      return {
        id: randomUUID(),
        shopId,
        saleId,
        productId: item.productId,
        // Snapshots, so an archived or renamed product still renders this bill correctly years
        // later (§25 E-9). The bill in the customer's hand never changes; neither does ours.
        productNameSnapshot: product.nameEn ?? product.nameHi ?? 'Unknown',
        unitSnapshot: product.unitCode,
        qtyMilli: BigInt(item.qtyMilli),
        unitPricePaise: BigInt(item.unitPricePaise),
        discountPaise: BigInt(item.discountPaise ?? 0),
        lineTotalPaise: gross - BigInt(item.discountPaise ?? 0),
        // Captured now even though the profit report is Phase 8: cost at the moment of sale is
        // unrecoverable retroactively once the moving average moves (§4.1).
        costPaiseSnapshot: product.avgCostPaise,
        sortOrder: index,
      }
    })
    await tx.saleItem.createMany({ data: itemRows })

    // ── 3 & 4. payment × M and payment_allocation × M ─────────────────────────────────────────
    const paymentIds: string[] = []
    for (const payment of input.payments ?? []) {
      const paymentId = randomUUID()
      paymentIds.push(paymentId)

      await tx.payment.create({
        data: {
          id: paymentId,
          shopId,
          customerId: input.customerId ?? null,
          saleId,
          direction: 'IN',
          method: payment.method,
          amountPaise: BigInt(payment.amountPaise),
          reference: payment.reference ?? null,
          businessDate: new Date(`${businessDate}T00:00:00.000Z`),
          occurredAt,
          createdByUserId: userId,
          deviceId: context?.deviceId ?? null,
        },
      })

      // The allocation is trivial for a sale payment — it clears this bill and no other — but it
      // is written anyway, so "which bills did this payment touch?" has one answer shape whether
      // the money came in at the counter or as a khata collection later.
      await tx.paymentAllocation.create({
        data: {
          id: randomUUID(),
          shopId,
          paymentId,
          saleId,
          amountPaise: BigInt(payment.amountPaise),
        },
      })
    }

    // ── 5. customer_ledger_entry (credit portion only) ────────────────────────────────────────
    //
    // §19.1, binding: udhaar produces a ledger entry and NEVER a payment row. This is the line
    // that keeps credit out of revenue.
    if (credit > 0 && input.customerId) {
      await this.ledger.append({
        customerId: input.customerId,
        entryType: 'SALE_CREDIT',
        magnitudePaise: credit,
        refType: 'SALE',
        refId: saleId,
        occurredAt,
      })
    }

    // ── 6 & 7. inventory_transaction × N and inventory_balance × N ────────────────────────────
    //
    // Through InventoryService, the single writer of stock, which locks each balance row in
    // deterministic product-id order so two concurrent multi-line sales cannot deadlock.
    const movements = await this.inventory.applyMovements(
      input.items.map((item) => ({
        productId: item.productId,
        type: 'SALE' as const,
        qtyDeltaMilli: -item.qtyMilli,
        refType: 'SALE',
        refId: saleId,
        occurredAt,
      })),
    )

    const droveStockNegative = movements.some((movement) => movement.wentNegative)
    if (droveStockNegative) {
      /*
       * §14.8 / §17.3: the sale is accepted and the stock goes negative.
       *
       * Three kilos of sugar physically left the shop and the money physically entered the till.
       * Refusing the sale would destroy financial truth to protect a stock number — and the goods
       * are gone either way. The shopkeeper is prompted to correct the count, never blocked.
       */
      await tx.sale.update({ where: { id: saleId }, data: { droveStockNegative: true } })
      this.logger.warn(`Sale ${saleNumber} drove stock negative in shop ${shopId}`)
    }

    // ── 8. change_log × K ─────────────────────────────────────────────────────────────────────
    //
    // Inventory and ledger rows logged themselves inside their own services. What is left is the
    // sale document and its payments.
    await this.changeLog.recordMany([
      { entity: 'sale', entityId: saleId, op: 'upsert', rowVersion: 1 },
      ...paymentIds.map((id) => ({ entity: 'payment' as const, entityId: id, op: 'upsert' as const, rowVersion: 1 })),
    ])

    // ── 9. message — Phase 6. The outbox row is queued (committed, not sent) in this same
    //       transaction, so a receipt can never be sent for a sale that rolled back.
    //       Not built yet; recorded here so the gap is visible rather than forgotten.

    const sale = await this.findById(shopId, saleId)
    return creditLimitWarning ? { ...sale, creditLimitWarning } : sale
  }

  /**
   * Cancel a sale (§25 E-12).
   *
   * Never a delete. The bill exists, the customer may hold a printed copy, and a sale that
   * vanishes from the day's takings with no trace is indistinguishable from theft. Cancelling
   * appends compensating rows and leaves the original visible, marked cancelled:
   *
   *   • stock returns via `CANCEL` inventory transactions
   *   • credit is reversed with a `SALE_CANCELLED` ledger entry
   *   • cash actually taken is returned with a `payment(OUT)` row
   */
  async cancel(shopId: string, saleId: string, input: CancelSaleInput) {
    const context = currentContext()
    const tx = tenantClient()

    const sale = await tx.sale.findFirst({
      where: { id: saleId, shopId },
      include: { items: true, payments: { where: { direction: 'IN', reversalOfPaymentId: null } } },
    })
    if (!sale) throw new NotFoundError('Sale', saleId)

    if (sale.status === 'CANCELLED') {
      // Idempotent rather than an error: a double-tapped cancel, or a retried offline op, must not
      // return stock twice.
      return this.findById(shopId, saleId)
    }

    const returned = await tx.saleReturn.count({ where: { shopId, saleId } })
    if (returned > 0) {
      throw new BusinessRuleError(
        'SALE_HAS_RETURNS',
        'errors.sale.hasReturns',
        {},
        'This sale has returns against it; cancel those first or use a return instead',
      )
    }

    await tx.sale.update({
      where: { id: saleId },
      data: {
        status: 'CANCELLED',
        cancelledAt: new Date(),
        cancelledByUserId: context?.userId ?? null,
        cancelReason: input.reason,
        rowVersion: { increment: 1n },
      },
    })

    // Stock back on the shelf.
    await this.inventory.applyMovements(
      sale.items.map((item) => ({
        productId: item.productId,
        type: 'SALE_CANCEL' as const,
        qtyDeltaMilli: Number(item.qtyMilli),
        refType: 'SALE',
        refId: saleId,
        reason: input.reason,
      })),
    )

    // Credit reversed.
    if (sale.creditPaise > 0n && sale.customerId) {
      await this.ledger.append({
        customerId: sale.customerId,
        entryType: 'SALE_CANCELLED',
        magnitudePaise: Number(sale.creditPaise),
        refType: 'SALE',
        refId: saleId,
        reason: input.reason,
      })
    }

    // Cash actually taken, returned. Bounded by what was paid, which is the whole point: a bill
    // that was mostly udhaar refunds only the part that was really handed over.
    const paymentIds: string[] = []
    for (const payment of sale.payments) {
      const refundId = randomUUID()
      paymentIds.push(refundId)
      await tx.payment.create({
        data: {
          id: refundId,
          shopId,
          customerId: sale.customerId,
          saleId,
          direction: 'OUT',
          method: payment.method,
          amountPaise: payment.amountPaise,
          note: `Cancellation of ${sale.saleNumber}: ${input.reason}`,
          businessDate: sale.businessDate,
          occurredAt: new Date(),
          createdByUserId: context?.userId ?? '',
          reversalOfPaymentId: payment.id,
        },
      })
      await tx.payment.update({
        where: { id: payment.id },
        data: { reversedByPaymentId: refundId },
      })
    }

    /*
     * `paid_paise` and `credit_paise` are deliberately left alone.
     *
     * The first version zeroed them, which felt tidy and was wrong twice over. The CHECK
     * constraint `paid + credit = total` refused it outright — and it was right to: those columns
     * describe **the bill as issued**, and the customer may be holding a printed copy of exactly
     * that. Erasing them would make the document disagree with the paper.
     *
     * The cancellation is expressed entirely by the compensating rows written above — stock back
     * in, credit reversed, cash returned — plus the status. Nothing is rewritten.
     */
    await this.changeLog.recordMany([
      { entity: 'sale', entityId: saleId, op: 'upsert', rowVersion: 2 },
      ...paymentIds.map((id) => ({ entity: 'payment' as const, entityId: id, op: 'upsert' as const, rowVersion: 1 })),
    ])

    return this.findById(shopId, saleId)
  }

  async findById(shopId: string, id: string) {
    const sale = await tenantClient().sale.findFirst({
      where: { id, shopId },
      include: {
        items: { orderBy: { sortOrder: 'asc' } },
        payments: { orderBy: { createdAt: 'asc' } },
        customer: { select: { id: true, name: true, phoneE164: true } },
      },
    })
    if (!sale) throw new NotFoundError('Sale', id)
    return sale
  }

  async list(
    shopId: string,
    filters: { from?: Date; to?: Date; customerId?: string; status?: string; limit?: number },
  ) {
    return tenantClient().sale.findMany({
      where: {
        shopId,
        ...(filters.customerId ? { customerId: filters.customerId } : {}),
        ...(filters.status ? { status: filters.status } : {}),
        ...(filters.from || filters.to
          ? {
              businessDate: {
                ...(filters.from ? { gte: filters.from } : {}),
                ...(filters.to ? { lte: filters.to } : {}),
              },
            }
          : {}),
      },
      orderBy: [{ businessDate: 'desc' }, { occurredAt: 'desc' }],
      take: Math.min(filters.limit ?? 50, 200),
      select: {
        id: true, saleNumber: true, status: true, totalPaise: true, paidPaise: true,
        creditPaise: true, businessDate: true, occurredAt: true, droveStockNegative: true,
        customer: { select: { id: true, name: true } },
      },
    })
  }

  // --- internals ---------------------------------------------------------------------------------

  private async loadProducts(shopId: string, productIds: readonly string[]) {
    const unique = [...new Set(productIds)]
    const rows = await tenantClient().product.findMany({
      where: { id: { in: unique }, shopId },
      select: {
        id: true, nameEn: true, nameHi: true, unitCode: true,
        balance: { select: { avgCostPaise: true } },
      },
    })

    const found = new Map(
      rows.map((row) => [
        row.id,
        {
          nameEn: row.nameEn,
          nameHi: row.nameHi,
          unitCode: row.unitCode,
          avgCostPaise: row.balance?.avgCostPaise ?? null,
        },
      ]),
    )

    const missing = unique.filter((id) => !found.has(id))
    if (missing.length > 0) throw new NotFoundError('Product', missing[0])

    return found
  }

  /**
   * Warn — never block — when a sale takes a customer past their credit limit (§25 E-34).
   *
   * The limit is a note the shopkeeper wrote to themselves, not a rule the system should enforce
   * against them. They know that this customer's salary lands on the 5th and the neighbour with a
   * lower limit has been slow twice. Blocking the sale would send them to the paper notebook,
   * which is the outcome that actually loses the shop.
   *
   * Without an explicit override the request is refused, so the warning is *seen*; the retry with
   * `overrideCreditLimit` is what makes it a decision rather than a shrug.
   */
  private async checkCreditLimit(
    shopId: string,
    customerId: string,
    creditPaise: number,
    input: CreateSaleInput,
  ) {
    const customer = await tenantClient().customer.findFirst({
      where: { id: customerId, shopId },
      select: { creditLimitPaise: true, balance: { select: { outstandingPaise: true } } },
    })
    if (!customer?.creditLimitPaise) return undefined

    const limit = Number(customer.creditLimitPaise)
    const wouldBe = Number(customer.balance?.outstandingPaise ?? 0n) + creditPaise
    if (wouldBe <= limit) return undefined

    if (!input.overrideCreditLimit) {
      throw new BusinessRuleError('CREDIT_LIMIT_EXCEEDED', 'errors.sale.creditLimitExceeded', {
        limit,
        wouldBe,
      })
    }

    // Overridden. The audit interceptor records who did it; this is what makes the override a
    // decision with a name on it rather than a silently ignored limit.
    this.logger.warn(
      `Credit limit overridden for customer ${customerId} in shop ${shopId}: ` +
        `${wouldBe} would exceed limit ${limit}`,
    )
    return { limitPaise: limit, wouldBePaise: wouldBe }
  }

  /**
   * A server-assigned bill number, for sales created online.
   *
   * Offline sales carry a number drawn from the device's lease (§14.6) and never reach this. The
   * two schemes coexist because they must: a receipt printed offline needs its final number
   * immediately, and a web sale has no device lease to draw from.
   */
  private async nextSaleNumber(shopId: string): Promise<string> {
    // Advisory lock rather than max()+1 alone: two concurrent sales would otherwise read the same
    // maximum and collide on the (shop_id, sale_number) unique index.
    await tenantClient().$executeRaw`
      SELECT pg_advisory_xact_lock(hashtextextended(${`${shopId}:sale-number`}, 0))
    `

    const [row] = await tenantClient().$queryRaw<{ max_number: number | null }[]>`
      SELECT max(nullif(regexp_replace(sale_number, '\\D', '', 'g'), '')::bigint) AS max_number
      FROM sale
      WHERE shop_id = ${shopId}::uuid AND sale_number LIKE 'INV-%'
    `

    return `INV-${String(Number(row?.max_number ?? 0) + 1).padStart(4, '0')}`
  }
}
